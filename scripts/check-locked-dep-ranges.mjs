#!/usr/bin/env node
// Locked-version range check, run by static_checks.yaml on every PR.
//
// A root `overrides` entry forces every dependent of a package onto the
// overridden version, whatever range the dependent declared. Where that range
// excludes the forced version the dependent gets code it was not written
// against -- docs/spec/DEPENDENCY_PINS.md, "What a root overrides block
// changes about later installs", measures the TypeError that follows -- and npm
// 11.19.1 does not mark such an edge `invalid` in `npm ls --all`, so nothing at
// install, audit or listing time names it. It shows only when the dependent's
// code runs.
//
// So this fails on any edge in the committed lockfile whose locked version lies
// outside the range the dependent declared, naming the dependent, the declared
// range and the locked version. Every dependent the lockfile records is read:
// the root project, each workspace, and each installed package, over its
// dependencies, devDependencies, optionalDependencies and peerDependencies.
// OUT_OF_RANGE_BY_DESIGN is where an edge that is meant to stand is recorded,
// with its reason; an entry matching no out-of-range edge fails too, so an
// excuse cannot outlive the edge it was written for.
//
// What it reads: the committed package-lock.json, whose entries record each
// manifest's declared ranges. Files only -- no install, no registry, no network.
//
// What it cannot see:
//   - It compares the declared range with the locked version and nothing else.
//     It does not model npm's resolution, hoisting or override application, so
//     it cannot say which override forced an edge or what npm would resolve
//     without one; only regenerating the lockfile answers that.
//   - It finds the copy an edge resolves to the way Node's module lookup does:
//     the nearest `node_modules/<name>` walking up from the dependent's own
//     directory, following a workspace link to the workspace's entry.
//   - A `file:`, `link:` or `workspace:` spec names a source rather than a
//     version range, so that edge is skipped. Any other spec semver cannot read
//     as a range is REFUSED by name rather than passed.
//   - An optional dependency or an optional peer the lockfile does not install
//     is skipped; a required edge with no installed copy fails.
//   - Range matching is node-semver's `satisfies` with its default options.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

import { installedAs, packageIdentity } from "./lib/lockfile.mjs";

const SCRIPT = "scripts/check-locked-dep-ranges.mjs";
const ALIAS_PREFIX = "npm:";
const SOURCE_PREFIXES = ["file:", "link:", "workspace:"];
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * The out-of-range edges that are meant to stand, each keyed by the dependent's
 * package name, the dependency, and the range declared, with the reason it
 * stands. The dependent's version and the locked version are left out of the
 * key so a patch release on either side does not churn the entry; a new
 * dependent, or a new range, is a new edge and fails until recorded.
 */
export const OUT_OF_RANGE_BY_DESIGN = [];

/** The package a lockfile entry holds: its `name` field, else its directory. */
const identity = (path, entry) => packageIdentity(installedAs(path), entry);

/**
 * The lockfile paths Node's lookup tries for `name` from a dependent at
 * `path`, nearest first: `node_modules/<name>` under the dependent's own
 * directory and under each ancestor that is not itself a node_modules
 * directory, ending at the root's.
 */
export function lookupPaths(path, name) {
  const candidates = [];
  const segments = path === "" ? [] : path.split("/");
  for (let depth = segments.length; depth >= 0; depth--) {
    const directory = segments.slice(0, depth);
    if (directory.at(-1) === "node_modules") continue;
    candidates.push([...directory, "node_modules", name].join("/"));
  }
  return candidates;
}

/**
 * The installed copy an edge on `name` from `path` resolves to, as `{path,
 * entry}` with a workspace link followed to the workspace's own entry, or null
 * when the lockfile installs none on the lookup path.
 */
export function resolveCopy(lock, path, name) {
  for (const candidate of lookupPaths(path, name)) {
    const entry = lock.packages[candidate];
    if (entry === undefined) continue;
    if (entry.link === true && typeof entry.resolved === "string") {
      return { path: entry.resolved, entry: lock.packages[entry.resolved] };
    }
    return { path: candidate, entry };
  }
  return null;
}

/**
 * What an edge's spec asks for: `{source: true}` for a spec naming a source
 * rather than a version, else `{target, range}` -- the package the copy must be
 * and the range its version must satisfy. An `npm:` alias names both.
 */
export function readSpec(dependency, spec) {
  if (SOURCE_PREFIXES.some((prefix) => spec.startsWith(prefix))) {
    return { source: true };
  }
  if (spec.startsWith(ALIAS_PREFIX)) {
    const rest = spec.slice(ALIAS_PREFIX.length);
    const separator = rest.lastIndexOf("@");
    return separator > 0
      ? { target: rest.slice(0, separator), range: rest.slice(separator + 1) }
      : { target: rest, range: "*" };
  }
  return { target: dependency, range: spec };
}

const isOptional = (entry, field, dependency) =>
  field === "optionalDependencies" ||
  (field === "peerDependencies" &&
    entry.peerDependenciesMeta?.[dependency]?.optional === true);

/**
 * Every edge the lockfile records, classified: `{path, dependent, version,
 * field, dependency, spec, status, copy}`, where status is one of `in-range`,
 * `out-of-range`, `missing`, `unread`, `wrong-package`, or `skipped`.
 */
export function classifyEdges(lock) {
  const edges = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (entry?.link === true) continue;
    const dependent = identity(path, entry);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, spec] of Object.entries(entry?.[field] ?? {})) {
        const edge = {
          path,
          dependent,
          version: entry.version,
          field,
          dependency,
          spec,
        };
        edges.push(edge);
        const asked =
          typeof spec === "string" ? readSpec(dependency, spec) : {};
        if (asked.source) {
          edge.status = "skipped";
          continue;
        }
        const copy = resolveCopy(lock, path, dependency);
        edge.copy = copy;
        if (copy === null || copy.entry === undefined) {
          edge.status = isOptional(entry, field, dependency)
            ? "skipped"
            : "missing";
          continue;
        }
        const locked = copy.entry.version;
        if (
          asked.range === undefined ||
          semver.validRange(asked.range) === null ||
          typeof locked !== "string" ||
          semver.valid(locked) === null
        ) {
          edge.status = "unread";
          continue;
        }
        edge.range = asked.range;
        edge.locked = locked;
        if (identity(copy.path, copy.entry) !== asked.target) {
          edge.status = "wrong-package";
          continue;
        }
        edge.status = semver.satisfies(locked, asked.range)
          ? "in-range"
          : "out-of-range";
      }
    }
  }
  return edges;
}

const allowedBy = (allowed, edge) =>
  allowed.dependent === edge.dependent &&
  allowed.dependency === edge.dependency &&
  allowed.range === edge.range;

const where = ({ path, dependent, version }) =>
  `${dependent}${typeof version === "string" ? `@${version}` : ""} (${path || "<root>"})`;

const describeEdge = (edge) => {
  const declared = `${where(edge)} declares ${edge.dependency} ${JSON.stringify(edge.spec)} in ${edge.field}`;
  switch (edge.status) {
    case "out-of-range":
      return `${declared}, but the lockfile installs ${edge.dependency}@${edge.locked} (${edge.copy.path}).`;
    case "missing":
      return `${declared}, but the lockfile installs no copy it resolves to.`;
    case "wrong-package":
      return `${declared}, but the copy it resolves to (${edge.copy.path}) is ${identity(edge.copy.path, edge.copy.entry)}.`;
    default:
      return `${declared}, a spec or locked version this check does not read.`;
  }
};

const describeAllowed = ({ dependent, dependency, range }) =>
  `${dependent} -> ${dependency} ${JSON.stringify(range)}`;

const REMEDY = [
  `A dependent whose locked dependency lies outside its declared range runs`,
  `code it was not written against, and npm does not report it. Move the`,
  `dependency or the dependent until the range admits the locked version, or,`,
  `where the edge is meant to stand, record it in OUT_OF_RANGE_BY_DESIGN in`,
  `${SCRIPT} with the reason.`,
].join(" ");

/**
 * The check's verdict over a committed lockfile: `{ok, lines}`, where `lines` is
 * what the run prints either way.
 */
export function assess(lock, allowlist = OUT_OF_RANGE_BY_DESIGN) {
  if (lock?.packages === undefined) {
    return {
      ok: false,
      lines: [
        `The lockfile carries no \`packages\` map, so nothing here can be read from it -- model that shape in ${SCRIPT} before this check can answer for it.`,
      ],
    };
  }

  const unreasoned = allowlist.filter(
    ({ reason }) => typeof reason !== "string" || reason.trim() === "",
  );
  const edges = classifyEdges(lock);
  const outOfRange = edges.filter((edge) => edge.status === "out-of-range");
  const unexcused = outOfRange.filter(
    (edge) => !allowlist.some((allowed) => allowedBy(allowed, edge)),
  );
  const stale = allowlist.filter(
    (allowed) => !outOfRange.some((edge) => allowedBy(allowed, edge)),
  );
  const broken = edges.filter((edge) =>
    ["missing", "unread", "wrong-package"].includes(edge.status),
  );

  const lines = [];
  if (unexcused.length > 0) {
    lines.push(
      `${unexcused.length} locked dependenc${unexcused.length === 1 ? "y lies" : "ies lie"} outside the range the dependent declared:`,
      ...unexcused.map(describeEdge),
      REMEDY,
    );
  }
  if (broken.length > 0) {
    lines.push(
      `${broken.length} edge${broken.length === 1 ? "" : "s"} could not be checked -- model that shape in ${SCRIPT} before this check can answer for it:`,
      ...broken.map(describeEdge),
    );
  }
  if (stale.length > 0) {
    lines.push(
      `${stale.length} OUT_OF_RANGE_BY_DESIGN entr${stale.length === 1 ? "y matches" : "ies match"} no out-of-range edge in the lockfile; delete ${stale.length === 1 ? "it" : "them"}:`,
      ...stale.map(describeAllowed),
    );
  }
  if (unreasoned.length > 0) {
    lines.push(
      `${unreasoned.length} OUT_OF_RANGE_BY_DESIGN entr${unreasoned.length === 1 ? "y carries" : "ies carry"} no reason, and an edge stands only on one:`,
      ...unreasoned.map(describeAllowed),
    );
  }
  if (lines.length > 0) return { ok: false, lines };

  const checked = edges.filter((edge) => edge.status !== "skipped").length;
  return {
    ok: true,
    lines: [
      `Locked-version range check passed: ${checked} edges read, ${outOfRange.length} out of range and each recorded in OUT_OF_RANGE_BY_DESIGN.`,
      ...outOfRange.map(describeEdge),
    ],
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const lock = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  );
  const { ok, lines } = assess(lock);
  for (const line of lines) (ok ? console.log : console.error)(line);
  if (!ok) process.exit(1);
}
