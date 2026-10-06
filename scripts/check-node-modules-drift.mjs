#!/usr/bin/env node
// Consistency check for an installed node_modules against the package-lock.json
// beside it. worktree-init.sh runs it on the tree it just provisioned, the CI
// setup action on a restored dependency cache; any tree can run it alone:
//
//   node scripts/check-node-modules-drift.mjs [dir] [--all]
//                                             [--shared-from <dir>]
//
// npm decides; this script reads its verdict from `npm install --dry-run --json
// --offline`, which needs neither network nor a warm cache. Fails on a package
// installed at a version other than the lockfile's, a package missing, and a
// `file:` tarball dependency whose installed integrity in
// node_modules/.package-lock.json differs from the lockfile's. A package on
// disk the lockfile does not list is reported, never failed. `--all` lists every
// entry; `--shared-from` names the clone a symlink mirror shares packages from,
// so the remedy names where to run `npm install`.
//
// Exit 0 when the tree matches its lockfile, 1 when it drifted, 2 when it could
// not be verified either way (npm could not diff the tree, or node_modules is
// populated but its .package-lock.json cannot be read). How npm's diff is read
// over a symlink mirror, and the measurements behind each rule:
// docs/notes/repo-check-scripts.md.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installedAs } from "./lib/lockfile.mjs";

const NAME = "check-node-modules-drift";
const LISTED = 12;

const DRY_RUN_ARGS = [
  "install",
  "--dry-run",
  "--json",
  "--offline",
  "--no-audit",
  "--no-fund",
];

/**
 * npm's `--json` install summary, parsed out of stdout. The human-readable change
 * lines npm prints first are skipped by starting at the first unindented `{`; the
 * summary object is printed at column 0 and every brace inside it is indented.
 */
export function parseNpmSummary(stdout) {
  const lines = stdout.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "{") continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      continue;
    }
  }
  throw new Error("npm printed no --json install summary");
}

/** Version recorded by the package.json at an install path; null when absent. */
export function installedVersionAt(path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  } catch {
    return null;
  }
  return typeof manifest.version === "string" ? manifest.version : null;
}

/** The lockfile's own install paths, longest first for suffix matching. */
export function lockfileInstallPaths(lock) {
  return Object.keys(lock?.packages ?? {})
    .filter((key) => key.includes("node_modules/"))
    .sort((a, b) => b.length - a.length);
}

/**
 * The tree-relative install path an absolute path npm reported denotes, or null
 * when no lockfile entry claims it. Matching by lockfile key rather than by
 * stripping the tree root is what survives npm's path masking, which can rewrite
 * any segment above the tree.
 */
export function treeRelativePath(reportedPath, lockPaths) {
  const normalized = reportedPath.replaceAll("\\", "/");
  return lockPaths.find((key) => normalized.endsWith(`/${key}`)) ?? null;
}

function requireFields(entry, fields, kind) {
  for (const field of fields) {
    if (typeof entry?.[field] !== "string") {
      throw new Error(
        `npm's --json summary has an unrecognized ${kind} entry (no string "${field}"): ${JSON.stringify(entry)}`,
      );
    }
  }
}

/**
 * npm's summary sorted into the classes above: `wrongVersion` and `missing` are
 * drift, `extra` is reported only. `versionAt` takes a tree-relative install path,
 * so the test can drive the classification without a tree on disk.
 */
export function driftFrom(summary, { lockPaths, versionAt }) {
  const wrongVersion = [];
  const missing = [];
  for (const entry of summary.change ?? []) {
    requireFields(entry?.from, ["name", "version", "path"], "change.from");
    requireFields(entry?.to, ["name", "version", "path"], "change.to");
    if (entry.from.version === entry.to.version) continue;
    wrongVersion.push({
      name: entry.to.name,
      installed: entry.from.version,
      locked: entry.to.version,
    });
  }
  for (const entry of summary.add ?? []) {
    requireFields(entry, ["name", "version", "path"], "add");
    const relative = treeRelativePath(entry.path, lockPaths);
    if (relative === null) {
      throw new Error(
        `npm reported an install path no package-lock.json entry claims: ${entry.path}`,
      );
    }
    const installed = versionAt(relative);
    if (installed === null) {
      missing.push({ name: entry.name, locked: entry.version });
    } else if (installed !== entry.version) {
      wrongVersion.push({ name: entry.name, installed, locked: entry.version });
    }
  }
  const extra = (summary.remove ?? []).map((entry) => {
    requireFields(entry, ["name", "version"], "remove");
    return { name: entry.name, version: entry.version };
  });
  return { wrongVersion, missing, extra };
}

const plural = (count, singular, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/** The lines a drifted tree reports: what is wrong, then how to fix it. */
export function formatDrift(dir, drift, sharedFrom = null, limit = LISTED) {
  const staleFile = drift.staleFile ?? [];
  const unreadableRecord = drift.unreadableRecord ?? null;
  const width = Math.max(
    1,
    ...[...drift.wrongVersion, ...drift.missing, ...staleFile].map(
      (item) => item.name.length,
    ),
  );
  const listed = [
    ...drift.wrongVersion.map((item) => ({
      name: item.name,
      text: `${item.installed} installed, lockfile pins ${item.locked}`,
    })),
    ...drift.missing.map((item) => ({
      name: item.name,
      text: `not installed, lockfile pins ${item.locked}`,
    })),
    ...staleFile.map((item) => ({
      name: item.name,
      text: `installed content does not match the lockfile's integrity (version ${item.version} unchanged)`,
    })),
  ].sort(
    (a, b) => a.name.localeCompare(b.name) || a.text.localeCompare(b.text),
  );
  const lines = [
    listed.length > 0
      ? `${NAME}: node_modules in ${dir} does not match its package-lock.json.`
      : `${NAME}: node_modules in ${dir} cannot be verified against its package-lock.json.`,
  ];
  if (listed.length > 0) {
    lines.push("");
    for (const item of listed.slice(0, limit)) {
      lines.push(`  ${item.name.padEnd(width)}  ${item.text}`);
    }
    if (listed.length > limit) {
      lines.push(`  ... and ${listed.length - limit} more (--all lists them)`);
    }
  }
  if (unreadableRecord) {
    lines.push(
      "",
      `${unreadableRecord.path} could not be read (${unreadableRecord.reason}), so no file: dependency's installed bytes could be checked against the lockfile's integrity.`,
    );
  }
  const extra =
    drift.extra.length === 0
      ? ""
      : `, plus ${plural(drift.extra.length, "package")} on disk the lockfile does not list`;
  const staleFileCount =
    staleFile.length === 0
      ? ""
      : `, ${plural(staleFile.length, "stale file dependency", "stale file dependencies")}`;
  lines.push(
    "",
    `${plural(drift.wrongVersion.length, "wrong version")}, ${plural(drift.missing.length, "missing package")}${staleFileCount}${extra}.`,
  );
  if (sharedFrom) {
    lines.push(
      listed.length > 0
        ? `These packages are shared by symlink from ${sharedFrom}, whose install does not match this lockfile (it may be older, or from another branch).`
        : `This tree's packages are shared by symlink from ${sharedFrom}, whose install could not be shown to match this lockfile.`,
      `Keep sharing them (fast): run \`npm install\` in ${sharedFrom}, then re-run this script.`,
      `Fix this tree alone (slower): run \`npm ci\` in ${dir} -- it replaces the symlinks with a private tree pinned to this lockfile, cannot rewrite it, and does not write into ${sharedFrom}.`,
    );
  } else {
    lines.push(
      `Run \`npm install\` in ${dir} to reconcile it with the lockfile.`,
    );
  }
  return lines;
}

/**
 * What npm's own record of what it extracted, node_modules/.package-lock.json,
 * says about the lockfile's `file:` tarball dependencies (a `resolved` starting
 * "file:" with a string `integrity` -- a workspace's own local package links
 * the same way but with neither, so it is not in scope here). `stale` names the
 * entries whose installed bytes no longer match `lock`'s recorded integrity
 * though the version string is unchanged: the class `driftFrom`'s version-keyed
 * diff cannot see. `unreadableRecord` is set instead when an installed tree's
 * record could not be read, which leaves that class unchecked; a tree with no
 * node_modules is not that case, per the module header. An entry missing from a
 * readable record is left to `driftFrom`'s own missing/add handling.
 */
export function fileDependencyIntegrity(dir, lock) {
  const fileEntries = Object.entries(lock?.packages ?? {}).filter(
    ([, entry]) =>
      typeof entry?.resolved === "string" &&
      entry.resolved.startsWith("file:") &&
      typeof entry?.integrity === "string",
  );
  const nothingToCompare = { stale: [], unreadableRecord: null };
  if (fileEntries.length === 0) return nothingToCompare;
  if (!existsSync(join(dir, "node_modules"))) return nothingToCompare;

  const recordPath = join(dir, "node_modules", ".package-lock.json");
  let installedLock;
  try {
    installedLock = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (cause) {
    return {
      stale: [],
      unreadableRecord: { path: recordPath, reason: cause.message },
    };
  }

  const stale = [];
  for (const [path, entry] of fileEntries) {
    const installed = installedLock.packages?.[path];
    if (installed === undefined) continue;
    // A version bump is `driftFrom`'s own wrongVersion class; flagging it again
    // here would double-report the same package under two classes. This class is
    // only the gap that leaves: same recorded version, different bytes.
    if (installed.version !== entry.version) continue;
    if (installed.integrity !== entry.integrity) {
      stale.push({ name: installedAs(path), version: entry.version });
    }
  }
  return { stale, unreadableRecord: null };
}

/** Drive npm's dry-run diff in `dir` and sort its verdict into drift classes. */
export function checkTree(dir, run = runNpmDryRun) {
  const lockPath = join(dir, "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (cause) {
    throw new Error(`${lockPath} could not be read`, { cause });
  }
  const drift = driftFrom(parseNpmSummary(run(dir)), {
    lockPaths: lockfileInstallPaths(lock),
    versionAt: (relative) => installedVersionAt(join(dir, relative)),
  });
  const fileIntegrity = fileDependencyIntegrity(dir, lock);
  return {
    ...drift,
    staleFile: fileIntegrity.stale,
    unreadableRecord: fileIntegrity.unreadableRecord,
  };
}

/** npm's own diff of `dir`'s ideal tree against what is installed there. */
export function runNpmDryRun(dir) {
  return execFileSync("npm", DRY_RUN_ARGS, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const sharedIndex = args.indexOf("--shared-from");
  const sharedFrom =
    sharedIndex === -1 ? null : resolve(args[sharedIndex + 1] ?? "");
  if (sharedIndex !== -1) args.splice(sharedIndex, 2);
  const dir = resolve(
    args.find((arg) => !arg.startsWith("--")) ?? process.cwd(),
  );

  let drift;
  try {
    drift = checkTree(dir);
  } catch (error) {
    console.error(
      `${NAME}: could not verify ${dir} against its package-lock.json -- ${error.message}`,
    );
    process.exit(2);
  }

  const drifted =
    drift.wrongVersion.length > 0 ||
    drift.missing.length > 0 ||
    drift.staleFile.length > 0;
  if (drifted || drift.unreadableRecord !== null) {
    const report = formatDrift(dir, drift, sharedFrom, all ? Infinity : LISTED);
    for (const line of report) console.error(line);
    process.exit(drifted ? 1 : 2);
  }

  const extra =
    drift.extra.length === 0
      ? ""
      : `; ${plural(drift.extra.length, "package")} on disk the lockfile does not list, which cannot change what it does`;
  console.log(`${NAME}: node_modules agrees with package-lock.json${extra}.`);
}
