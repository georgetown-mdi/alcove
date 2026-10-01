import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OUT_OF_RANGE_BY_DESIGN,
  assess,
  classifyEdges,
  lookupPaths,
  readSpec,
  resolveCopy,
} from "./check-locked-dep-ranges.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const readRoot = (name) =>
  readFileSync(resolve(repoRoot, name), { encoding: "utf8" });
const committedLock = () => JSON.parse(readRoot("package-lock.json"));

/** A lockfile of the shape npm writes for this repository's workspaces. */
function lockfile(packages = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        name: "alcove-monorepo",
        workspaces: ["apps/web"],
        devDependencies: { tool: "^1.0.0" },
      },
      "apps/web": { name: "alcove-web", version: "0.0.0" },
      "node_modules/alcove-web": { resolved: "apps/web", link: true },
      "node_modules/tool": { version: "1.0.0", dev: true },
      ...packages,
    },
  };
}

/**
 * A root override forcing `lib` onto 5.0.0 under a requirer that declared
 * `range`: the forced copy hoisted to the root, the requirer nested beneath the
 * package that brought it in.
 */
const overrideForced = (range) =>
  lockfile({
    "node_modules/archiver-utils": {
      version: "5.0.2",
      dependencies: { minimatch: "^9.0.0" },
    },
    "node_modules/archiver-utils/node_modules/minimatch": {
      version: "9.0.9",
      dependencies: { lib: range },
    },
    "node_modules/lib": { version: "5.0.0" },
  });

const text = (result) => result.lines.join("\n");

describe("how an edge finds its locked copy", () => {
  it("walks up from the dependent's own directory, nearest first", () => {
    expect(lookupPaths("node_modules/@scope/a/node_modules/b", "dep")).toEqual([
      "node_modules/@scope/a/node_modules/b/node_modules/dep",
      "node_modules/@scope/a/node_modules/dep",
      "node_modules/@scope/node_modules/dep",
      "node_modules/dep",
    ]);
    expect(lookupPaths("apps/web", "dep")).toEqual([
      "apps/web/node_modules/dep",
      "apps/node_modules/dep",
      "node_modules/dep",
    ]);
    expect(lookupPaths("", "dep")).toEqual(["node_modules/dep"]);
  });

  it("takes a nested copy over the hoisted one", () => {
    const lock = lockfile({
      "node_modules/a": { version: "1.0.0", dependencies: { dep: "^2.0.0" } },
      "node_modules/a/node_modules/dep": { version: "2.1.0" },
      "node_modules/dep": { version: "1.0.0" },
    });
    expect(resolveCopy(lock, "node_modules/a", "dep").path).toBe(
      "node_modules/a/node_modules/dep",
    );
    expect(assess(lock, []).ok).toBe(true);
  });

  it("follows a workspace link to the workspace's own entry", () => {
    const lock = lockfile({
      "node_modules/user": {
        version: "1.0.0",
        peerDependencies: { "alcove-web": ">=1.0.0" },
      },
    });
    expect(resolveCopy(lock, "node_modules/user", "alcove-web").path).toBe(
      "apps/web",
    );
    expect(text(assess(lock, []))).toContain(
      'user@1.0.0 (node_modules/user) declares alcove-web ">=1.0.0" in peerDependencies, but the lockfile installs alcove-web@0.0.0 (apps/web).',
    );
  });

  it("reads an npm alias as the package and range it names", () => {
    expect(readSpec("h3-v2", "npm:h3@2.0.1-rc.20")).toEqual({
      target: "h3",
      range: "2.0.1-rc.20",
    });
    expect(readSpec("x", "npm:@scope/pkg@^1.0.0")).toEqual({
      target: "@scope/pkg",
      range: "^1.0.0",
    });
    expect(readSpec("core", "file:../../packages/core")).toEqual({
      source: true,
    });
  });
});

describe("the verdict over a lockfile", () => {
  it("fails on an override-forced dependent outside its range, naming the dependent, range and locked version", () => {
    const result = assess(overrideForced("^2.0.2"), []);
    expect(result.ok).toBe(false);
    expect(text(result)).toContain(
      'minimatch@9.0.9 (node_modules/archiver-utils/node_modules/minimatch) declares lib "^2.0.2" in dependencies, but the lockfile installs lib@5.0.0 (node_modules/lib).',
    );
    expect(text(result)).toContain("OUT_OF_RANGE_BY_DESIGN");
  });

  it("passes an override-forced dependent whose range admits the forced version", () => {
    const result = assess(overrideForced("^5.0.0"), []);
    expect(result.ok).toBe(true);
    expect(text(result)).toContain("0 out of range");
  });

  it("passes an out-of-range edge recorded with a reason", () => {
    const allowed = [
      {
        dependent: "minimatch",
        dependency: "lib",
        range: "^2.0.2",
        reason: "Forced by the root override on purpose.",
      },
    ];
    expect(assess(overrideForced("^2.0.2"), allowed).ok).toBe(true);
  });

  it("fails a recorded edge that carries no reason", () => {
    const allowed = [
      { dependent: "minimatch", dependency: "lib", range: "^2.0.2" },
    ];
    const result = assess(overrideForced("^2.0.2"), allowed);
    expect(result.ok).toBe(false);
    expect(text(result)).toContain("carries no reason");
  });

  it("fails a recorded edge that no longer lies out of range", () => {
    const allowed = [
      {
        dependent: "minimatch",
        dependency: "lib",
        range: "^2.0.2",
        reason: "Forced by the root override on purpose.",
      },
    ];
    const result = assess(overrideForced("^5.0.0"), allowed);
    expect(result.ok).toBe(false);
    expect(text(result)).toContain(
      'matches no out-of-range edge in the lockfile; delete it:\nminimatch -> lib "^2.0.2"',
    );
  });

  it("fails a required edge with no installed copy and skips an optional one", () => {
    const lock = lockfile({
      "node_modules/a": {
        version: "1.0.0",
        dependencies: { gone: "^1.0.0" },
        optionalDependencies: { "native-bits": "^1.0.0" },
        peerDependencies: { host: "^1.0.0", optionalHost: "^1.0.0" },
        peerDependenciesMeta: { optionalHost: { optional: true } },
      },
    });
    const result = assess(lock, []);
    expect(result.ok).toBe(false);
    expect(text(result)).toContain(
      'a@1.0.0 (node_modules/a) declares gone "^1.0.0" in dependencies, but the lockfile installs no copy it resolves to.',
    );
    expect(text(result)).toContain(
      'declares host "^1.0.0" in peerDependencies',
    );
    expect(text(result)).not.toContain("native-bits");
    expect(text(result)).not.toContain("optionalHost");
  });

  it("refuses a spec it cannot read as a range rather than passing it", () => {
    const lock = lockfile({
      "node_modules/a": {
        version: "1.0.0",
        dependencies: { dep: "github:owner/dep" },
      },
      "node_modules/dep": { version: "1.0.0" },
    });
    const result = assess(lock, []);
    expect(result.ok).toBe(false);
    expect(text(result)).toContain(
      'declares dep "github:owner/dep" in dependencies, a spec or locked version this check does not read.',
    );
  });

  it("fails an alias whose copy holds another package", () => {
    const lock = lockfile({
      "node_modules/a": {
        version: "1.0.0",
        dependencies: { "h3-v2": "npm:h3@^2.0.0" },
      },
      "node_modules/h3-v2": { name: "crossws", version: "2.0.0" },
    });
    expect(text(assess(lock, []))).toContain(
      "but the copy it resolves to (node_modules/h3-v2) is crossws.",
    );
  });

  it("reads a workspace's devDependencies and skips its file: sources", () => {
    const lock = lockfile({
      "apps/web": {
        name: "alcove-web",
        version: "0.0.0",
        dependencies: { "@alcove/core": "file:../../packages/core" },
        devDependencies: { tool: "^2.0.0" },
      },
    });
    const edges = classifyEdges(lock);
    expect(
      edges.find((edge) => edge.dependency === "@alcove/core").status,
    ).toBe("skipped");
    expect(text(assess(lock, []))).toContain(
      'alcove-web@0.0.0 (apps/web) declares tool "^2.0.0" in devDependencies, but the lockfile installs tool@1.0.0 (node_modules/tool).',
    );
  });

  it("refuses a lockfile with no packages map", () => {
    expect(assess({ lockfileVersion: 1 }).ok).toBe(false);
  });
});

describe("the committed tree", () => {
  it("passes, with the crossws optional peer its only out-of-range edge", () => {
    const result = assess(committedLock());
    expect(result.ok, text(result)).toBe(true);
    const outOfRange = classifyEdges(committedLock()).filter(
      (edge) => edge.status === "out-of-range",
    );
    expect(
      outOfRange.map(
        ({ dependent, dependency, range }) =>
          `${dependent} ${dependency} ${range}`,
      ),
    ).toEqual(["h3 crossws ^0.4.1"]);
  });

  it("fails naming the crossws edge once its record is gone", () => {
    const allowlist = OUT_OF_RANGE_BY_DESIGN.filter(
      (allowed) => allowed.dependency !== "crossws",
    );
    const result = assess(committedLock(), allowlist);
    expect(result.ok).toBe(false);
    expect(text(result)).toContain('declares crossws "^0.4.1"');
  });

  it("exits 0 as a script against the committed lockfile", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-locked-dep-ranges.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("Locked-version range check passed");
  });

  it("is wired as a check script and on the gate's list", () => {
    expect(JSON.parse(readRoot("package.json")).scripts).toHaveProperty(
      "check:locked-dep-ranges",
      "node scripts/check-locked-dep-ranges.mjs",
    );
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:locked-dep-ranges",
    );
  });

  it("is what the overrides record names as the guard", () => {
    expect(readRoot("docs/spec/DEPENDENCY_PINS.md")).toContain(
      "scripts/check-locked-dep-ranges.mjs",
    );
  });
});
