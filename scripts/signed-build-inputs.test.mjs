import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  DEPLOY_ACTION,
  DEPLOY_TOOL_DIR,
  DEPLOY_WORKFLOW,
  RELEASE_WORKFLOW,
  SITE_DEPLOY_WORKFLOW,
  SITE_PUBLISH_WORKFLOW,
  isDeployToolCheckout,
} from "./check-deploy-trigger-graph.mjs";
import {
  WORKFLOW_DIR,
  compositeFiles,
  readWorkflows,
  workflowDocument,
} from "./lib/workflows.mjs";

// The inputs of what the repository signs and deploys: the hosted site and
// the project site, the release images, and the tool that uploads the sites.
// Each is held here by reading the workflow files as data:
//
//   - the deployed sites are built from a clean install, not a restored
//     actions/cache entry, off a pull request;
//   - the release publish job's image builds read no shared layer cache;
//   - every remote action is pinned to a commit with its release tag beside it;
//   - each job taking a site from the web gate downloads it by the id its
//     package job reported and checks it against that job's digest;
//   - each wrangler-action step runs wrangler installed from the committed
//     lockfile, at the version that lockfile holds.
//
// What it cannot see: what a run does with these inputs. That a download by
// a replaced id fails, and that wrangler-action skips its own install, were
// read from the actions' sources, not driven here.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_WORKFLOW = `${WORKFLOW_DIR}/web_build_and_test.yaml`;
const SETUP_ACTION = "./.github/actions/setup";
const UNCACHED_OFF_PULL_REQUEST = "${{ github.event_name == 'pull_request' }}";

// The command every producer and consumer of a site artifact runs over the
// tree, from inside it, to compute the digest the two compare.
const TREE_DIGEST =
  'digest="$(cd "${TREE}" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum)"';

const usesPrefix = (prefix) => (step) =>
  String(step?.uses ?? "").startsWith(prefix);
const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);
const gateJobOf = (document) =>
  Object.entries(document.jobs).find(
    ([, job]) => job.uses === `./${GATE_WORKFLOW}`,
  )?.[0];

describe("the deployed sites' builds", () => {
  it.each([
    [GATE_WORKFLOW, "package"],
    [SITE_DEPLOY_WORKFLOW, "build"],
  ])(
    "%s job %s runs the setup action uncached off a pull request",
    (path, id) => {
      const setups = stepsOf(workflowDocument(repoRoot, path).jobs[id]).filter(
        (step) => step.uses === SETUP_ACTION,
      );
      expect(setups).toHaveLength(1);
      expect(setups[0].with?.cache).toBe(UNCACHED_OFF_PULL_REQUEST);
    },
  );

  it(`${SITE_PUBLISH_WORKFLOW} job build runs the setup action uncached`, () => {
    const setups = stepsOf(
      workflowDocument(repoRoot, SITE_PUBLISH_WORKFLOW).jobs.build,
    ).filter((step) => step.uses === SETUP_ACTION);
    expect(setups).toHaveLength(1);
    expect(setups[0].with?.cache).toBe("false");
  });

  // The input only reaches the cache through these conditions, so a cache
  // step that stopped reading it would restore or save whatever the caller
  // passed.
  it("restores and saves nothing from actions/cache when the setup action's cache input is false", () => {
    const action = parse(
      readFileSync(
        resolve(repoRoot, ".github/actions/setup/action.yml"),
        "utf8",
      ),
    );
    expect(action.inputs.cache.default).toBe("true");
    const cacheSteps = action.runs.steps.filter(usesPrefix("actions/cache"));
    expect(cacheSteps.length).toBeGreaterThan(0);
    for (const step of cacheSteps) {
      expect(String(step.if ?? ""), step.name).toMatch(
        /^inputs\.cache != 'false' && /,
      );
    }
  });
});

describe("the release publish job's image builds", () => {
  const publish = workflowDocument(repoRoot, RELEASE_WORKFLOW).jobs.publish;
  const builds = stepsOf(publish).filter(
    usesPrefix("docker/build-push-action@"),
  );

  it("finds the scan and push builds", () => {
    expect(builds.map((step) => step.id).sort()).toEqual([
      "build",
      "build_fips",
      "default_build",
      "fips_build",
    ]);
  });

  it.each(builds.map((step) => [step.id, step]))(
    "builds %s with no shared layer cache",
    (_id, step) => {
      expect(step.with?.["cache-from"]).toBeUndefined();
      expect(step.with?.["cache-to"]).toBeUndefined();
    },
  );
});

describe("the actions in the signing and publishing jobs", () => {
  const REMOTE_ACTION = /^(?!\.\/|docker:\/\/).+/;
  const workflows = readWorkflows(repoRoot);
  const composites = compositeFiles(repoRoot).map((path) => ({
    path,
    source: readFileSync(resolve(repoRoot, path), "utf8"),
  }));

  // Every occurrence, so one action has one ref across the workflows and a
  // bump moves them together.
  it("pins every remote action to a commit with its release tag beside it", () => {
    const lines = [...workflows, ...composites].flatMap(({ path, source }) =>
      source
        .split("\n")
        .map((line, index) => ({ path, line: index + 1, text: line.trim() }))
        .filter(({ text }) => /^(- )?uses: (?!\.\/|docker:\/\/)/.test(text)),
    );
    expect(lines.length).toBeGreaterThan(0);
    const unpinned = lines.filter(
      ({ text }) => !/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(text),
    );
    expect(unpinned).toEqual([]);
  });

  it("finds jobs holding the signing identity or the Docker Hub publish token, each using such an action", () => {
    const holders = workflows.flatMap(({ path, source }) =>
      Object.entries(parse(source).jobs ?? {})
        .filter(
          ([, job]) =>
            job?.permissions?.["id-token"] === "write" ||
            JSON.stringify(job ?? null).includes("DOCKERHUB_PUBLISH_TOKEN"),
        )
        .map(([id, job]) => ({ path, id, job })),
    );
    expect(holders.length).toBeGreaterThan(0);
    for (const { path, id, job } of holders) {
      const pinned = stepsOf(job).filter((step) =>
        REMOTE_ACTION.test(String(step.uses ?? "")),
      );
      expect(pinned.length, `${path} job ${id}`).toBeGreaterThan(0);
      for (const step of pinned) {
        expect(step.uses, `${path} job ${id}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

describe("the site artifacts' hand-off", () => {
  const gate = workflowDocument(repoRoot, GATE_WORKFLOW);
  const outputs = gate.on.workflow_call.outputs;
  const packager = gate.jobs.package;
  const packageSteps = stepsOf(packager);

  const OUTPUTS = [
    { id: "artifactId", sha256: "artifactSha256" },
    { id: "demoArtifactId", sha256: "demoArtifactSha256" },
  ];

  // jobs.package.outputs.<name> -> the step output it reads.
  const stepOutput = (name) => {
    const job = outputs[name]?.value.match(
      /^\$\{\{\s*jobs\.package\.outputs\.([\w-]+)\s*\}\}$/,
    );
    expect(job, name).not.toBeNull();
    const step = packager.outputs[job[1]].match(
      /^\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/,
    );
    expect(step, name).not.toBeNull();
    return {
      step: packageSteps.find((candidate) => candidate.id === step[1]),
      output: step[2],
    };
  };

  it.each(OUTPUTS.map((pair) => [pair.id, pair]))(
    "reports %s as an upload's id and the digest of the tree it uploads",
    (_label, { id, sha256 }) => {
      const upload = stepOutput(id);
      expect(upload.output).toBe("artifact-id");
      expect(upload.step.uses).toMatch(/^actions\/upload-artifact@/);
      const digest = stepOutput(sha256);
      expect(digest.output).toBe("sha256");
      expect(digest.step.run).toContain(TREE_DIGEST);
      // The Vite manifest is a test input, removed before the digest so the
      // site does not serve it.
      expect(digest.step.run).toContain('rm -rf "${TREE}/.vite"');
      expect(digest.step.env.TREE).toBe(upload.step.with.path);
      expect(packageSteps.indexOf(digest.step)).toBe(
        packageSteps.indexOf(upload.step) - 1,
      );
    },
  );

  const consumers = [
    [DEPLOY_WORKFLOW, ["hosted-manifest", "deploy"]],
    [RELEASE_WORKFLOW, ["hosted-manifest", "pages"]],
  ].flatMap(([path, ids]) => {
    const document = workflowDocument(repoRoot, path);
    const gateJob = gateJobOf(document);
    return ids.map((id) => [`${path} job ${id}`, document.jobs[id], gateJob]);
  });

  it.each(consumers)(
    "%s downloads each site by id and checks it against the package job's digest",
    (_label, job, gateJob) => {
      expect(gateJob).toBeDefined();
      expect([job.needs].flat()).toContain(gateJob);
      const steps = stepsOf(job);
      const downloads = steps.filter(usesPrefix("actions/download-artifact@"));
      expect(downloads).toHaveLength(2);
      downloads.forEach((download, index) => {
        const { id, sha256 } = OUTPUTS[index];
        expect(download.with.name).toBeUndefined();
        expect(download.with["artifact-ids"]).toBe(
          `\${{ needs.${gateJob}.outputs.${id} }}`,
        );
        const check = steps[steps.indexOf(download) + 1];
        expect(check.if).toBe(download.if);
        expect(check.env).toEqual({
          TREE: download.with.path,
          EXPECTED_SHA256: `\${{ needs.${gateJob}.outputs.${sha256} }}`,
        });
        expect(check.run).toContain(TREE_DIGEST);
        expect(check.run).toContain(
          'if [ "${digest%% *}" != "${EXPECTED_SHA256}" ]; then',
        );
        expect(check.run).toContain(
          'if ! [[ "${EXPECTED_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then',
        );
      });
    },
  );

  // Every other consumer of the gate's outputs is one of the jobs above, so
  // no job takes a site by name.
  it.each([DEPLOY_WORKFLOW, RELEASE_WORKFLOW])(
    "%s downloads no site by name",
    (path) => {
      const document = workflowDocument(repoRoot, path);
      const gateJob = gateJobOf(document);
      for (const [id, job] of Object.entries(document.jobs)) {
        for (const download of stepsOf(job).filter(
          usesPrefix("actions/download-artifact@"),
        )) {
          expect(String(download.with?.name ?? ""), `job ${id}`).not.toContain(
            `needs.${gateJob}.`,
          );
          expect(
            download.with?.name ?? download.with?.["artifact-ids"],
            `job ${id}`,
          ).toBeDefined();
        }
      }
    },
  );
});

describe("the deploy tool", () => {
  const lock = JSON.parse(
    readFileSync(
      resolve(repoRoot, DEPLOY_TOOL_DIR, "package-lock.json"),
      "utf8",
    ),
  );
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, DEPLOY_TOOL_DIR, "package.json"), "utf8"),
  );
  const lockedVersion = lock.packages["node_modules/wrangler"]?.version;

  const deploySteps = [
    DEPLOY_WORKFLOW,
    RELEASE_WORKFLOW,
    SITE_DEPLOY_WORKFLOW,
    SITE_PUBLISH_WORKFLOW,
  ].flatMap((path) =>
    Object.entries(workflowDocument(repoRoot, path).jobs).flatMap(([id, job]) =>
      stepsOf(job)
        .filter(usesPrefix(DEPLOY_ACTION))
        .map((step) => [`${path} job ${id} step ${step.name}`, step, job]),
    ),
  );

  it("tracks the manifest and the lockfile alone in its directory", () => {
    const tracked = execFileSync("git", ["ls-files", "--", DEPLOY_TOOL_DIR], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(tracked).toEqual([
      `${DEPLOY_TOOL_DIR}/package-lock.json`,
      `${DEPLOY_TOOL_DIR}/package.json`,
    ]);
  });

  it("locks the wrangler its manifest names", () => {
    expect(lockedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(manifest).sort()).toEqual([
      "dependencies",
      "description",
      "name",
      "overrides",
      "private",
    ]);
    expect(manifest.dependencies).toEqual({ wrangler: lockedVersion });
    expect(manifest.overrides).toEqual({ sharp: "0.35.5", undici: "7.30.2" });
    expect(lock.packages["node_modules/sharp"]?.version).toBe("0.35.5");
    expect(lock.packages["node_modules/undici"]?.version).toBe("7.30.2");
    expect(lock.packages[""].dependencies).toEqual({ wrangler: lockedVersion });
  });

  it("is updated by Dependabot from its own directory", () => {
    const config = parse(
      readFileSync(resolve(repoRoot, ".github/dependabot.yml"), "utf8"),
    );
    const blocks = config.updates.filter(
      (block) =>
        block["package-ecosystem"] === "npm" &&
        block.directory === `/${DEPLOY_TOOL_DIR}`,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]["target-branch"]).toBe("staging");
  });

  it("finds the six upload steps", () => {
    expect(deploySteps).toHaveLength(6);
  });

  it.each(deploySteps)(
    "%s runs the locked wrangler from the deploy tool's directory",
    (_label, step, job) => {
      expect(step.with.workingDirectory).toBe(DEPLOY_TOOL_DIR);
      expect(step.with.wranglerVersion).toBe(lockedVersion);
      const steps = stepsOf(job);
      const at = steps.indexOf(step);
      const checkout = steps.findIndex(isDeployToolCheckout);
      const install = steps.findIndex(
        (candidate) =>
          candidate["working-directory"] === DEPLOY_TOOL_DIR &&
          /^npm ci\b/.test(String(candidate.run ?? "")),
      );
      expect(checkout).not.toBe(-1);
      expect(install).toBeGreaterThan(checkout);
      expect(install).toBeLessThan(at);
      expect(steps[install].if).toBeUndefined();
      expect(job.permissions).toEqual({ contents: "read" });
    },
  );
});
