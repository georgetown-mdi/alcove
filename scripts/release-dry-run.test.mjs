import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// The release workflow publishes on a pushed version tag and runs as a dry run
// on a manual dispatch. What keeps a dispatch from publishing is a condition on
// each publishing step, so this holds every such step to the tag-push
// condition: a new push, signature, attestation, registry login or release
// write added without it fails here rather than on the next dry run.
//
// What this cannot see: a publishing command this classification does not
// recognize, such as a registry write through a plain `docker push`.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const RELEASE_WORKFLOW = `${WORKFLOW_DIR}/release.yaml`;
const document = workflowDocument(repoRoot, RELEASE_WORKFLOW);

const TAG_PUSH_ONLY = "${{ github.event_name == 'push' }}";
const DRY_RUN_ONLY = "${{ github.event_name != 'push' }}";

const isPush = (value) => value === true || value === "true";

/** Why a step publishes, or undefined when it does not. */
function publishes(step) {
  const uses = step.uses ?? "";
  const run = step.run ?? "";
  if (uses.startsWith("docker/build-push-action@") && isPush(step.with?.push))
    return "pushes an image";
  if (uses.startsWith("docker/login-action@")) return "logs in to a registry";
  if (uses.startsWith("actions/attest-build-provenance@"))
    return "writes an attestation";
  if (/\bcosign\s+sign(?![-\w])/.test(run)) return "signs an image";
  if (/\bgh\s+release\b/.test(run)) return "writes a release";
  return undefined;
}

const steps = Object.entries(document.jobs).flatMap(([job, { steps = [] }]) =>
  steps.map((step) => ({ job, step })),
);

describe("the release workflow's dry run", () => {
  it("is triggered by a pushed version tag and by a manual dispatch", () => {
    expect(document.on.push.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+"]);
    expect(document.on).toHaveProperty("workflow_dispatch");
  });

  it("gates no job on the event, so a dry run drives every job", () => {
    for (const job of Object.values(document.jobs)) {
      expect(job.if).toBeUndefined();
    }
  });

  const publishing = steps.filter(({ step }) => publishes(step) !== undefined);

  it("finds the publishing steps it holds", () => {
    expect(publishing.length).toBeGreaterThanOrEqual(8);
  });

  for (const { job, step } of publishing) {
    it(`runs "${step.name}" (${job}, ${publishes(step)}) on a tag push only`, () => {
      expect(step.if).toBe(TAG_PUSH_ONLY);
    });
  }

  it("pushes nothing from a step that runs on a dry run", () => {
    const dryRunSteps = steps.filter(({ step }) => step.if === DRY_RUN_ONLY);
    expect(dryRunSteps.length).toBeGreaterThan(0);
    for (const { step } of dryRunSteps) {
      expect(publishes(step)).toBeUndefined();
    }
  });
});
