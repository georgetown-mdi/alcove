import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// The release workflow publishes on a pushed version tag; a manual dispatch,
// from any branch, runs the dry-run job instead. This holds the shape that
// keeps a dispatch from holding a write permission: the publishing jobs run on
// a tag push only, and the dry-run job has read access alone, no publishing
// step, and builds with a literal `push: false`.
//
// What this cannot see: a `run` that publishes through a script file, such as
// `run: ./publish.sh`, since only the step's own text is read.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const RELEASE_WORKFLOW = `${WORKFLOW_DIR}/release.yaml`;
const document = workflowDocument(repoRoot, RELEASE_WORKFLOW);

const TAG_PUSH_ONLY = "${{ github.event_name == 'push' }}";
const PUBLISHING_JOBS = ["publish", "launchers"];
const DRY_RUN_JOB = "dry-run";

const PUBLISHING_ACTIONS = [
  /(^|\/)login-action@/,
  /^actions\/attest/,
  /release/i,
];
const PUBLISHING_COMMANDS = [
  /\bcosign\s+sign(?![-\w])/,
  /\bcosign\s+verify(?![-\w])/,
  /\bdocker\s+push\b/,
  /\bgh\s+release\b/,
  /\bgh\s+api\b.*(-X|--method)[\s=]*['"]?(POST|PUT|PATCH|DELETE)\b/i,
  /\bgh\s+api\b.*\s(-f|-F|--field|--raw-field|--input)\b/,
];

/** Why a step publishes, or undefined when it does not. */
function publishes(step) {
  const uses = step.uses ?? "";
  const run = step.run ?? "";
  const action = PUBLISHING_ACTIONS.find((pattern) => pattern.test(uses));
  if (action !== undefined) return `uses ${uses}`;
  const command = PUBLISHING_COMMANDS.find((pattern) => pattern.test(run));
  if (command !== undefined) return `runs ${command.source}`;
  return undefined;
}

const dryRun = document.jobs[DRY_RUN_JOB];
const dryRunSteps = dryRun?.steps ?? [];

describe("the release workflow's dry run", () => {
  it("is triggered by a pushed version tag and by a manual dispatch alone", () => {
    expect(Object.keys(document.on).sort()).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    expect(document.on.push.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+"]);
  });

  for (const job of PUBLISHING_JOBS) {
    it(`runs the ${job} job on a tag push only`, () => {
      expect(document.jobs[job]?.if).toBe(TAG_PUSH_ONLY);
    });
  }

  it("gives the dry-run job read access to the repository and nothing else", () => {
    expect(dryRun?.permissions).toEqual({ contents: "read" });
  });

  it("has no login, attest, sign, verify, push or release step in the dry-run job", () => {
    expect(dryRunSteps.length).toBeGreaterThan(0);
    const found = dryRunSteps
      .map((step) => ({ name: step.name ?? step.uses, why: publishes(step) }))
      .filter(({ why }) => why !== undefined);
    expect(found).toEqual([]);
  });

  it("builds with a literal `push: false` in every dry-run build step", () => {
    const builds = dryRunSteps.filter((step) =>
      (step.uses ?? "").startsWith("docker/build-push-action@"),
    );
    expect(builds.length).toBe(2);
    for (const step of builds) {
      expect(step.with?.push).toBe(false);
    }
  });
});
