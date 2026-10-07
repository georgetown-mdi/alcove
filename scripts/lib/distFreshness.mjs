// The apps import `@alcove/core` and `@alcove/cli-contract` from their built
// `dist/`, never from a package's `src`, so a run whose dist predates the
// sources it was built from tests yesterday's library and reports failures that
// belong to the build. This is the vitest `globalSetup` that turns that into one
// named error before a single test runs, in place of a suite-wide red no one can
// attribute.
//
// It is registered at the ROOT `test` block of each app's vitest config, which
// vitest runs once per run rather than per project, so a project added later is
// covered without touching it.
//
// Freshness is an mtime comparison, which reads the filesystem's clock rather
// than the build's inputs: it detects the ordinary staleness (an edited or
// checked-out source newer than the artifact) and cannot detect a dist built
// from a source that was later reverted to identical bytes. A build system's
// content hash would; the cost of one is not worth what it buys over a rebuild.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/** Opt-out to run against the dists as they stand. */
export const ALLOW_STALE_ENV = "ALCOVE_ALLOW_STALE_DIST";

const packageDir = (name) =>
  fileURLToPath(new URL(`../../packages/${name}/`, import.meta.url));

// Each package's `sources` are what its build reads. package.json is absent by
// design: npm rewrites it during some install flows, which would report
// staleness the build cannot resolve.

/** `packages/core`: rollup reads `src` and its own config. */
export const CORE_PACKAGE = {
  name: "@alcove/core",
  dir: packageDir("core"),
  sources: ["src", "rollup.config.ts"],
  buildCommand: "npm run build -w packages/core",
};

/** `packages/cli-contract`: `tsc -p tsconfig.build.json` over `src`. */
export const CLI_CONTRACT_PACKAGE = {
  name: "@alcove/cli-contract",
  dir: packageDir("cli-contract"),
  sources: ["src", "tsconfig.build.json"],
  buildCommand: "npm run build -w packages/cli-contract",
};

/**
 * The built packages the apps import, in build order: cli-contract's build
 * reads core's declarations.
 */
export const BUILT_PACKAGES = [CORE_PACKAGE, CLI_CONTRACT_PACKAGE];

/**
 * Every `./dist/...` path a package's manifest publishes, which is what an app
 * resolves when it imports the package. Derived from the manifest rather than
 * listed here so a new entry point is covered, and so a leftover artifact of an
 * older build that nothing exports cannot report staleness forever.
 */
export function distEntries(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const entries = new Set();
  const walk = (node) => {
    if (typeof node === "string") {
      if (node.startsWith("./dist/")) entries.add(node.slice(2));
      return;
    }
    if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(manifest.exports);
  return [...entries].sort();
}

// The newest file in a tree, or null where the path does not exist. Returns the
// path alongside the time so the error can name the file that outran the build.
function newestUnder(root, path) {
  let newest = null;
  const visit = (relPath) => {
    let stats;
    try {
      stats = statSync(join(root, relPath));
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const child of readdirSync(join(root, relPath))) {
        visit(join(relPath, child));
      }
      return;
    }
    if (newest === null || stats.mtimeMs > newest.mtimeMs) {
      newest = { path: relPath, mtimeMs: stats.mtimeMs };
    }
  };
  visit(path);
  return newest;
}

/**
 * `null` when the package's built dist is at least as new as every source it is
 * built from, otherwise what is wrong: `{ kind: "missing", missing }` for an
 * absent artifact, or `{ kind: "stale", source, dist }` naming the newest
 * source and the artifact it outran.
 */
export function describeDistStaleness(pkg) {
  const missing = [];
  let oldestDist = null;
  for (const entry of distEntries(pkg.dir)) {
    let stats;
    try {
      stats = statSync(join(pkg.dir, entry));
    } catch {
      missing.push(entry);
      continue;
    }
    if (oldestDist === null || stats.mtimeMs < oldestDist.mtimeMs) {
      oldestDist = { path: entry, mtimeMs: stats.mtimeMs };
    }
  }
  if (missing.length > 0) return { kind: "missing", missing };
  // An exports map with no dist entry at all: nothing to compare, and nothing
  // an app could be importing stale.
  if (oldestDist === null) return null;

  let newestSource = null;
  for (const path of pkg.sources) {
    const candidate = newestUnder(pkg.dir, path);
    if (candidate === null) continue;
    if (newestSource === null || candidate.mtimeMs > newestSource.mtimeMs) {
      newestSource = candidate;
    }
  }
  if (newestSource === null || newestSource.mtimeMs <= oldestDist.mtimeMs) {
    return null;
  }
  return { kind: "stale", source: newestSource, dist: oldestDist };
}

const stamp = (mtimeMs) => new Date(mtimeMs).toISOString();

/** One package's line of the error, locating each file from `cwd`. */
function describeCause(staleness, pkg, cwd) {
  const where = relative(cwd, pkg.dir) || pkg.dir;
  const at = (path) => join(where, path);
  return staleness.kind === "missing"
    ? `${pkg.name} has no built dist: ` +
        `${staleness.missing.map(at).join(", ")} ` +
        `${staleness.missing.length === 1 ? "is" : "are"} missing.`
    : `${pkg.name}'s built dist is older than its sources: ` +
        `${at(staleness.source.path)} (${stamp(staleness.source.mtimeMs)}) is newer ` +
        `than ${at(staleness.dist.path)} (${stamp(staleness.dist.mtimeMs)}).`;
}

/**
 * The operator-facing error text for the packages whose dist is not fresh,
 * each `{ pkg, staleness }` with `staleness` a {@link describeDistStaleness}
 * result. The rebuilds are listed in the order given.
 */
export function formatDistStaleness(findings, cwd = process.cwd()) {
  const causes = findings
    .map(({ pkg, staleness }) => describeCause(staleness, pkg, cwd))
    .join("\n");
  const rebuilds = findings
    .map(({ pkg }) => `    ${pkg.buildCommand}`)
    .join("\n");
  return (
    `${causes}\nThe suites import the built package, so this run would report ` +
    `failures that belong to the build rather than to the code under test. ` +
    `Rebuild first:\n\n${rebuilds}\n\n` +
    `Set ${ALLOW_STALE_ENV}=1 to run against the dist as it stands.`
  );
}

/**
 * Throws, before any test runs, when the dist of any of `packages` is missing
 * or older than its sources.
 */
export function requireFreshDists({
  packages = BUILT_PACKAGES,
  env = process.env,
} = {}) {
  if (env[ALLOW_STALE_ENV] === "1") return;
  const findings = packages
    .map((pkg) => ({ pkg, staleness: describeDistStaleness(pkg) }))
    .filter(({ staleness }) => staleness !== null);
  if (findings.length === 0) return;
  throw new Error(formatDistStaleness(findings));
}

/**
 * The vitest `globalSetup` entry point. It takes no options: vitest calls it
 * with its own project object, which is not this module's to read.
 */
export default function globalSetup() {
  requireFreshDists();
}
