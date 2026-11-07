import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "release-deploy-order.mjs");

describe("the release's production upload against main", () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-deploy-order-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  // No user or system git configuration reaches the fixture or the script.
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: scratch,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
  const git = (cwd, args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

  const origin = join(scratch, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", origin], { env: gitEnv });
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const tree = git(origin, ["mktree"]);
  const commit = (message, parents = []) =>
    git(origin, [
      "commit-tree",
      tree,
      "-m",
      message,
      ...parents.flatMap((parent) => ["-p", parent]),
    ]);
  const before = commit("before the release");
  const release = commit("the release", [before]);
  const after = commit("after the release", [release]);
  const offMain = commit("a commit main never holds", [before]);
  git(origin, ["update-ref", "refs/heads/hotfix", offMain]);
  git(origin, ["tag", "-a", "-m", "release", "v1.0.0", release]);
  const tagObject = git(origin, ["rev-parse", "refs/tags/v1.0.0"]);

  const clone = join(scratch, "clone");
  const setMain = (target) =>
    git(origin, ["update-ref", "refs/heads/main", target]);
  setMain(after);
  git(scratch, ["clone", "--quiet", `file://${origin}`, clone]);

  const run = (main, releaseCommit, cwd = clone) => {
    setMain(main);
    return spawnSync(process.execPath, [SCRIPT], {
      cwd,
      encoding: "utf8",
      env: { ...gitEnv, ALCOVE_RELEASE_COMMIT: releaseCommit },
    });
  };

  it("uploads when main's tip is the release commit", () => {
    const result = run(release, release);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true\n");
  });

  it("uploads when main's tip is an ancestor of the release commit", () => {
    const result = run(before, release);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true\n");
  });

  it("reads the release commit through a tag object", () => {
    expect(tagObject).not.toBe(release);
    const result = run(release, tagObject);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true\n");
  });

  it("skips the upload when main has commits after the release commit", () => {
    const result = run(after, release);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("false\n");
    expect(result.stderr).toMatch(/has commits after the release commit/);
  });

  it("skips the upload when the release commit is not on main", () => {
    const result = run(release, offMain);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("false\n");
    expect(result.stderr).toMatch(/is not on main/);
  });

  it("reads main from origin when it runs, not from the clone's last fetch", () => {
    setMain(release);
    git(clone, ["fetch", "--quiet", "origin"]);
    const result = run(after, release);
    expect(result.stdout).toBe("false\n");
  });

  it("refuses a shallow clone, printing no answer", () => {
    const shallow = join(scratch, "shallow");
    setMain(after);
    git(scratch, [
      "clone",
      "--quiet",
      "--depth=1",
      `file://${origin}`,
      shallow,
    ]);
    const result = run(after, after, shallow);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/The checkout is shallow/);
  });

  it("sets the job's output from the workflow step's own text", () => {
    const step = workflowDocument(
      repoRoot,
      `${WORKFLOW_DIR}/release.yaml`,
    ).jobs["deploy-order"].steps.find((candidate) => candidate.id === "decide");
    mkdirSync(join(clone, "scripts"));
    copyFileSync(SCRIPT, join(clone, "scripts", "release-deploy-order.mjs"));
    const outputFor = (main) => {
      setMain(main);
      const output = join(scratch, `output-${main}`);
      execFileSync("bash", ["-c", step.run], {
        cwd: clone,
        env: {
          ...gitEnv,
          ALCOVE_RELEASE_COMMIT: release,
          GITHUB_OUTPUT: output,
        },
        stdio: ["ignore", "ignore", "ignore"],
      });
      return readFileSync(output, "utf8");
    };
    expect(outputFor(release)).toBe("deploys=true\n");
    expect(outputFor(after)).toBe("deploys=false\n");
  });

  it("exits with usage when no release commit is given", () => {
    const result = run(release, "");
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});

describe("the release workflow's use of the answer", () => {
  const document = workflowDocument(repoRoot, `${WORKFLOW_DIR}/release.yaml`);
  const order = document.jobs["deploy-order"];
  const pages = document.jobs.pages;
  const decide = (order?.steps ?? []).find((step) => step.id === "decide");

  it("uploads to production only when the answer is true", () => {
    expect([pages.needs].flat()).toContain("deploy-order");
    expect(pages.if).toContain("needs.deploy-order.outputs.deploys == 'true'");
    expect(order.outputs.deploys).toBe("${{ steps.decide.outputs.deploys }}");
  });

  it("decides from the run's commit with main's full history", () => {
    expect(decide?.env?.ALCOVE_RELEASE_COMMIT).toBe("${{ github.sha }}");
    expect(decide?.run).toContain("node scripts/release-deploy-order.mjs");
    const checkout = order.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("decides after every other job the upload waits on", () => {
    const others = [pages.needs].flat().filter((job) => job !== "deploy-order");
    expect([order.needs].flat().sort()).toEqual(others.sort());
  });

  it("holds read access alone and no environment", () => {
    expect(order.permissions).toEqual({ contents: "read" });
    expect(order.environment).toBeUndefined();
  });

  it("runs on the same tag pushes as the upload", () => {
    expect(order.if).toBe(
      "${{ github.event_name == 'push' && needs.release-line.outputs.newest == 'true' }}",
    );
  });
});
