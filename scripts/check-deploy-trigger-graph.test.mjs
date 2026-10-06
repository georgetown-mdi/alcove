import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_COMMAND,
  BUILD_OUTPUT,
  DEPLOY_WORKFLOW,
  RECORDER_MODULE,
  RECORD_ENV,
  REQUIRED_GRAPH_ROOTS,
  classifyGraph,
  collectGraph,
  compileFilter,
  moduleIdToPath,
  readTriggerPaths,
  toRepoPath,
  trackedFiles,
  unreachedRoots,
} from "./check-deploy-trigger-graph.mjs";
import {
  PATH_SCOPE_ACTION,
  parseWorkflow,
  pathScope,
  readWorkflows,
  usesNodes,
  workflowDocument,
} from "./lib/workflows.mjs";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const readRepo = (path) => readFileSync(resolve(repoRoot, path), "utf8");
const GATE_WORKFLOW = ".github/workflows/eb_build_and_test.yaml";
const gateScope = () =>
  pathScope(workflowDocument(repoRoot, GATE_WORKFLOW), GATE_WORKFLOW);

const scratchDirs = [];
function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "deploy-graph-test-"));
  scratchDirs.push(root);
  return root;
}
function writeFile(root, path, contents) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return absolute;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

describe("reading the deploy trigger", () => {
  // Reads the real workflow, so dropping the push path filter -- or restructuring
  // the trigger out from under the check -- fails here rather than at the next
  // build-driven run.
  it("reads the push path filter out of the real deploy workflow", () => {
    const paths = readTriggerPaths(workflowDocument(repoRoot, DEPLOY_WORKFLOW));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toEqual(
      workflowDocument(repoRoot, DEPLOY_WORKFLOW).on.push.paths,
    );
  });

  it("throws when the push trigger has no paths list", () => {
    expect(() =>
      readTriggerPaths(
        parseWorkflow("fixture.yaml", "on:\n  push:\n    branches: [main]\n"),
      ),
    ).toThrow(/declares no on.push.paths/);
  });
});

describe("compiling a path filter", () => {
  // The fail-closed half of the check: every pattern in the shipped filter is a
  // shape the matcher reads, so a pattern added in a shape it cannot model stops
  // the change instead of silently mismatching.
  it("compiles every pattern the real deploy workflow declares", () => {
    const filter = compileFilter(
      readTriggerPaths(workflowDocument(repoRoot, DEPLOY_WORKFLOW)),
    );
    expect(filter.patterns.length).toBeGreaterThan(0);
  });

  it("matches a literal pattern only as a whole path", () => {
    const filter = compileFilter(["package-lock.json"]);
    expect(filter.matches("package-lock.json")).toBe(true);
    expect(filter.matches("apps/web/package-lock.json")).toBe(false);
    expect(filter.matches("package-lock.jsonc")).toBe(false);
  });

  it("matches a trailing /** against paths under the prefix", () => {
    const filter = compileFilter(["apps/web/src/**"]);
    expect(filter.matches("apps/web/src/main.tsx")).toBe(true);
    expect(filter.matches("apps/web/src/psi/deep/nested.ts")).toBe(true);
    expect(filter.matches("apps/web/src")).toBe(false);
    // The prefix is a path segment, not a string prefix.
    expect(filter.matches("apps/web/srcs/main.tsx")).toBe(false);
  });

  it("excludes an extension under a prefix a negated /**/*.ext pattern names", () => {
    const filter = compileFilter(["apps/web/**", "!apps/web/**/*.md"]);
    expect(filter.matches("apps/web/README.md")).toBe(false);
    expect(filter.matches("apps/web/deploy/aws_eb/README.md")).toBe(false);
    expect(filter.matches("apps/web/src/main.tsx")).toBe(true);
    // Unmatched by the earlier positive pattern in the first place.
    expect(filter.matches("packages/core/README.md")).toBe(false);
  });

  // The path-scope action gates with git pathspecs, where an exclusion wins
  // wherever it sits; compileFilter applies GitHub's last-match-wins order. The
  // two agree on a list only while no include follows an exclusion.
  const scopedWorkflows = readWorkflows(repoRoot)
    .map(({ path, source }) => ({
      path,
      document: parseWorkflow(path, source),
    }))
    .filter(({ document }) =>
      usesNodes(document).some((node) => node.uses === PATH_SCOPE_ACTION),
    )
    .map(({ path, document }) => [path, pathScope(document, path)]);

  it("finds the workflows that call the path-scope action", () => {
    expect(scopedWorkflows.map(([path]) => path)).toContain(
      ".github/workflows/eb_build_and_test.yaml",
    );
  });

  it.each(scopedWorkflows)(
    "lists no include after an exclusion in %s's path scope",
    (path, patterns) => {
      const firstExclusion = patterns.findIndex((p) => p.startsWith("!"));
      const lateIncludes =
        firstExclusion === -1
          ? []
          : patterns.slice(firstExclusion).filter((p) => !p.startsWith("!"));
      expect(
        lateIncludes,
        `${path} lists ${lateIncludes.join(", ")} after a "!" exclusion. The path-scope action matches with git pathspecs, where an exclusion removes its matches wherever it is listed, while compileFilter lets a later include re-add them, so the deploy-trigger check would judge a scope the gate does not apply. Move every "!" line after the includes.`,
      ).toEqual([]);
    },
  );

  it("compiles every pattern eb_build_and_test.yaml's path scope declares", () => {
    const filter = compileFilter(gateScope());
    expect(filter.patterns.length).toBeGreaterThan(0);
  });

  it.each(["apps/web/*.ts", "!apps/web/test/**", "apps/*/src/**", "**"])(
    "throws on the unsupported pattern %s",
    (pattern) => {
      expect(() => compileFilter([pattern])).toThrow(
        /glob shape .* does not read/,
      );
    },
  );
});

describe("holding the markdown negation against what the gate reads", () => {
  // eb_build_and_test.yaml's path scope negates markdown under each
  // positive prefix on the claim that no suite this gate runs reads one as a
  // fixture or input. This is that claim as a check: no tracked non-markdown
  // file under a tree the gate builds or tests may name a negated markdown
  // path, so a PR adding such a read and editing only the markdown file could
  // no longer skip the gate silently.
  const gateFilterPaths = gateScope();

  const negatedMarkdownPrefixes = gateFilterPaths
    .map((pattern) => /^!(.+)\/\*\*\/\*\.md$/.exec(pattern)?.[1])
    .filter((prefix) => prefix !== undefined);

  // The cross-runtime suite (matrix.build-cli in eb_build_and_test.yaml) builds
  // apps/cli even though the filter carries no apps/cli entry of its own.
  const builtPrefixes = [
    ...gateFilterPaths
      .filter((pattern) => !pattern.startsWith("!") && pattern.endsWith("/**"))
      .map((pattern) => pattern.slice(0, -"/**".length)),
    "apps/cli",
  ];

  it("declares at least one negated markdown prefix", () => {
    expect(negatedMarkdownPrefixes.length).toBeGreaterThan(0);
  });

  it("is read by no tracked non-markdown source under a tree the gate builds or tests", () => {
    const tracked = trackedFiles(repoRoot);
    const markdownPaths = negatedMarkdownPrefixes.flatMap((prefix) =>
      [...tracked].filter(
        (file) => file.startsWith(`${prefix}/`) && file.endsWith(".md"),
      ),
    );
    expect(markdownPaths.length).toBeGreaterThan(0);

    // git grep over the tracked tree, not a per-file read: a directory-scoped
    // pathspec plus a fixed-string search across every negated markdown path in
    // one process is what keeps this under a second.
    const pathspecs = [
      ...builtPrefixes.map((prefix) => `${prefix}/**`),
      ":!*.md",
    ];
    let offenders = [];
    try {
      const output = execFileSync(
        "git",
        [
          "grep",
          "-n",
          "-F",
          ...markdownPaths.flatMap((path) => ["-e", path]),
          "--",
          ...pathspecs,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      offenders = output.split("\n").filter(Boolean);
    } catch (error) {
      // git grep exits 1 for "no match", which is the passing case here.
      if (error.status !== 1) throw error;
    }
    expect(offenders).toEqual([]);
  });
});

describe("normalizing what a build reports", () => {
  it("strips a query suffix from a module id", () => {
    expect(moduleIdToPath("/repo/apps/web/src/a.worker.ts?worker")).toBe(
      "/repo/apps/web/src/a.worker.ts",
    );
  });

  it.each(["\0virtual:routes", "vite/preload-helper", ""])(
    "reports no file for the module id %j",
    (id) => {
      expect(moduleIdToPath(id)).toBeNull();
    },
  );

  it("keeps a path inside the repository and drops the rest", () => {
    expect(toRepoPath("/repo/apps/web/src/a.ts", "/repo")).toBe(
      "apps/web/src/a.ts",
    );
    expect(toRepoPath("/repo/node_modules/dep/index.js", "/repo")).toBeNull();
    expect(
      toRepoPath("/repo/apps/web/node_modules/dep/index.js", "/repo"),
    ).toBeNull();
    expect(toRepoPath("/elsewhere/a.ts", "/repo")).toBeNull();
  });
});

describe("collecting the graph from a build", () => {
  // Drives collection over a prepared tree with the build injected.
  function prepare(root) {
    writeFile(root, "apps/web/src/a.worker.ts", "");
    writeFile(root, "apps/web/src/main.ts", "");
    writeFile(root, "node_modules/dep/index.js", "");
    writeFile(root, `${BUILD_OUTPUT}/index.html`, "");
  }

  it("keeps the recorded module ids that name repository files", () => {
    const root = scratchRepo();
    prepare(root);
    const graph = collectGraph(root, {
      build: (_root, recordPath) =>
        writeFileSync(
          recordPath,
          JSON.stringify([
            join(root, "apps/web/src/a.worker.ts?worker"),
            join(root, "apps/web/src/main.ts"),
            join(root, "apps/web/src/gone.ts"),
            join(root, "node_modules/dep/index.js"),
            "\0virtual:entry",
          ]),
        ),
    });
    expect(graph).toEqual(["apps/web/src/a.worker.ts", "apps/web/src/main.ts"]);
  });

  it("throws when the build records no module ids", () => {
    const root = scratchRepo();
    prepare(root);
    expect(() => collectGraph(root, { build: () => {} })).toThrow(
      new RegExp(RECORD_ENV),
    );
  });

  it("throws when the build leaves no output directory", () => {
    const root = scratchRepo();
    expect(() =>
      collectGraph(root, {
        build: (_root, recordPath) => writeFileSync(recordPath, "[]"),
      }),
    ).toThrow(new RegExp(BUILD_OUTPUT.replaceAll(".", "\\.")));
  });
});

describe("holding the graph against the filter", () => {
  const filter = compileFilter([
    "apps/web/src/**",
    "packages/peerjs-broker/src/contrib/**",
    "packages/core/src/**",
  ]);
  const tracked = new Set([
    "apps/web/src/peerServer.ts",
    "packages/peerjs-broker/src/contrib/index.ts",
    "packages/peerjs-broker/src/standalone.ts",
    "packages/core/src/main.ts",
  ]);

  it("passes a graph the filter covers", () => {
    expect(
      classifyGraph({
        graph: [
          "apps/web/src/peerServer.ts",
          "packages/peerjs-broker/src/contrib/index.ts",
        ],
        filter,
        tracked,
      }),
    ).toEqual({ uncovered: [], undeclared: [], productGaps: [] });
  });

  // The assumption the deploy filter's broker entry rests on: the local `npm start`
  // entry beside src/contrib is in no deployed import graph. If it ever enters
  // one, edits to it stop triggering a deploy.
  it("reports a tracked source the filter does not match", () => {
    const { uncovered } = classifyGraph({
      graph: [
        "packages/peerjs-broker/src/contrib/index.ts",
        "packages/peerjs-broker/src/standalone.ts",
      ],
      filter,
      tracked,
    });
    expect(uncovered).toEqual(["packages/peerjs-broker/src/standalone.ts"]);
  });

  it("accepts a declared build product in place of its sources", () => {
    expect(
      classifyGraph({
        graph: ["packages/core/dist/core.esm.js"],
        filter,
        tracked,
      }),
    ).toEqual({ uncovered: [], undeclared: [], productGaps: [] });
  });

  // A build product stands in for the tree it is built from, so the filter
  // losing that tree is caught even though its sources never appear in a graph.
  it("reports a build product whose source tree the filter dropped", () => {
    const { productGaps } = classifyGraph({
      graph: ["packages/core/dist/core.esm.js"],
      filter: compileFilter(["apps/web/src/**"]),
      tracked,
    });
    expect(productGaps).toHaveLength(1);
    expect(productGaps[0].missed).toEqual(["packages/core/src/main.ts"]);
  });

  it("reports an untracked graph entry under no declared build product", () => {
    const { undeclared } = classifyGraph({
      graph: ["apps/web/.generated/routes.ts"],
      filter,
      tracked,
    });
    expect(undeclared).toEqual(["apps/web/.generated/routes.ts"]);
  });
});

describe("proving the recorder ran in every bundle", () => {
  it("reports every required root the graph does not reach", () => {
    expect(unreachedRoots(["apps/web/src/a.ts"]).map((r) => r.prefix)).toEqual([
      "apps/web/src/routes/",
      "apps/web/src/psi/workers/psiCrypto.worker.ts",
    ]);
  });

  it("names roots holding a tracked file", () => {
    const tracked = [...trackedFiles(repoRoot)];
    for (const root of REQUIRED_GRAPH_ROOTS) {
      expect(
        tracked.some((file) => file.startsWith(root.prefix)),
        root.prefix,
      ).toBe(true);
    }
  });

  it("reports none when every root is reached", () => {
    expect(
      unreachedRoots(REQUIRED_GRAPH_ROOTS.map((r) => `${r.prefix}file.ts`)),
    ).toEqual([]);
  });
});

describe("wiring", () => {
  // A text scan, not a build: it asserts the two ends of the recorder handshake
  // name the same variable, which is the drift that would leave the record empty.
  it("names the record variable in the module the recorder lives in", () => {
    expect(readRepo(RECORDER_MODULE)).toContain(`"${RECORD_ENV}"`);
  });

  // The artifact is packaged from what the build leaves in apps/web/dist/hosted, so
  // the build and the upload have to stay in one job: a build moved to a job of
  // its own would leave the packaging job with nothing to zip.
  it("builds the web app in the job that uploads the deploy artifact", () => {
    const workflow = workflowDocument(
      repoRoot,
      ".github/workflows/eb_build_and_test.yaml",
    );
    const uploaders = Object.values(workflow.jobs).filter((job) =>
      (job.steps ?? []).some((step) =>
        (step.uses ?? "").startsWith("actions/upload-artifact@"),
      ),
    );
    expect(uploaders).toHaveLength(1);
    expect(
      (uploaders[0].steps ?? []).some((step) =>
        (step.run ?? "").includes("npm run build -w apps/web"),
      ),
    ).toBe(true);
  });

  // The Pages deploy job holds the Cloudflare token, so it runs after the web
  // suite, builds nothing and checks nothing out: it uploads the site the build
  // job left as an artifact.
  it("uploads to Pages only after the web suite, from a job that checks nothing out", () => {
    const workflow = workflowDocument(repoRoot, DEPLOY_WORKFLOW);
    const jobs = Object.entries(workflow.jobs);
    const deployers = jobs.filter(([, job]) =>
      (job.steps ?? []).some((step) =>
        (step.uses ?? "").startsWith("cloudflare/wrangler-action@"),
      ),
    );
    expect(deployers).toHaveLength(1);
    const [, deploy] = deployers[0];
    const gate = jobs.find(([, job]) => job.uses === `./${GATE_WORKFLOW}`)?.[0];
    expect(gate).toBeDefined();
    expect(deploy.needs).toContain(gate);
    const usesOf = (job) => (job.steps ?? []).map((step) => step.uses ?? "");
    expect(
      usesOf(deploy).every((uses) => !uses.startsWith("actions/checkout@")),
    ).toBe(true);
    expect(deploy.steps.every((step) => step.run === undefined)).toBe(true);
    const builder = jobs.find(([, job]) =>
      (job.steps ?? []).some((step) =>
        (step.run ?? "").includes(BUILD_COMMAND),
      ),
    );
    expect(builder).toBeDefined();
    expect(deploy.needs).toContain(builder[0]);
    const upload = builder[1].steps.find((step) =>
      (step.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    const download = deploy.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/download-artifact@"),
    );
    expect(upload.with.path).toBe(BUILD_OUTPUT);
    expect(download.with.name).toBe(upload.with.name);
  });

  // The check reads the deploy filter, so a pull request editing only that file
  // has to reach the workflow that runs the check.
  it("triggers that workflow on a change to the deploy filter itself", () => {
    const filter = compileFilter(gateScope());
    expect(filter.matches(DEPLOY_WORKFLOW)).toBe(true);
  });
});
