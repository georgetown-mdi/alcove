// The license notices of the third-party packages a bundle inlines, written as
// a comment at the head of each chunk by the `bundleNotices()` plugin. Rollup
// and Rolldown (under Vite) both run it, from the bundles' own configs:
// packages/core/rollup.config.ts, packages/sftp-relay/rollup.config.mjs and
// apps/web/vite.console.config.ts. scripts/check-bundle-notices.mjs holds each
// built chunk to carrying the notice of every package it inlines.
//
// A chunk's packages come from the bundler's record of the modules in it: a
// module under node_modules belongs to the package directory that holds it,
// and a module from a workspace's built output that itself begins with this
// plugin's comment brings in the packages that comment lists, which is how
// what core's dist inlines reaches the bundles built from it.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The comment line that lists a chunk's packages by name, as JSON. Rolldown
 * strips the leading blank of a comment line, so it is matched trimmed. */
export const PACKAGE_LIST_PREFIX = "* Bundled packages: ";

const COMMENT_OPEN = "/*!\n";
const LICENSE_FILE = /^(licen[cs]e|copying)([.-][\w.-]*)?$/i;
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;
const NODE_MODULES = /[\\/]node_modules[\\/]/g;

/** A module id with Rollup's virtual-module prefix and any query dropped. */
const modulePath = (id) => id.replace(/^\0/, "").replace(/\?.*$/, "");

/** The node_modules package directory a module id lies in, or null. */
export function packageDirOf(id) {
  const path = modulePath(id);
  let end = -1;
  for (const match of path.matchAll(NODE_MODULES)) {
    end = match.index + match[0].length;
  }
  if (end < 0) return null;
  const segments = path.slice(end).split(/[\\/]/);
  const depth = segments[0].startsWith("@") ? 2 : 1;
  return join(path.slice(0, end), ...segments.slice(0, depth));
}

/** The package names a file's leading notice comment lists, or none. */
export function listedPackages(path) {
  if (!/\.[cm]?js$/.test(path) || !existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (!text.startsWith(COMMENT_OPEN)) return [];
  const end = text.indexOf("*/");
  const line = text
    .slice(0, end)
    .split("\n")
    .map((l) => l.trimStart())
    .find((l) => l.startsWith(PACKAGE_LIST_PREFIX));
  return line ? JSON.parse(line.slice(PACKAGE_LIST_PREFIX.length)) : [];
}

/** The directory Node resolves package `name` to from `fromDir`. */
function resolvePackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) {
      throw new Error(`${name} is not installed above ${fromDir}`);
    }
  }
}

/** The package directories the modules of one chunk inline. */
export function inlinedPackageDirs(moduleIds) {
  const dirs = new Set();
  for (const id of moduleIds) {
    const dir = packageDirOf(id);
    if (dir) {
      dirs.add(dir);
      continue;
    }
    const path = modulePath(id);
    for (const name of listedPackages(path)) {
      dirs.add(resolvePackageDir(name, dirname(path)));
    }
  }
  return [...dirs];
}

/** The notices of the packages a chunk's modules inline, sorted by name. */
export const chunkNotices = (moduleIds) =>
  inlinedPackageDirs(moduleIds)
    .map(packageNotice)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );

const readMatching = (dir, pattern) =>
  readdirSync(dir)
    .filter((file) => pattern.test(file))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8").trim());

/**
 * A package's name, version, declared license, and notice texts: every
 * license file it ships, then any NOTICE file. Throws for a package that ships
 * no license file, so a bundle cannot inline one without its notice.
 */
export function packageNotice(dir) {
  const { name, version, license } = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  );
  const texts = readMatching(dir, LICENSE_FILE);
  if (texts.length === 0) {
    throw new Error(
      `${name}@${version} (${dir}) is inlined into a bundle but ships no license file to carry`,
    );
  }
  return {
    name,
    version,
    license,
    texts: [...texts, ...readMatching(dir, NOTICE_FILE)],
  };
}

/** Text made safe to sit inside a block comment. */
export const commentSafe = (text) => text.replaceAll("*/", "* /");

/** The comment a chunk inlining these packages begins with, or "" for none. */
export function noticeComment(notices) {
  if (notices.length === 0) return "";
  const names = [...new Set(notices.map((n) => n.name))];
  const sections = notices.map(
    (n) =>
      `${n.name} ${n.version} (${n.license ?? "no license declared"})\n\n` +
      n.texts.map(commentSafe).join("\n\n"),
  );
  return [
    COMMENT_OPEN.trimEnd(),
    " * This file includes the third-party packages below, each followed by its",
    " * license text.",
    " *",
    ` ${PACKAGE_LIST_PREFIX}${JSON.stringify(names)}`,
    " */",
    "/*!",
    sections.join("\n\n---\n\n"),
    "*/",
  ].join("\n");
}

/** The Rollup/Rolldown plugin that writes each chunk's notice comment. */
export function bundleNotices() {
  return {
    name: "bundle-notices",
    banner(chunk) {
      return noticeComment(chunkNotices(chunk.moduleIds));
    },
  };
}
