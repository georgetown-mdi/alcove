import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// The launchers hold the image as a digest, and the release workflow is what
// fills that digest in. Both halves of that arrangement are silent when they
// break: a launcher whose placeholder line was reworded still reads fine, and a
// substitution that matches nothing still exits 0 -- leaving a
// release whose published launcher refuses to run in the operator's hands, or,
// worse, one that runs an image nobody pinned.
//
// So the boundary is pinned from both sides here: each launcher holds the
// placeholder line exactly once, and the release workflow's stamp step names
// that same path and that same line literally. A rename on either side fails
// this test rather than the release.
//
// What this cannot see: whether the stamped file the workflow writes is the one
// it uploads, and whether the digest it substitutes is the digest cosign signed.
// Those are properties of a run, not of the text; the workflow's own guard --
// refusing when the placeholder is not found exactly once, and again when one
// survives the substitution -- is what covers them, and its presence is pinned
// below.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const PLACEHOLDER = "@@ALCOVE_IMAGE_DIGEST@@";

// The fully qualified references: podman requires the registry prefix and docker
// accepts it, so both launchers name each repository in full rather than relying
// on a default. Both hold the stamped digest, which the release copies to Docker
// Hub with its signature.
const DOCKERHUB_REPOSITORY = "docker.io/gumdi/alcove";
const GHCR_REPOSITORY = "ghcr.io/georgetown-mdi/alcove";

const LAUNCHERS = [
  {
    path: "support/windows-network-filedrop/start-alcove.sh",
    digestLine: `ALCOVE_IMAGE_DIGEST='${PLACEHOLDER}'`,
    repositoryLines: [
      `ALCOVE_DOCKERHUB_REPOSITORY='${DOCKERHUB_REPOSITORY}'`,
      `ALCOVE_GHCR_REPOSITORY='${GHCR_REPOSITORY}'`,
    ],
  },
  {
    path: "support/windows-network-filedrop/Start-Alcove.ps1",
    digestLine: `$AlcoveImageDigest = '${PLACEHOLDER}'`,
    repositoryLines: [
      `$AlcoveDockerHubRepository = '${DOCKERHUB_REPOSITORY}'`,
      `$AlcoveGhcrRepository = '${GHCR_REPOSITORY}'`,
    ],
  },
];

const read = (relative) => readFileSync(resolve(repoRoot, relative), "utf8");

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const RELEASE_WORKFLOW = `${WORKFLOW_DIR}/release.yaml`;
const releaseWorkflow = read(RELEASE_WORKFLOW);
const releaseDocument = workflowDocument(repoRoot, RELEASE_WORKFLOW);

// Every `run:` script in the workflow, joined. The stamp step is identified by
// the literals it must hold rather than by its name, so renaming the step does
// not quietly move the assertions off it.
const runScripts = Object.values(releaseDocument.jobs)
  .flatMap((job) => job.steps ?? [])
  .map((step) => step.run)
  .filter((run) => typeof run === "string");

describe("the launcher digest stamp", () => {
  for (const launcher of LAUNCHERS) {
    describe(launcher.path, () => {
      const source = read(launcher.path);

      it("holds the placeholder on exactly one line", () => {
        // Exactly one, because the release step substitutes a whole line and
        // asserts the same count: a second occurrence -- a launcher comparing
        // its own digest against a literal copy of the token, say -- would make
        // that assertion fail and the release with it.
        expect(occurrences(source, PLACEHOLDER)).toBe(1);
        expect(source.split("\n")).toContain(launcher.digestLine);
      });

      it("names both fully qualified image repositories", () => {
        for (const line of launcher.repositoryLines)
          expect(source.split("\n")).toContain(line);
      });

      it("refuses an unstamped copy rather than falling back to a tag", () => {
        // The refusal is what makes the pin critical; without it an
        // unstamped copy would run whatever a floating tag resolves to today.
        // Held here as the absence of any floating tag in the file: a `:latest`
        // reference is the shape that regression takes.
        expect(source).not.toMatch(
          /(georgetown-mdi|gumdi)\/alcove:[A-Za-z0-9._-]+/,
        );
      });
    });
  }
});

describe("the release workflow's stamp step", () => {
  const stampScripts = runScripts.filter((run) => run.includes(PLACEHOLDER));

  it("substitutes the placeholder in exactly one step", () => {
    expect(stampScripts).toHaveLength(1);
  });

  const stamp = stampScripts[0] ?? "";

  for (const launcher of LAUNCHERS) {
    it(`names ${launcher.path} and the line it rewrites`, () => {
      expect(stamp).toContain(launcher.path);
      // The literal the step matches on. Reword the launcher's line without
      // rewording this one and the substitution silently matches nothing --
      // which is the failure this test exists for.
      expect(stamp).toContain(launcher.digestLine);
    });
  }

  it("fails the release when a launcher does not hold the placeholder", () => {
    // The step counts the placeholder line before substituting and exits
    // non-zero on anything but one occurrence, so a rename cannot no-op.
    expect(stamp).toMatch(/exit 1/);
  });

  it("fails the release when a placeholder survives the substitution", () => {
    // Read as a second, independent look at the output: the count above is
    // taken before the rewrite, this one after it.
    expect(stamp).toMatch(/grep[^\n]*\$\{ALCOVE_PLACEHOLDER\}/);
  });

  it("runs in a job whose write permission is scoped to it", () => {
    const writers = Object.entries(releaseDocument.jobs).filter(
      ([, job]) => job.permissions?.contents === "write",
    );
    // The other writer attaches the hosted app's manifest, and checks out no
    // repository code.
    expect(writers.map(([id]) => id).sort()).toEqual([
      "hosted-manifest-publish",
      "launchers",
    ]);
    const writer = releaseDocument.jobs.launchers;
    expect(writer.steps.map((step) => step.run ?? "")).toContain(stamp);
    const other = releaseDocument.jobs["hosted-manifest-publish"].steps;
    expect(other.map((step) => step.run ?? "")).not.toContain(stamp);
    expect(
      other.filter((step) => (step.uses ?? "").startsWith("actions/checkout@")),
    ).toEqual([]);
  });
});

describe("the stamp step's digest guard", () => {
  const stampStep = Object.values(releaseDocument.jobs)
    .flatMap((job) => job.steps ?? [])
    .find(
      (step) => typeof step.run === "string" && step.run.includes(PLACEHOLDER),
    );
  const stampScript = stampStep?.run ?? "";
  const WELL_FORMED_DIGEST = `sha256:${"a".repeat(64)}`;

  /** The step's script, run in an empty directory with the given digest. */
  function runStamp(digest) {
    const workingDirectory = mkdtempSync(join(tmpdir(), "stamp-guard-"));
    try {
      const result = spawnSync("bash", ["-c", stampScript], {
        cwd: workingDirectory,
        env: { PATH: process.env.PATH, ALCOVE_DIGEST: digest },
        encoding: "utf8",
      });
      return {
        status: result.status,
        stderr: result.stderr,
        wroteLaunchers: existsSync(join(workingDirectory, "launcher-assets")),
      };
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }

  it("takes the digest from the publish job's output", () => {
    expect(stampStep?.env?.ALCOVE_DIGEST).toBe(
      "${{ needs.publish.outputs.digest }}",
    );
  });

  for (const [label, digest] of [
    ["is empty", ""],
    ["lacks the sha256: prefix", "a".repeat(64)],
    ["is too short", `sha256:${"a".repeat(63)}`],
    ["is too long", `sha256:${"a".repeat(65)}`],
    ["has uppercase hex", `sha256:${"A".repeat(64)}`],
    ["has a non-hex character", `sha256:${"g".repeat(64)}`],
    ["has a trailing newline", `${WELL_FORMED_DIGEST}\n`],
  ]) {
    it(`fails with an error line before writing any launcher when the digest ${label}`, () => {
      const outcome = runStamp(digest);
      expect(outcome.status).not.toBe(0);
      expect(outcome.stderr).toMatch(/^::error::/m);
      expect(outcome.wroteLaunchers).toBe(false);
    });
  }

  it("passes the guard for a well-formed digest", () => {
    const outcome = runStamp(WELL_FORMED_DIGEST);
    expect(outcome.stderr).not.toMatch(/digest output is empty or not sha256/);
    expect(outcome.wroteLaunchers).toBe(true);
  });
});
