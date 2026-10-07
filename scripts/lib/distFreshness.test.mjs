import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ALLOW_STALE_ENV,
  BUILT_PACKAGES,
  CLI_CONTRACT_PACKAGE,
  CORE_PACKAGE,
  describeDistStaleness,
  distEntries,
  formatDistStaleness,
  requireFreshDists,
} from "./distFreshness.mjs";

// Fixture packages standing in for packages/core and packages/cli-contract: the
// same exports shapes, with every mtime set explicitly so the comparison is
// driven rather than raced.

const BUILT_AT = new Date("2026-01-02T00:00:00Z");
const BEFORE_BUILD = new Date("2026-01-01T00:00:00Z");
const AFTER_BUILD = new Date("2026-01-03T00:00:00Z");

let root;
let core;
let contract;

function write(pkg, relPath, mtime) {
  const path = join(pkg.dir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `// ${relPath}\n`);
  utimesSync(path, mtime, mtime);
}

function fixturePackage(real, exports, sources, dist) {
  const pkg = { ...real, dir: join(root, real.name.replace("@alcove/", "")) };
  mkdirSync(pkg.dir, { recursive: true });
  writeFileSync(
    join(pkg.dir, "package.json"),
    JSON.stringify({ name: real.name, exports }),
  );
  for (const source of sources) write(pkg, source, BEFORE_BUILD);
  for (const entry of dist) write(pkg, entry, BUILT_AT);
  return pkg;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "alcove-dist-"));
  core = fixturePackage(
    CORE_PACKAGE,
    {
      ".": {
        import: "./dist/core.esm.js",
        require: "./dist/core.cjs",
        types: "./dist/index.d.ts",
      },
      "./testing": { import: "./dist/testing.esm.js" },
    },
    ["src/main.ts", "src/config/connection.ts", "rollup.config.ts"],
    [
      "dist/core.esm.js",
      "dist/core.cjs",
      "dist/index.d.ts",
      "dist/testing.esm.js",
    ],
  );
  contract = fixturePackage(
    CLI_CONTRACT_PACKAGE,
    { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    ["src/index.ts", "src/warningSources.ts", "tsconfig.build.json"],
    ["dist/index.d.ts", "dist/index.js"],
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function thrownMessage(run) {
  try {
    run();
  } catch (error) {
    return error.message;
  }
  return null;
}

describe("distEntries", () => {
  test("takes every dist path the exports map publishes", () => {
    expect(distEntries(core.dir)).toEqual([
      "dist/core.cjs",
      "dist/core.esm.js",
      "dist/index.d.ts",
      "dist/testing.esm.js",
    ]);
  });

  test.each(BUILT_PACKAGES)(
    "reads the real $name manifest, which the guard runs against",
    (pkg) => {
      const entries = distEntries(pkg.dir);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(entry.startsWith("dist/")).toBe(true);
    },
  );
});

describe("describeDistStaleness", () => {
  test("a dist built after every source is fresh", () => {
    expect(describeDistStaleness(core)).toBeNull();
    expect(describeDistStaleness(contract)).toBeNull();
  });

  test("a source written at the same instant as the dist is fresh", () => {
    write(core, "src/main.ts", BUILT_AT);
    expect(describeDistStaleness(core)).toBeNull();
  });

  test("a source newer than the dist is stale, naming both files", () => {
    write(core, "src/config/connection.ts", AFTER_BUILD);
    expect(describeDistStaleness(core)).toEqual({
      kind: "stale",
      source: {
        path: "src/config/connection.ts",
        mtimeMs: AFTER_BUILD.getTime(),
      },
      dist: expect.objectContaining({ mtimeMs: BUILT_AT.getTime() }),
    });
  });

  test.each([
    ["core", () => core, "rollup.config.ts"],
    ["cli-contract", () => contract, "tsconfig.build.json"],
  ])("%s's build config counts as a source", (_, pkg, config) => {
    write(pkg(), config, AFTER_BUILD);
    expect(describeDistStaleness(pkg())).toMatchObject({
      kind: "stale",
      source: { path: config },
    });
  });

  test("each package is judged by its own sources only", () => {
    write(contract, "src/warningSources.ts", AFTER_BUILD);
    expect(describeDistStaleness(core)).toBeNull();
    expect(describeDistStaleness(contract)).toMatchObject({
      kind: "stale",
      source: { path: "src/warningSources.ts" },
    });
  });

  test("a half-written dist is missing, not stale", () => {
    rmSync(join(core.dir, "dist/core.cjs"));
    rmSync(join(core.dir, "dist/testing.esm.js"));
    expect(describeDistStaleness(core)).toEqual({
      kind: "missing",
      missing: ["dist/core.cjs", "dist/testing.esm.js"],
    });
  });

  // A build that stops emitting an artifact leaves the old copy behind. Judging
  // freshness by the exports map rather than by whatever sits in dist/ keeps
  // that leftover from reporting staleness no rebuild can clear.
  test("a leftover artifact the exports map does not publish is ignored", () => {
    write(core, "dist/leftover.js", BEFORE_BUILD);
    expect(describeDistStaleness(core)).toBeNull();
  });
});

describe("requireFreshDists", () => {
  const run =
    (env = {}) =>
    () =>
      requireFreshDists({ packages: [core, contract], env });

  test("guards core and cli-contract by default, core first", () => {
    expect(BUILT_PACKAGES).toEqual([CORE_PACKAGE, CLI_CONTRACT_PACKAGE]);
  });

  test("passes fresh dists through", () => {
    expect(run()).not.toThrow();
  });

  test("names core's rebuild alone when only core's dist is stale", () => {
    write(core, "src/main.ts", AFTER_BUILD);
    const message = thrownMessage(run());
    expect(message).toContain(CORE_PACKAGE.buildCommand);
    expect(message).toMatch(/older than its sources/);
    expect(message).not.toContain(CLI_CONTRACT_PACKAGE.buildCommand);
  });

  test("names cli-contract's rebuild when its dist is stale", () => {
    write(contract, "src/index.ts", AFTER_BUILD);
    const message = thrownMessage(run());
    expect(message).toContain(CLI_CONTRACT_PACKAGE.buildCommand);
    expect(message).toContain("@alcove/cli-contract's built dist");
  });

  test("names the rebuild when a dist was never built", () => {
    rmSync(join(contract.dir, "dist"), { recursive: true });
    expect(run()).toThrow(CLI_CONTRACT_PACKAGE.buildCommand);
  });

  test("names both rebuilds, core first, when both are stale", () => {
    write(core, "src/main.ts", AFTER_BUILD);
    write(contract, "src/index.ts", AFTER_BUILD);
    const message = thrownMessage(run());
    const coreAt = message.indexOf(CORE_PACKAGE.buildCommand);
    expect(coreAt).toBeGreaterThan(-1);
    expect(message.indexOf(CLI_CONTRACT_PACKAGE.buildCommand)).toBeGreaterThan(
      coreAt,
    );
  });

  test("the opt-out runs against the dists as they stand", () => {
    write(core, "src/main.ts", AFTER_BUILD);
    write(contract, "src/index.ts", AFTER_BUILD);
    expect(run({ [ALLOW_STALE_ENV]: "1" })).not.toThrow();
  });

  test("only the exact opt-out value opts out", () => {
    write(core, "src/main.ts", AFTER_BUILD);
    expect(run({ [ALLOW_STALE_ENV]: "yes" })).toThrow(
      CORE_PACKAGE.buildCommand,
    );
  });
});

describe("formatDistStaleness", () => {
  const at = (pkg, dir) => [
    { pkg: { ...pkg, dir }, staleness: describeDistStaleness(pkg) },
  ];

  test("locates each file from the directory the run was started in", () => {
    write(core, "src/main.ts", AFTER_BUILD);
    const message = formatDistStaleness(
      at(core, "/repo/packages/core"),
      "/repo/apps/cli",
    );
    expect(message).toContain("../../packages/core/src/main.ts");
    expect(message).toContain("../../packages/core/dist/");
    expect(message).toContain(ALLOW_STALE_ENV);
  });

  test("names every missing artifact", () => {
    rmSync(join(core.dir, "dist/index.d.ts"));
    const message = formatDistStaleness(
      at(core, "/repo/packages/core"),
      "/repo",
    );
    expect(message).toContain("packages/core/dist/index.d.ts");
    expect(message).toContain(CORE_PACKAGE.buildCommand);
  });
});
