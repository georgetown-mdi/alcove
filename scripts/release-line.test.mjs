import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { releaseLine, tagsFromLsRemote } from "./release-line.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "release-line.mjs");

const isOnNewestReleaseLine = (tag, tags) => releaseLine(tag, tags).newest;

describe("whether a release tag is on the newest release line", () => {
  it("is for a tag naming the highest release version", () => {
    expect(
      isOnNewestReleaseLine("v2.1.0", ["v1.4.2", "v2.0.0", "v2.0.1", "v2.1.0"]),
    ).toBe(true);
  });

  it("is not for a hotfix on the previous major", () => {
    expect(
      isOnNewestReleaseLine("v1.4.3", ["v1.4.2", "v1.4.3", "v2.0.0"]),
    ).toBe(false);
  });

  it("is not for a patch on an older minor of the same major", () => {
    expect(isOnNewestReleaseLine("v2.0.2", ["v2.0.2", "v2.1.0"])).toBe(false);
  });

  it("orders by version, not by the text of the tag", () => {
    expect(isOnNewestReleaseLine("v1.10.0", ["v1.9.9", "v1.10.0"])).toBe(true);
    expect(isOnNewestReleaseLine("v1.9.9", ["v1.9.9", "v1.10.0"])).toBe(false);
  });

  it("does not count a pre-release tag as a newer line", () => {
    expect(isOnNewestReleaseLine("v1.4.0", ["v1.4.0", "v2.0.0-rc.1"])).toBe(
      true,
    );
    expect(
      isOnNewestReleaseLine("v0.9.0", [
        "v0.9.0-beta.1",
        "v0.9.0",
        "v1.0.0-rc.1",
      ]),
    ).toBe(true);
  });

  it("is a release, not a prerelease, for a vX.Y.Z tag", () => {
    expect(releaseLine("v0.9.0", ["v0.9.0"])).toEqual({
      newest: true,
      prerelease: false,
    });
    expect(releaseLine("v1.4.3", ["v1.4.3", "v2.0.0"])).toEqual({
      newest: false,
      prerelease: false,
    });
  });

  it("is a prerelease never on the newest line, so it moves no floating tag", () => {
    for (const tag of ["v0.9.0-beta.1", "v0.9.0-rc.1", "v10.0.0-rc.12"]) {
      expect(releaseLine(tag, [tag])).toEqual({
        newest: false,
        prerelease: true,
      });
      expect(releaseLine(tag, [])).toEqual({ newest: false, prerelease: true });
    }
  });

  it("is for the first release, with no other release tag", () => {
    expect(isOnNewestReleaseLine("v0.1.0", ["v0.1.0"])).toBe(true);
    expect(isOnNewestReleaseLine("v0.1.0", [])).toBe(true);
  });

  it("ignores every tag that is not a release tag", () => {
    expect(
      isOnNewestReleaseLine("v0.2.0", [
        "broker-core-build",
        "hosted-web-main-deploy",
        "v9",
        "v0.2.0",
      ]),
    ).toBe(true);
  });

  it("refuses a tag that names no release version", () => {
    for (const tag of [
      "v0.9.0-beta",
      "v0.9.0-beta1",
      "v0.9.0-alpha.1",
      "v0.9.0-rc.0",
      "v0.9.0-rc.01",
      "v0.9.0-rc.1.2",
      "v2.0.0-rc1",
      "hosted-web-main-deploy",
      "",
    ]) {
      expect(() => isOnNewestReleaseLine(tag, ["v1.0.0"])).toThrow(
        /is not a release tag/,
      );
    }
  });
});

describe("the tags `git ls-remote --tags --refs` lists", () => {
  it("are read by name, one per line", () => {
    expect(
      tagsFromLsRemote(
        "310f013ca8d6c3755b7133a17819a198af091a91\trefs/tags/v0.1.0\n" +
          "51dc31609044c83b4b54035215b15c851218339d\trefs/tags/broker-core-build\n",
      ),
    ).toEqual(["v0.1.0", "broker-core-build"]);
    expect(tagsFromLsRemote("")).toEqual([]);
  });
});

describe("the release-line script run against a repository", () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-line-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const origin = join(scratch, "origin.git");
  const clone = join(scratch, "clone");
  const git = (cwd, args, input) =>
    execFileSync("git", args, { cwd, encoding: "utf8", input }).trim();
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  execFileSync("git", ["init", "--quiet", clone]);
  git(clone, ["remote", "add", "origin", origin]);
  // A lightweight tag can name a blob, which needs no commit identity; written
  // as a ref, so a `tag.gpgSign` setting does not turn it into a signed tag.
  const blob = git(origin, ["hash-object", "-w", "--stdin"], "release\n");
  for (const tag of [
    "v1.4.2",
    "v1.4.3",
    "v2.0.0",
    "v2.1.0-beta.1",
    "hosted-web-main-deploy",
  ]) {
    git(origin, ["update-ref", `refs/tags/${tag}`, blob]);
  }

  const run = (tag) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: clone,
      encoding: "utf8",
      env: { ...process.env, ALCOVE_TAG: tag },
    });

  it("prints newest for the newest release from the origin's tags", () => {
    const result = run("v2.0.0");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("newest=true\nprerelease=false\n");
  });

  it("prints not newest for a hotfix on an older line", () => {
    const result = run("v1.4.3");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("newest=false\nprerelease=false\n");
    expect(result.stderr).toMatch(/older release line/);
  });

  it("prints a prerelease, not newest, for each prerelease form", () => {
    for (const tag of ["v2.1.0-beta.1", "v2.1.0-rc.1"]) {
      const result = run(tag);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("newest=false\nprerelease=true\n");
      expect(result.stderr).toMatch(/is a prerelease/);
    }
  });

  it("fails on a malformed prerelease tag, printing nothing", () => {
    for (const tag of ["v2.1.0-beta", "v2.1.0-beta1", "v2.1.0-alpha.1"]) {
      const result = run(tag);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/is not a release tag/);
    }
  });

  it("exits with usage when no tag is given", () => {
    const result = run("");
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});

describe("the release-line job's install-free run", () => {
  it("loads from a copy of scripts/ with no node_modules above it", () => {
    const copy = mkdtempSync(join(tmpdir(), "release-line-bare-"));
    try {
      cpSync(here, join(copy, "scripts"), {
        recursive: true,
        filter: (source) => !source.split(sep).includes("node_modules"),
      });
      const result = spawnSync(
        process.execPath,
        [join(copy, "scripts", "release-line.mjs")],
        {
          cwd: copy,
          encoding: "utf8",
          env: { ...process.env, ALCOVE_TAG: "v1.0.0" },
        },
      );
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.stderr).not.toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe("the release workflow's use of the answer", () => {
  const document = workflowDocument(repoRoot, `${WORKFLOW_DIR}/release.yaml`);
  const NEWEST = "needs.release-line.outputs.newest";
  const PRERELEASE = "needs.release-line.outputs.prerelease";
  const stepById = (job, id) =>
    (document.jobs[job]?.steps ?? []).find((step) => step.id === id);

  it("decides it once, from the pushed tag", () => {
    const step = stepById("release-line", "decide");
    expect(step?.env?.ALCOVE_TAG).toBe("${{ github.ref_name }}");
    expect(step?.run).toContain(
      'node scripts/release-line.mjs >>"$GITHUB_OUTPUT"',
    );
    expect(document.jobs["release-line"].outputs).toEqual({
      newest: "${{ steps.decide.outputs.newest }}",
      prerelease: "${{ steps.decide.outputs.prerelease }}",
    });
  });

  it("deploys production only on the newest line, never for a prerelease", () => {
    const pages = document.jobs.pages;
    expect([pages.needs].flat()).toContain("release-line");
    expect(pages.if).toContain(`${NEWEST} == 'true'`);
    expect(pages.if).toContain(`${PRERELEASE} == 'false'`);
  });

  it("adds `latest` to the ghcr.io image only on the newest line", () => {
    const meta = stepById("publish", "meta");
    expect(meta.with.flavor.trim()).toBe("latest=false");
    const latestLines = meta.with.tags
      .split("\n")
      .filter((line) => /\blatest\b/.test(line));
    expect(latestLines).toEqual([
      `type=raw,value=latest,enable=\${{ ${NEWEST} == 'true' }}`,
    ]);
  });

  it("adds `X.Y` to the ghcr.io image only for a release", () => {
    const meta = stepById("publish", "meta");
    const minorLines = meta.with.tags
      .split("\n")
      .filter((line) => line.includes("{{minor}}"));
    expect(minorLines).toEqual([
      `type=semver,pattern={{major}}.{{minor}},enable=\${{ ${PRERELEASE} == 'false' }}`,
    ]);
  });

  it("names `latest-fips` only on the newest line, and `X.Y-fips` only for a release", () => {
    const step = stepById("publish", "fips_meta");
    expect(step.env.ALCOVE_NEWEST_LINE).toBe(`\${{ ${NEWEST} }}`);
    expect(step.env.ALCOVE_PRERELEASE).toBe(`\${{ ${PRERELEASE} }}`);
    const tagsFor = (tag, newest, prerelease) => {
      const output = join(
        mkdtempSync(join(tmpdir(), "release-line-fips-")),
        "out",
      );
      execFileSync("bash", ["-c", step.run], {
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          ALCOVE_TAG: tag,
          ALCOVE_NEWEST_LINE: newest,
          ALCOVE_PRERELEASE: prerelease,
        },
      });
      const lines = readFileSync(output, "utf8").trim().split("\n");
      rmSync(dirname(output), { recursive: true, force: true });
      return lines.slice(1, -1);
    };
    expect(tagsFor("v1.4.3", "true", "false")).toEqual([
      "ghcr.io/georgetown-mdi/alcove:1.4.3-fips",
      "ghcr.io/georgetown-mdi/alcove:1.4-fips",
      "ghcr.io/georgetown-mdi/alcove:latest-fips",
    ]);
    expect(tagsFor("v1.4.3", "false", "false")).toEqual([
      "ghcr.io/georgetown-mdi/alcove:1.4.3-fips",
      "ghcr.io/georgetown-mdi/alcove:1.4-fips",
    ]);
    for (const tag of ["v0.9.0-beta.1", "v0.9.0-rc.1"]) {
      expect(tagsFor(tag, "false", "true")).toEqual([
        `ghcr.io/georgetown-mdi/alcove:${tag.slice(1)}-fips`,
      ]);
    }
    // An answer that did not arrive moves no floating tag.
    expect(tagsFor("v1.4.3", "", "")).toEqual([
      "ghcr.io/georgetown-mdi/alcove:1.4.3-fips",
    ]);
  });

  it("copies `latest` to Docker Hub only on the newest line, and `X.Y` only for a release", () => {
    const dockerhub = document.jobs.dockerhub;
    expect([dockerhub.needs].flat()).toContain("release-line");
    const step = dockerhub.steps.find((candidate) =>
      (candidate.run ?? "").includes("imagetools create"),
    );
    expect(step.env.ALCOVE_NEWEST_LINE).toBe(`\${{ ${NEWEST} }}`);
    expect(step.env.ALCOVE_PRERELEASE).toBe(`\${{ ${PRERELEASE} }}`);
    const DEFAULT_DIGEST = `sha256:${"a".repeat(64)}`;
    const FIPS_DIGEST = `sha256:${"b".repeat(64)}`;
    // docker answers an inspect with the digest the copy was made from, and
    // logs each tag a create names.
    const stubs = [
      "docker() {",
      '  if [ "$3" = "create" ]; then',
      '    for argument in "$@"; do echo "$argument"; done >>"$ALCOVE_DOCKER_LOG"',
      '  elif [ "$3" = "inspect" ]; then',
      `    case "$4" in *-fips) echo "${FIPS_DIGEST}" ;; *) echo "${DEFAULT_DIGEST}" ;; esac`,
      "  fi",
      "}",
      "jq() { cat; }",
      "",
    ].join("\n");
    const copiedFor = (tag, newest, prerelease) => {
      const scratch = mkdtempSync(join(tmpdir(), "release-line-hub-"));
      const log = join(scratch, "docker");
      writeFileSync(log, "");
      execFileSync("bash", ["-c", stubs + step.run], {
        env: {
          PATH: process.env.PATH,
          GITHUB_STEP_SUMMARY: join(scratch, "summary"),
          GHCR_REPOSITORY: "ghcr.io/georgetown-mdi/alcove",
          DOCKERHUB_REPOSITORY: "docker.io/gumdi/alcove",
          ALCOVE_DOCKER_LOG: log,
          ALCOVE_TAG: tag,
          ALCOVE_NEWEST_LINE: newest,
          ALCOVE_PRERELEASE: prerelease,
          DEFAULT_DIGEST,
          FIPS_DIGEST,
        },
      });
      const copied = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("docker.io/gumdi/alcove:"))
        .map((line) => line.slice("docker.io/gumdi/alcove:".length));
      rmSync(scratch, { recursive: true, force: true });
      return copied;
    };
    expect(copiedFor("v1.4.3", "true", "false")).toEqual([
      "1.4.3",
      "1.4",
      "latest",
      "1.4.3-fips",
      "1.4-fips",
      "latest-fips",
    ]);
    expect(copiedFor("v1.4.3", "false", "false")).toEqual([
      "1.4.3",
      "1.4",
      "1.4.3-fips",
      "1.4-fips",
    ]);
    expect(copiedFor("v0.9.0-beta.1", "false", "true")).toEqual([
      "0.9.0-beta.1",
      "0.9.0-beta.1-fips",
    ]);
    expect(copiedFor("v1.4.3", "", "")).toEqual(["1.4.3", "1.4.3-fips"]);
  });

  it("creates the draft release not marked Latest off the newest line, and a prerelease as one", () => {
    const launchers = document.jobs.launchers;
    expect([launchers.needs].flat()).toContain("release-line");
    const step = launchers.steps.find((candidate) =>
      (candidate.run ?? "").includes("gh release create"),
    );
    expect(step.env.ALCOVE_NEWEST_LINE).toBe(`\${{ ${NEWEST} }}`);
    expect(step.env.ALCOVE_PRERELEASE).toBe(`\${{ ${PRERELEASE} }}`);
    // gh answers that no release exists yet and logs the create it is given.
    const stubs = [
      "gh() {",
      '  if [ "$2" = "create" ]; then',
      '    for argument in "$@"; do echo "$argument"; done >>"$ALCOVE_GH_LOG"',
      "  fi",
      '  [ "$2" != "view" ]',
      "}",
      "",
    ].join("\n");
    const createdWith = (newest, prerelease) => {
      const scratch = mkdtempSync(join(tmpdir(), "release-line-gh-"));
      const log = join(scratch, "gh");
      writeFileSync(log, "");
      execFileSync("bash", ["-c", stubs + step.run], {
        env: {
          PATH: process.env.PATH,
          ALCOVE_GH_LOG: log,
          ALCOVE_TAG: "v0.9.0-beta.1",
          ALCOVE_NEWEST_LINE: newest,
          ALCOVE_PRERELEASE: prerelease,
        },
      });
      const flags = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) =>
          [
            "--draft",
            "--verify-tag",
            "--latest=false",
            "--prerelease",
          ].includes(line),
        );
      rmSync(scratch, { recursive: true, force: true });
      return flags;
    };
    const DRAFT = ["--draft", "--verify-tag"];
    expect(createdWith("true", "false")).toEqual(DRAFT);
    expect(createdWith("false", "false")).toEqual([...DRAFT, "--latest=false"]);
    expect(createdWith("false", "true")).toEqual([
      ...DRAFT,
      "--latest=false",
      "--prerelease",
    ]);
    // An answer that did not arrive creates a prerelease not marked Latest.
    expect(createdWith("", "")).toEqual([
      ...DRAFT,
      "--latest=false",
      "--prerelease",
    ]);
  });

  it("reads the prerelease answer in every step that derives an `X.Y` tag", () => {
    const unguarded = [];
    for (const [jobId, job] of Object.entries(document.jobs)) {
      for (const step of job.steps ?? []) {
        const text = JSON.stringify({ with: step.with, run: step.run });
        if (
          /\{\{minor\}\}|%\.\*/.test(text) &&
          !JSON.stringify(step).includes(PRERELEASE)
        ) {
          unguarded.push(`${jobId}: ${step.name ?? step.uses}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
  });

  it("reads the answer in every step that names a `latest` tag", () => {
    const unguarded = [];
    for (const [jobId, job] of Object.entries(document.jobs)) {
      for (const step of job.steps ?? []) {
        const text = JSON.stringify({ with: step.with, run: step.run });
        if (/\blatest\b/.test(text) && !JSON.stringify(step).includes(NEWEST)) {
          unguarded.push(`${jobId}: ${step.name ?? step.uses}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
  });
});
