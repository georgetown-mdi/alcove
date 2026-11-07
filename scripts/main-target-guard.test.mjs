import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// A pull request into main passes only when its head is this repository's own
// staging branch. The workflow cannot run here, so the step's own `run` text is
// run under bash with the values the event would give it, and the workflow
// document is checked for the shape that keeps the job harmless: read-only
// permissions, no checkout, no action, no repository code, and no expression
// interpolated into the shell text.
//
// What only a real pull request into main can show: that the event payload
// fields named below hold those values on GitHub, that a Dependabot pull
// request is given this run, that `edited` fires when a pull request is
// retargeted at main, and that the check name appears on the pull request.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const GUARD_WORKFLOW = `${WORKFLOW_DIR}/main_target_guard.yaml`;
const document = workflowDocument(repoRoot, GUARD_WORKFLOW);
const job = document.jobs["promotion-only"];
const steps = job.steps;
const runText = steps[0].run;

const REPOSITORY = "georgetown-mdi/alcove";

/** The step's run text under bash, with the event values given as env. */
function runStep(headRef, headRepo) {
  const result = spawnSync("bash", ["-e", "-c", runText], {
    env: {
      PATH: process.env.PATH,
      HEAD_REF: headRef,
      HEAD_REPO: headRepo,
      BASE_REPO: REPOSITORY,
    },
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("the main target guard step", () => {
  it("passes the promotion of this repository's staging branch", () => {
    expect(runStep("staging", REPOSITORY).status).toBe(0);
  });

  it("fails a Dependabot security update against main", () => {
    const { status, output } = runStep(
      "dependabot/npm_and_yarn/js-yaml-4.1.1",
      REPOSITORY,
    );
    expect(status).toBe(1);
    expect(output).toContain("::error::");
  });

  it("fails a branch named staging from a fork", () => {
    expect(runStep("staging", "someone/alcove").status).toBe(1);
  });

  it("fails a branch named staging whose head repository is gone", () => {
    expect(runStep("staging", "").status).toBe(1);
  });

  it("fails a release branch", () => {
    expect(runStep("release/v1.2.3", REPOSITORY).status).toBe(1);
    expect(runStep("release/v1.2.3", "someone/alcove").status).toBe(1);
  });

  it("fails a branch that only contains the name staging", () => {
    expect(runStep("staging-fix", REPOSITORY).status).toBe(1);
    expect(runStep("feature/staging", REPOSITORY).status).toBe(1);
    expect(runStep("Staging", REPOSITORY).status).toBe(1);
  });

  it("fails a branch name that holds shell syntax without running it", () => {
    const { status, output } = runStep(
      'staging"; echo injected; "',
      REPOSITORY,
    );
    expect(status).toBe(1);
    expect(output).not.toMatch(/^injected$/m);
  });

  it("fails with one error line naming the runbook section", () => {
    const { output } = runStep("dependabot/npm_and_yarn/x", REPOSITORY);
    const errors = output
      .split("\n")
      .filter((line) => line.startsWith("::error::"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("A security update opened against main");
  });
});

describe("the main target guard workflow", () => {
  it("runs on pull requests into main only", () => {
    expect(document.on.pull_request.branches).toEqual(["main"]);
    expect(document.on.pull_request.types).toContain("edited");
    expect(Object.keys(document.on)).toEqual(["pull_request"]);
  });

  it("holds read-only permissions at the workflow and job", () => {
    for (const permissions of [document.permissions, job.permissions]) {
      for (const level of Object.values(permissions ?? {})) {
        expect(["read", "none"]).toContain(level);
      }
    }
    expect(document.permissions).toBeDefined();
  });

  it("checks out nothing and uses no action or repository code", () => {
    expect(steps).toHaveLength(1);
    expect(steps.every((step) => step.uses === undefined)).toBe(true);
    expect(runText).not.toMatch(/checkout|npm|node|\.\/|\bsh\b|\bsource\b/);
  });

  it("reads the event only through env, never inside the run text", () => {
    expect(runText).not.toContain("${{");
    expect(steps[0].env).toEqual({
      HEAD_REF: "${{ github.event.pull_request.head.ref }}",
      HEAD_REPO: "${{ github.event.pull_request.head.repo.full_name }}",
      BASE_REPO: "${{ github.repository }}",
    });
  });
});
