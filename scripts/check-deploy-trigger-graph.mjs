#!/usr/bin/env node
// Deploy-trigger check: `npm run check:deploy-trigger-graph`, run by
// `npm run check:all` in static_checks.yaml. It fails unless:
//
//   - pages_deploy.yaml holds the only deploy. Across every workflow exactly one
//     job uploads with DEPLOY_ACTION, names a Cloudflare secret or runs in a
//     GitHub environment; that job is in pages_deploy.yaml and runs no
//     repository code (no `run` step, no checkout, no local action, no called
//     workflow); and no workflow passes `secrets: inherit` or `toJSON(secrets)`.
//   - Every tracked source the hosted static build reads matches a push filter of
//     pages_deploy.yaml. The graph is the module ids rolldown resolves in the page
//     and worker bundles of a real `npm run build -w apps/web`, recorded by
//     RECORDER_MODULE under RECORD_ENV. It must reach every REQUIRED_GRAPH_ROOTS
//     tree, and an untracked entry must sit under a BUILD_PRODUCTS prefix whose
//     tracked sources the filter matches.
//   - Every filter pattern it reads is a literal path, `prefix/**` or
//     `!prefix/**/*.ext`; any other shape throws.
//
// Exit 0 clean, 1 on a finding. Rationale and limits:
// docs/notes/repo-check-scripts.md.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKFLOW_DIR,
  parseWorkflow,
  readWorkflows,
  workflowDocument,
} from "./lib/workflows.mjs";

/** The workflow whose push filter decides when a deploy runs. */
export const DEPLOY_WORKFLOW = `${WORKFLOW_DIR}/pages_deploy.yaml`;

/** The build output the deploy uploads. */
export const BUILD_OUTPUT = "apps/web/dist/hosted";

/** The module that installs the recorder this check reads. */
export const RECORDER_MODULE = "apps/web/hosted/deployGraphRecorder.ts";

/**
 * The environment variable RECORDER_MODULE reads to install its module-id
 * recorder. Named in both places and nowhere else; a rename that
 * misses one side leaves the record empty, which REQUIRED_GRAPH_ROOTS fails on.
 */
export const RECORD_ENV = "ALCOVE_DEPLOY_GRAPH_RECORD";

// The build this check measures: the app's own build script, so what runs here
// is what CI and a developer run rather than a bespoke invocation shaped to be
// measurable.
const BUILD_ARGV = ["npm", "run", "build", "-w", "apps/web"];

/** The build invocation, as a contributor would type it. */
export const BUILD_COMMAND = BUILD_ARGV.join(" ");

/**
 * `env` with a loopback signaling address filled in when it names none: the
 * hosted build refuses to run without VITE_SIGNALING_SERVER_URL
 * (apps/web/vite.config.ts), and this check reads the build without dialing
 * the broker.
 */
export function webBuildEnv(env = process.env) {
  if (env.VITE_SIGNALING_SERVER_URL?.trim()) return env;
  return { ...env, VITE_SIGNALING_SERVER_URL: "ws://127.0.0.1/api/" };
}

/**
 * Trees that must each contribute at least one path to the collected graph. A
 * recorder that silently stops producing in one bundle -- no longer installed
 * on the page build, or on the worker builds -- would otherwise leave a
 * shrunken graph that trivially satisfies the filter. Each entry names the
 * bundle it proves recorded.
 */
export const REQUIRED_GRAPH_ROOTS = [
  {
    prefix: "apps/web/src/",
    reason:
      "the application sources; an empty result here means the build itself produced nothing to read",
  },
  {
    prefix: "apps/web/src/routes/",
    reason:
      "the route modules, which only the page bundle reads -- so this is the entry that fails when the recorder stops being installed on the page build",
  },
  {
    prefix: "apps/web/src/psi/workers/psiCrypto.worker.ts",
    reason:
      "the PSI worker's entry, which only its worker bundle reads -- so this is the entry that fails when the recorder stops being installed on the worker builds",
  },
];

/**
 * Build products the graph legitimately reaches instead of the sources behind
 * them. Git does not track these, so a push can never include one and the filter
 * cannot usefully name one; what the filter has to name is the tree they are
 * built from. An untracked graph entry under no declared product fails the
 * check rather than being waved through.
 */
export const BUILD_PRODUCTS = [
  {
    product: "packages/core/dist/",
    sources: "packages/core/src/",
    reason:
      "the apps consume @alcove/core from its built dist/ (CONTRIBUTING.md, Building), so the bundlers read the bundle and never the sources it was built from",
  },
  {
    product: "packages/cli-contract/dist/",
    sources: "packages/cli-contract/src/",
    reason:
      "the console's job client consumes @alcove/cli-contract from its built dist/, as the apps do core",
  },
  {
    product: "apps/web/.tanstack/hosted/",
    sources: "apps/web/src/routes/",
    reason:
      "the hosted build generates its route tree there from the route files (apps/web/vite.hosted.config.ts), so the bundler reads the generated tree and the route files it names",
  },
];

/** The action that uploads a Pages deployment. */
export const DEPLOY_ACTION = "cloudflare/wrangler-action@";

const DEPLOY_SECRET = /\bsecrets\.CLOUDFLARE_/;
const ALL_SECRETS = /\btoJSON\(\s*secrets\s*\)/;

/**
 * Findings against the single-deploy rule (see the header), as strings, over
 * `[{path, document}]` parsed workflows. Empty when the rule holds.
 */
export function deployCredentialFindings(workflows) {
  const findings = [];
  const holders = [];
  for (const { path, document } of workflows) {
    if (ALL_SECRETS.test(JSON.stringify(document ?? null))) {
      findings.push(
        `${path} expands toJSON(secrets), which hands every secret the run can read to whatever reads the value.`,
      );
    }
    if (DEPLOY_SECRET.test(JSON.stringify(document?.env ?? null))) {
      findings.push(
        `${path} names a Cloudflare secret in its workflow-level env, which every job of the workflow inherits.`,
      );
    }
    for (const [id, job] of Object.entries(document?.jobs ?? {})) {
      if (job?.secrets === "inherit") {
        findings.push(
          `${path} job ${id} passes secrets: inherit, which hands every secret the caller can read to the called workflow.`,
        );
      }
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const holds =
        job?.environment !== undefined ||
        DEPLOY_SECRET.test(JSON.stringify(job ?? null)) ||
        steps.some((step) =>
          String(step?.uses ?? "").startsWith(DEPLOY_ACTION),
        );
      if (holds) holders.push({ path, id, job, steps });
    }
  }
  const named = holders.map(({ path, id }) => `${path} job ${id}`);
  if (holders.length !== 1 || holders[0].path !== DEPLOY_WORKFLOW) {
    findings.push(
      `Exactly one job, in ${DEPLOY_WORKFLOW}, may upload with ${DEPLOY_ACTION}, name a Cloudflare secret or run in a GitHub environment; found ${holders.length}${named.length > 0 ? `: ${named.join(", ")}` : ""}.`,
    );
  }
  for (const { path, id, job, steps } of holders) {
    const code = [];
    if (job?.uses !== undefined) code.push(`calls ${job.uses}`);
    for (const step of steps) {
      const uses = String(step?.uses ?? "");
      if (step?.run !== undefined) code.push("has a run step");
      if (uses.startsWith("./")) code.push(`uses the local action ${uses}`);
      if (uses.startsWith("actions/checkout@"))
        code.push("checks out the repository");
    }
    if (code.length > 0) {
      findings.push(
        `${path} job ${id} holds the deploy credentials and runs repository code: it ${[...new Set(code)].join(", ")}.`,
      );
    }
  }
  return findings;
}

/** Every workflow in the tree, parsed, as `deployCredentialFindings` reads them. */
export function parsedWorkflows(repoRoot) {
  return readWorkflows(repoRoot).map(({ path, source }) => ({
    path,
    document: parseWorkflow(path, source),
  }));
}

const WILDCARD_SUFFIX = "/**";
const GLOB_CHARACTERS = /[*?[\]{}!+@()|]/;
/** `!prefix/**\/*.ext`: negated markdown-exclusion shape, prefix and extension bare. */
const NEGATED_EXTENSION_SUFFIX = /^!(.+)\/\*\*\/\*\.([a-zA-Z0-9]+)$/;

/**
 * The `paths` list of the parsed deploy workflow's push trigger, in file order.
 * Throws when the trigger is not shaped the way this check reads it, so a
 * workflow restructured out from under the check fails rather than yielding an
 * empty filter that matches nothing and reports every source as uncovered.
 */
export function readTriggerPaths(workflow) {
  const paths = workflow?.on?.push?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(
      `${DEPLOY_WORKFLOW} declares no on.push.paths list. Either the deploy trigger stopped being path-filtered -- in which case every push deploys and this check is obsolete -- or the workflow was restructured; scripts/check-deploy-trigger-graph.mjs reads that list and has to be updated with it.`,
    );
  }
  return paths.map(String);
}

/**
 * Compile a path filter (a deploy filter, or a pull-request path scope
 * carrying the same shapes) into `{ patterns, matches }`.
 *
 * Three shapes are read: a literal path matches itself, `prefix/**` matches any
 * path under `prefix/`, and `!prefix/**\/*.ext` negates every path under
 * `prefix/` ending in `.ext`. Every other pattern THROWS, naming itself -- see
 * the header on why this check does not implement the rest of the glob
 * language. `matches` models GitHub's `paths:` order, where the last matching
 * pattern decides; a path scope is gated by git pathspecs, where an exclusion
 * always wins. A test holds every `!` after the includes, where the two agree.
 */
export function compileFilter(patterns) {
  const matchers = patterns.map((pattern) => {
    const negatedExtension = NEGATED_EXTENSION_SUFFIX.exec(pattern);
    if (negatedExtension) {
      const [, prefix, extension] = negatedExtension;
      if (prefix.length > 0 && !GLOB_CHARACTERS.test(prefix)) {
        const suffix = `.${extension}`;
        return {
          negate: true,
          test: (file) =>
            file.startsWith(`${prefix}/`) && file.endsWith(suffix),
        };
      }
    } else if (pattern.endsWith(WILDCARD_SUFFIX)) {
      const prefix = pattern.slice(0, -WILDCARD_SUFFIX.length);
      if (prefix.length > 0 && !GLOB_CHARACTERS.test(prefix)) {
        return { negate: false, test: (file) => file.startsWith(`${prefix}/`) };
      }
    } else if (!GLOB_CHARACTERS.test(pattern)) {
      return { negate: false, test: (file) => file === pattern };
    }
    throw new Error(
      `A workflow carries the path filter "${pattern}", a glob shape scripts/check-deploy-trigger-graph.mjs does not read. It reads a literal path, a trailing "/**", and the negated "!prefix/**/*.ext" shape, and refuses to guess at the rest, because matching GitHub's filter any other way means predicting its parser rather than reading it. Teach compileFilter the shape, or write the entry as one it reads.`,
    );
  });
  return {
    patterns: [...patterns],
    matches: (file) => {
      let included = false;
      for (const matcher of matchers) {
        if (matcher.test(file)) included = !matcher.negate;
      }
      return included;
    },
  };
}

/**
 * The file path a recorded rolldown module id refers to, or null for an id that
 * names no file on disk: a virtual module (`\0`-prefixed, the convention
 * rollup and rolldown share) or a bare specifier. A query suffix (`?worker`,
 * `?url`) is stripped -- it selects how a file is loaded, not which file.
 */
export function moduleIdToPath(id) {
  if (typeof id !== "string" || id.startsWith("\0")) return null;
  const withoutQuery = id.split("?")[0];
  if (withoutQuery === "" || !isAbsolute(withoutQuery)) return null;
  return withoutQuery;
}

/**
 * The repository-relative form of an absolute path, or null when it is outside
 * the repository or inside a `node_modules` tree. A dependency is not a
 * repository source: what moves when one changes is package-lock.json, which
 * the deploy filter names.
 */
export function toRepoPath(absolutePath, repoRoot) {
  const rel = relative(repoRoot, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  if (segments.includes("node_modules")) return null;
  return segments.join("/");
}

/**
 * Hold a collected graph against a compiled filter, as
 * `{uncovered, undeclared, productGaps}`.
 *
 * `uncovered` are tracked sources the filter does not match -- the finding this
 * check exists for. `undeclared` are untracked graph entries under no
 * BUILD_PRODUCTS prefix. `productGaps` are declared build products whose source
 * tree the filter does not fully cover, which is how the filter losing (say)
 * `packages/core/src/**` is caught even though those sources never appear in
 * the graph themselves.
 */
export function classifyGraph({
  graph,
  filter,
  tracked,
  buildProducts = BUILD_PRODUCTS,
}) {
  const uncovered = [];
  const undeclared = [];
  const reached = new Set();
  for (const file of graph) {
    if (tracked.has(file)) {
      if (!filter.matches(file)) uncovered.push(file);
      continue;
    }
    const product = buildProducts.find((entry) =>
      file.startsWith(entry.product),
    );
    if (product) reached.add(product);
    else undeclared.push(file);
  }
  const productGaps = [];
  for (const product of reached) {
    const sources = [...tracked].filter((file) =>
      file.startsWith(product.sources),
    );
    const missed = sources.filter((file) => !filter.matches(file)).sort();
    if (sources.length === 0 || missed.length > 0) {
      productGaps.push({ product, sourceCount: sources.length, missed });
    }
  }
  return {
    uncovered: uncovered.sort(),
    undeclared: undeclared.sort(),
    productGaps,
  };
}

/** The REQUIRED_GRAPH_ROOTS entries no collected path sits under. */
export function unreachedRoots(graph, roots = REQUIRED_GRAPH_ROOTS) {
  return roots.filter(
    (root) => !graph.some((file) => file.startsWith(root.prefix)),
  );
}

/** Run the real build with the recorder pointed at `recordPath`. */
function runBuild(repoRoot, recordPath) {
  const [command, ...args] = BUILD_ARGV;
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...webBuildEnv(), [RECORD_ENV]: recordPath },
  });
}

/**
 * Build, then collect the repository sources the record names, sorted and
 * deduplicated. `build` is injectable so a test can drive collection over a
 * prepared tree without paying for a real build.
 */
export function collectGraph(repoRoot, { build = runBuild } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "alcove-deploy-graph-"));
  const recordPath = join(scratch, "module-ids.json");
  try {
    build(repoRoot, recordPath);
    if (!existsSync(recordPath)) {
      throw new Error(
        `${BUILD_COMMAND} wrote no module-id record. ${RECORDER_MODULE} installs its recorder when ${RECORD_ENV} is set; either the hosted build no longer installs it or the build never reached a bundle, and either way the graph this check reads would be missing everything rolldown resolves.`,
      );
    }
    const output = resolve(repoRoot, BUILD_OUTPUT);
    if (!existsSync(output)) {
      throw new Error(
        `${BUILD_COMMAND} left no ${BUILD_OUTPUT}. The deployed artifact is packaged from that directory, so there is no build to read.`,
      );
    }
    const absolute = JSON.parse(readFileSync(recordPath, "utf8")).map(
      moduleIdToPath,
    );
    const files = new Set();
    for (const path of absolute) {
      if (path === null) continue;
      const repoPath = toRepoPath(path, repoRoot);
      if (repoPath === null) continue;
      const onDisk = resolve(repoRoot, repoPath);
      if (existsSync(onDisk) && statSync(onDisk).isFile()) files.add(repoPath);
    }
    return [...files].sort();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Every path git tracks, as a Set of repository-relative paths. */
export function trackedFiles(repoRoot) {
  return new Set(
    execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean),
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without paying for a build.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const credentialFindings = deployCredentialFindings(
    parsedWorkflows(repoRoot),
  );
  if (credentialFindings.length > 0) {
    console.error(
      "Deploy trigger check failed: the deploy credentials reach more than the one upload job.\n",
    );
    for (const finding of credentialFindings) console.error(`  ${finding}`);
    process.exit(1);
  }
  const filter = compileFilter(
    readTriggerPaths(workflowDocument(repoRoot, DEPLOY_WORKFLOW)),
  );
  const graph = collectGraph(repoRoot);
  const missingRoots = unreachedRoots(graph);
  if (missingRoots.length > 0) {
    console.error(
      `Deploy trigger coverage check failed: the collected graph (${graph.length} files) reaches none of ${missingRoots.length} tree(s) it must, so it is not a graph of the deployed site:\n`,
    );
    for (const root of missingRoots) {
      console.error(`  ${root.prefix} -- ${root.reason}`);
    }
    console.error(
      "\nThe recorder stopped producing paths for one of the bundles. Fix the collection before reading anything into the filter result: a shrunken graph satisfies the filter for the wrong reason.",
    );
    process.exit(1);
  }
  const { uncovered, undeclared, productGaps } = classifyGraph({
    graph,
    filter,
    tracked: trackedFiles(repoRoot),
  });
  if (uncovered.length + undeclared.length + productGaps.length > 0) {
    console.error("Deploy trigger coverage check failed.\n");
    if (uncovered.length > 0) {
      console.error(
        `${uncovered.length} source(s) the deployed build reads that no ${DEPLOY_WORKFLOW} push filter matches:\n`,
      );
      for (const file of uncovered) console.error(`  ${file}`);
      console.error(
        `\nAn edit to one of these changes the deployed site and triggers no deploy: production would keep serving the previous build with nothing red. Either add the path to that filter, or take the file back out of the deployed import graph.`,
      );
    }
    for (const gap of productGaps) {
      console.error(
        `\nThe build reads ${gap.product.product} (${gap.product.reason}), but ${gap.missed.length} of ${gap.sourceCount} tracked file(s) under ${gap.product.sources} match no push filter:\n`,
      );
      for (const file of gap.missed) console.error(`  ${file}`);
      console.error(
        `\nGit tracks no build product, so a push carries the sources instead; the filter has to name them for a change to redeploy.`,
      );
    }
    if (undeclared.length > 0) {
      console.error(
        `\n${undeclared.length} untracked file(s) in the graph under no declared build product:\n`,
      );
      for (const file of undeclared) console.error(`  ${file}`);
      console.error(
        `\nA push cannot carry an untracked path, so no filter entry can cover one. If it is a build product, declare it in BUILD_PRODUCTS in scripts/check-deploy-trigger-graph.mjs with the tree it is built from; if it should be tracked, commit it.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `Deploy trigger coverage check passed: all ${graph.length} repository sources the deployed build reads match one of ${filter.patterns.length} push filters in ${DEPLOY_WORKFLOW}, and its upload job is the one job holding the deploy credentials.`,
  );
}
