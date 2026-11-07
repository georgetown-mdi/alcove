import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// The release workflow verifies the pushed tag's signature against the
// `allowed_signers` file `main` holds before any job publishes, signs or
// deploys. The first block holds the workflow's shape; the second runs the
// verifying step's own text, with real git and ssh-keygen, against a fixture
// origin in a temporary directory.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const document = workflowDocument(repoRoot, `${WORKFLOW_DIR}/release.yaml`);
const jobs = document.jobs ?? {};

// `git ... verify-tag`, not `gh release create --verify-tag`.
const VERIFIES_TAG = /\bgit\b[^\n]*\sverify-tag\b/;

/** Every `[job name, step]` whose run text verifies a tag with git. */
const verifyingSteps = Object.entries(jobs).flatMap(([name, job]) =>
  (job.steps ?? [])
    .filter((step) => VERIFIES_TAG.test(step.run ?? ""))
    .map((step) => [name, step]),
);
const [gateJob, gateStep] = verifyingSteps[0] ?? [];

/** The names of every job `name` waits on, directly or through another. */
function upstream(name, seen = new Set()) {
  for (const need of [jobs[name]?.needs ?? []].flat()) {
    if (seen.has(need)) continue;
    seen.add(need);
    upstream(need, seen);
  }
  return seen;
}

/** Whether a job can write anything or reach a deployment environment. */
const isPrivileged = (job) =>
  job.environment !== undefined ||
  Object.values(job.permissions ?? {}).includes("write");

describe("the release workflow's tag signature gate", () => {
  it("has one step that verifies the tag with git", () => {
    expect(verifyingSteps).toHaveLength(1);
  });

  it("verifies the pushed tag, fetched from this repository", () => {
    expect(gateStep?.env?.ALCOVE_TAG).toBe("${{ github.ref_name }}");
    expect(gateStep?.env?.ALCOVE_REPOSITORY_URL).toBe(
      "${{ github.server_url }}/${{ github.repository }}.git",
    );
  });

  it("runs on a tag push only, with read access alone", () => {
    expect(jobs[gateJob]?.if).toBe("${{ github.event_name == 'push' }}");
    expect(jobs[gateJob]?.permissions).toEqual({ contents: "read" });
  });

  it("is a need of the publish job", () => {
    expect([jobs.publish?.needs].flat()).toContain(gateJob);
  });

  it("gates every job that holds a write permission or an environment", () => {
    const privileged = Object.keys(jobs).filter((name) =>
      isPrivileged(jobs[name]),
    );
    expect(privileged).toContain("publish");
    const ungated = privileged.filter(
      (name) => gateJob === undefined || !upstream(name).has(gateJob),
    );
    expect(ungated).toEqual([]);
  });
});

describe("the tag signature gate run against a repository", () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-tag-signature-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  // No user or system git configuration reaches the fixture or the step.
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
  const origin = join(scratch, "origin");
  const git = (...args) =>
    execFileSync("git", ["-C", origin, ...args], {
      encoding: "utf8",
      env: gitEnv,
    }).trim();

  const keyPair = (name) => {
    const path = join(scratch, name);
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      name,
      "-f",
      path,
    ]);
    const publicKey = readFileSync(`${path}.pub`, "utf8").trim();
    return { path, signer: `${name}@example.com ${publicKey}\n` };
  };
  const maintainer = keyPair("maintainer");
  const added = keyPair("added");

  const writeSigners = (text) =>
    writeFileSync(join(origin, "allowed_signers"), text);
  const signTag = (tag, key) =>
    git(
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${key.path}`,
      "tag",
      "-s",
      tag,
      "-m",
      tag,
    );

  // `main` lists the maintainer alone. v1.0.0 is the maintainer's signed tag
  // on it and v1.0.1 an unsigned one; v1.0.2 is signed by a key its own
  // commit adds to the file.
  mkdirSync(origin);
  git("init", "--quiet", "-b", "main");
  writeSigners(maintainer.signer);
  git("add", "allowed_signers");
  git("commit", "--quiet", "-m", "One signer");
  const mainCommit = git("rev-parse", "HEAD");
  signTag("v1.0.0", maintainer);
  git("tag", "v1.0.1");
  git("checkout", "--quiet", "-b", "release/v1.0.2");
  writeSigners(maintainer.signer + added.signer);
  git("commit", "--quiet", "-am", "Add a second signer");
  const addingCommit = git("rev-parse", "HEAD");
  signTag("v1.0.2", added);
  git("checkout", "--quiet", "main");

  let runs = 0;
  const runGate = (tag, sha) => {
    runs += 1;
    const runnerTemp = join(scratch, `runner-${runs}`);
    mkdirSync(runnerTemp);
    return spawnSync("bash", ["-c", gateStep.run], {
      encoding: "utf8",
      env: {
        ...gitEnv,
        RUNNER_TEMP: runnerTemp,
        GITHUB_SHA: sha,
        ALCOVE_TAG: tag,
        ALCOVE_REPOSITORY_URL: `file://${origin}`,
      },
    });
  };

  it("passes a tag signed by a key main lists", () => {
    const result = runGate("v1.0.0", mainCommit);
    expect(result.stdout + result.stderr).toMatch(
      /Good "git" signature for maintainer@example\.com/,
    );
    expect(result.status).toBe(0);
  });

  it("passes that tag when the run's SHA names the tag object", () => {
    const result = runGate("v1.0.0", git("rev-parse", "v1.0.0"));
    expect(result.status).toBe(0);
  });

  it("refuses a tag whose commit adds the key that signed it", () => {
    const result = runGate("v1.0.2", addingCommit);
    expect(result.stdout + result.stderr).toMatch(/No principal matched/);
    expect(result.status).not.toBe(0);
  });

  // The fixture's own control: that tag's signature is good against the
  // signers its own tree lists, so the refusal above comes from where the
  // gate reads them.
  it("would pass that tag against the signers its own tree lists", () => {
    const ownSigners = join(scratch, "own_signers");
    writeFileSync(ownSigners, git("show", "v1.0.2:allowed_signers") + "\n");
    const result = spawnSync(
      "git",
      [
        "-C",
        origin,
        "-c",
        `gpg.ssh.allowedSignersFile=${ownSigners}`,
        "verify-tag",
        "v1.0.2",
      ],
      { encoding: "utf8", env: gitEnv },
    );
    expect(result.stderr).toMatch(
      /Good "git" signature for added@example\.com/,
    );
    expect(result.status).toBe(0);
  });

  it("refuses an unsigned tag", () => {
    const result = runGate("v1.0.1", mainCommit);
    expect(result.status).not.toBe(0);
  });

  it("refuses a signed tag naming a commit other than the one the run builds", () => {
    const result = runGate("v1.0.0", addingCommit);
    expect(result.stdout).toMatch(/names \w+, but this run builds \w+/);
    expect(result.status).not.toBe(0);
  });
});
