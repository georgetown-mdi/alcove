import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { isOnNewestReleaseLine, tagsFromLsRemote } from "./release-line.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "release-line.mjs");

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
    for (const tag of ["v2.0.0-rc.1", "hosted-web-main-deploy", ""]) {
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
  // A lightweight tag can name a blob, which needs no commit identity.
  const blob = git(origin, ["hash-object", "-w", "--stdin"], "release\n");
  for (const tag of ["v1.4.2", "v1.4.3", "v2.0.0", "hosted-web-main-deploy"]) {
    git(origin, ["tag", tag, blob]);
  }

  const run = (tag) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: clone,
      encoding: "utf8",
      env: { ...process.env, ALCOVE_TAG: tag },
    });

  it("prints true for the newest release from the origin's tags", () => {
    const result = run("v2.0.0");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true\n");
  });

  it("prints false for a hotfix on an older line", () => {
    const result = run("v1.4.3");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("false\n");
    expect(result.stderr).toMatch(/older release line/);
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
  const stepById = (job, id) =>
    (document.jobs[job]?.steps ?? []).find((step) => step.id === id);

  it("decides it once, from the pushed tag", () => {
    const step = stepById("release-line", "decide");
    expect(step?.env?.ALCOVE_TAG).toBe("${{ github.ref_name }}");
    expect(step?.run).toContain("node scripts/release-line.mjs");
    expect(document.jobs["release-line"].outputs.newest).toBe(
      "${{ steps.decide.outputs.newest }}",
    );
  });

  it("deploys production only on the newest line", () => {
    const pages = document.jobs.pages;
    expect([pages.needs].flat()).toContain("release-line");
    expect(pages.if).toContain(`${NEWEST} == 'true'`);
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

  it("names `latest-fips` only on the newest line", () => {
    const step = stepById("publish", "fips_meta");
    expect(step.env.ALCOVE_NEWEST_LINE).toBe(`\${{ ${NEWEST} }}`);
    const tagsFor = (newest) => {
      const output = join(
        mkdtempSync(join(tmpdir(), "release-line-fips-")),
        "out",
      );
      execFileSync("bash", ["-c", step.run], {
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          ALCOVE_TAG: "v1.4.3",
          ALCOVE_NEWEST_LINE: newest,
        },
      });
      const lines = readFileSync(output, "utf8").trim().split("\n");
      rmSync(dirname(output), { recursive: true, force: true });
      return lines.slice(1, -1);
    };
    expect(tagsFor("true")).toEqual([
      "ghcr.io/georgetown-mdi/alcove:1.4.3-fips",
      "ghcr.io/georgetown-mdi/alcove:1.4-fips",
      "ghcr.io/georgetown-mdi/alcove:latest-fips",
    ]);
    expect(tagsFor("false")).toEqual([
      "ghcr.io/georgetown-mdi/alcove:1.4.3-fips",
      "ghcr.io/georgetown-mdi/alcove:1.4-fips",
    ]);
  });

  it("copies the Docker Hub `latest` tags only on the newest line", () => {
    const dockerhub = document.jobs.dockerhub;
    expect([dockerhub.needs].flat()).toContain("release-line");
    const step = dockerhub.steps.find((candidate) =>
      (candidate.run ?? "").includes("imagetools create"),
    );
    expect(step.env.ALCOVE_NEWEST_LINE).toBe(`\${{ ${NEWEST} }}`);
    expect(step.run).toMatch(
      /if \[ "\$\{ALCOVE_NEWEST_LINE\}" = "true" \]; then\n\s+tags\+=\("latest\$\{suffix\}"\)\n\s+fi/,
    );
    expect(step.run.match(/latest\$\{suffix\}/g)).toHaveLength(1);
  });

  it("creates the draft release not marked Latest off the newest line", () => {
    const launchers = document.jobs.launchers;
    expect([launchers.needs].flat()).toContain("release-line");
    const step = launchers.steps.find((candidate) =>
      (candidate.run ?? "").includes("gh release create"),
    );
    expect(step.env.ALCOVE_NEWEST_LINE).toBe(`\${{ ${NEWEST} }}`);
    expect(step.run).toMatch(
      /if \[ "\$\{ALCOVE_NEWEST_LINE\}" != "true" \]; then\n\s+latest_flag=\(--latest=false\)\n\s*fi/,
    );
    expect(step.run.match(/--latest/g)).toHaveLength(1);
    expect(step.run).toMatch(
      /gh release create [^\n]*\\\n\s+"\$\{latest_flag\[@\]\}"/,
    );
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
