// The license notices of the third-party packages a bundle inlines. For the
// server bundles the `bundleNotices()` plugin writes them as a comment at the
// head of each chunk; Rollup and Rolldown (under Vite) both run it, from
// packages/core/rollup.config.ts, packages/sftp-relay/rollup.config.mjs and
// the console server half of apps/web/vite.console.config.ts. For the browser
// builds, the console client and apps/web/vite.hosted.config.ts, the
// `bundleNoticesFile()` plugins write them to one file beside the page, so the
// page downloads none of it. scripts/check-bundle-notices.mjs holds every
// built chunk to having the notice of each package it inlines.
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
 * Packages known to ship no license file, checked by hand, whose notice is
 * the license, author, and source their package.json declares. Any other
 * package without a license file fails the build.
 */
export const NO_LICENSE_FILE = new Set(["react-remove-scroll-bar"]);

/** The notice of a package in {@link NO_LICENSE_FILE}, from its package.json. */
function declaredNotice({ name, license, author, repository }) {
  const who = typeof author === "string" ? author : author?.name;
  const source = typeof repository === "string" ? repository : repository?.url;
  return [
    `${name} ships no license file. Its package.json declares the ${license} license`,
    who ? `, author ${who}` : "",
    source ? `, source ${source}` : "",
    ".",
  ].join("");
}

/**
 * A package's name, version, declared license, and notice texts: every
 * license file it ships, then any NOTICE file. Throws for a package that ships
 * no license file and is not in {@link NO_LICENSE_FILE}, so a bundle cannot
 * inline one without its notice.
 */
export function packageNotice(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const { name, version, license } = manifest;
  const texts = readMatching(dir, LICENSE_FILE);
  if (texts.length === 0 && NO_LICENSE_FILE.has(name)) {
    texts.push(declaredNotice(manifest));
  }
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
  return [
    COMMENT_OPEN.trimEnd(),
    " * This file includes the third-party packages below, each followed by its",
    " * license text.",
    " *",
    ` ${PACKAGE_LIST_PREFIX}${JSON.stringify(names)}`,
    " */",
    "/*!",
    noticeSections(notices, commentSafe),
    "*/",
  ].join("\n");
}

const noticeSections = (notices, escape = (text) => text) =>
  notices
    .map(
      (n) =>
        `${n.name} ${n.version} (${n.license ?? "no license declared"})\n\n` +
        n.texts.map(escape).join("\n\n"),
    )
    .join("\n\n---\n\n");

/** The Rollup/Rolldown plugin that writes each chunk's notice comment. */
export function bundleNotices() {
  return {
    name: "bundle-notices",
    banner(chunk) {
      return noticeComment(chunkNotices(chunk.moduleIds));
    },
  };
}

/** The name of the file a client build's notices are written to, at the root
 * of its output. */
export const NOTICES_FILE = "third-party-licenses.txt";

/**
 * The Vite plugins that write {@link NOTICES_FILE}: the license text of every
 * package a client build inlines, its workers included, in one file beside the
 * page instead of in the chunks the page loads. `client` goes in the build's
 * `plugins` and `worker` in its `worker.plugins`. The file is written when
 * the client's bundle is, after the worker builds finish, an order
 * scripts/check-bundle-notices.test.mjs holds.
 */
export function bundleNoticesFile() {
  const workerModuleIds = new Set();
  const moduleIdsOf = (bundle) =>
    Object.values(bundle).flatMap((file) =>
      file.type === "chunk" ? file.moduleIds : [],
    );
  return {
    worker: {
      name: "bundle-notices-file-worker",
      apply: "build",
      generateBundle(_options, bundle) {
        for (const id of moduleIdsOf(bundle)) workerModuleIds.add(id);
      },
    },
    client: {
      name: "bundle-notices-file",
      apply: "build",
      generateBundle(_options, bundle) {
        const notices = chunkNotices([
          ...workerModuleIds,
          ...moduleIdsOf(bundle),
        ]);
        this.emitFile({
          type: "asset",
          fileName: NOTICES_FILE,
          source: [
            "This app includes the third-party packages below, each followed by its license text.",
            "",
            `Bundled packages: ${JSON.stringify(notices.map((n) => n.name))}`,
            "",
            "---",
            "",
            noticeSections(notices),
            "",
          ].join("\n"),
        });
      },
    },
  };
}
