#!/usr/bin/env node
// The hosted web application's manifest: every file of each deployed build,
// with its size and SHA-256, naming the release version and commit.
// release.yaml writes it from the artifacts it deploys, then attests, signs
// and attaches it to the release; the same script compares a manifest against
// a tree on disk or against what a deployment serves (docs/RELEASES.md,
// Hosted web application).
//
//   node scripts/hosted-site-manifest.mjs write --version <X.Y.Z> --commit <sha> --out <file> <site>=<dir>...
//   node scripts/hosted-site-manifest.mjs check-tree <manifest> <site>=<dir>
//   node scripts/hosted-site-manifest.mjs check-served <manifest> <site>=<url>
//
// Dependency-free, so a job with only Node installed runs it. Exit 0 when
// written or matching, 1 on a mismatch or refusal, 2 on a usage error.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The `format` value every manifest this script writes or reads names. */
export const MANIFEST_FORMAT = "alcove-hosted-site-manifest";

/** The one `format_version` this script writes and reads. */
export const MANIFEST_FORMAT_VERSION = 1;

/**
 * Files Cloudflare Pages reads as configuration of the deployment rather than
 * serving, so `check-served` cannot compare them by fetching.
 */
export const PAGES_CONFIGURATION_FILES = ["_headers", "_redirects"];

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SITE_NAME = /^[a-z][a-z0-9-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_CONCURRENCY = 8;

const fail = (message) => {
  throw new Error(message);
};

/** Code-unit order, so the listing does not depend on the host's locale. */
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Every regular file under `dir`, hidden ones included, as sorted POSIX paths
 * relative to it. Throws on a symbolic link or any other entry that is
 * neither a file nor a directory, since a deployment upload would not carry
 * it as the bytes hashed here.
 */
export function listTree(dir) {
  const found = [];
  const visit = (relativeDir) => {
    const absolute = relativeDir === "" ? dir : join(dir, relativeDir);
    for (const name of readdirSync(absolute)) {
      const path = relativeDir === "" ? name : `${relativeDir}/${name}`;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) found.push(path);
      else fail(`${path} under ${dir} is neither a file nor a directory.`);
    }
  };
  visit("");
  return found.sort((a, b) => byPath({ path: a }, { path: b }));
}

/** A file's `{size, sha256}`. */
export function fileDigest(path) {
  const bytes = readFileSync(path);
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** The manifest entries of every file under `dir`. */
export function treeEntries(dir) {
  return listTree(dir).map((path) => ({
    path,
    ...fileDigest(join(dir, path)),
  }));
}

/**
 * The manifest of the trees in `sites`, a map of site name to directory.
 * Throws on a malformed version, commit or site name, or an empty tree.
 */
export function buildManifest({ version, commit, sites }) {
  if (!RELEASE_VERSION.test(version ?? "")) {
    fail(`the version ${JSON.stringify(version)} is not X.Y.Z.`);
  }
  if (!FULL_COMMIT.test(commit ?? "")) {
    fail(`the commit ${JSON.stringify(commit)} is not a full commit id.`);
  }
  const names = Object.keys(sites);
  if (names.length === 0) fail("no site was named.");
  const out = {};
  for (const name of names.sort()) {
    if (!SITE_NAME.test(name)) fail(`the site name "${name}" is not a-z0-9-.`);
    const files = treeEntries(sites[name]);
    if (files.length === 0) fail(`the site "${name}" holds no files.`);
    out[name] = { files };
  }
  return {
    format: MANIFEST_FORMAT,
    format_version: MANIFEST_FORMAT_VERSION,
    version,
    commit,
    sites: out,
  };
}

/** The manifest as the bytes written: two-space JSON and a final newline. */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value, keys, where) => {
  const found = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (JSON.stringify(found) !== JSON.stringify(wanted)) {
    fail(
      `${where} has the fields ${found.join(", ")}, not ${wanted.join(", ")}.`,
    );
  }
};

/**
 * Whether a manifest path is relative, `/`-separated, and free of empty,
 * `.` and `..` segments, backslashes and control characters, so it names a
 * file inside the tree or under the site's origin and nothing else.
 */
export function isSafeRelativePath(path) {
  if (typeof path !== "string" || path === "") return false;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A manifest's text, parsed and checked field by field, or throws. */
export function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    fail(`the manifest is not JSON: ${error.message}`);
  }
  if (!isPlainObject(manifest)) fail("the manifest is not a JSON object.");
  exactKeys(
    manifest,
    ["format", "format_version", "version", "commit", "sites"],
    "the manifest",
  );
  if (manifest.format !== MANIFEST_FORMAT) {
    fail(`the manifest's format is not ${MANIFEST_FORMAT}.`);
  }
  if (manifest.format_version !== MANIFEST_FORMAT_VERSION) {
    fail(
      `the manifest's format_version is ${JSON.stringify(manifest.format_version)}, and this script reads ${MANIFEST_FORMAT_VERSION}.`,
    );
  }
  if (!RELEASE_VERSION.test(String(manifest.version))) {
    fail("the manifest's version is not X.Y.Z.");
  }
  if (!FULL_COMMIT.test(String(manifest.commit))) {
    fail("the manifest's commit is not a full commit id.");
  }
  if (!isPlainObject(manifest.sites))
    fail("the manifest's sites is not an object.");
  for (const [name, site] of Object.entries(manifest.sites)) {
    const where = `the manifest's site "${name}"`;
    if (!SITE_NAME.test(name)) fail(`${where} has a malformed name.`);
    if (!isPlainObject(site)) fail(`${where} is not an object.`);
    exactKeys(site, ["files"], where);
    if (!Array.isArray(site.files) || site.files.length === 0) {
      fail(`${where} lists no files.`);
    }
    const seen = new Set();
    for (const entry of site.files) {
      if (!isPlainObject(entry))
        fail(`${where} has a file entry that is not an object.`);
      exactKeys(entry, ["path", "size", "sha256"], `a file entry of ${where}`);
      if (!isSafeRelativePath(entry.path)) {
        fail(`${where} lists the unsafe path ${JSON.stringify(entry.path)}.`);
      }
      if (seen.has(entry.path)) fail(`${where} lists ${entry.path} twice.`);
      seen.add(entry.path);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        fail(`${where} gives ${entry.path} a size that is not a whole number.`);
      }
      if (!SHA256_HEX.test(String(entry.sha256))) {
        fail(`${where} gives ${entry.path} a malformed sha256.`);
      }
    }
  }
  return manifest;
}

/** A named site's file entries, or throws naming the sites the manifest has. */
export function siteFiles(manifest, name) {
  const site = manifest.sites[name];
  if (site === undefined) {
    fail(
      `the manifest has no site "${name}"; it has ${Object.keys(manifest.sites).join(", ")}.`,
    );
  }
  return site.files;
}

/**
 * How a tree differs from a site's entries: files the manifest lists that the
 * tree lacks, files the tree holds that the manifest does not list, and files
 * whose size or digest differs. All three empty means the tree is the build.
 */
export function compareTree(files, dir) {
  const listed = new Map(files.map((entry) => [entry.path, entry]));
  const present = listTree(dir);
  const result = { missing: [], unlisted: [], changed: [] };
  for (const path of present) {
    const entry = listed.get(path);
    if (entry === undefined) {
      result.unlisted.push(path);
      continue;
    }
    const actual = fileDigest(join(dir, path));
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
      result.changed.push(path);
    }
  }
  const presentSet = new Set(present);
  for (const { path } of files) {
    if (!presentSet.has(path)) result.missing.push(path);
  }
  return result;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A served site's base URL, ending in `/`. Refuses a URL with a query,
 * fragment or credentials, and plain http except on a loopback host.
 */
export function siteBaseUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${JSON.stringify(text)} is not a URL.`);
  }
  const loopbackHttp =
    url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    fail(`${url.href} is not https.`);
  }
  if (
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    fail(`${url.href} carries a query, fragment or credentials.`);
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

/** The URL a manifest path is served at under `base`, each segment encoded. */
export function servedUrl(base, path) {
  return new URL(path.split("/").map(encodeURIComponent).join("/"), base);
}

/**
 * The SHA-256 of a response body, reading at most `limit` bytes; `undefined`
 * when the body runs past it.
 */
async function boundedBodyDigest(response, limit) {
  const hash = createHash("sha256");
  let size = 0;
  if (response.body === null) return { size, sha256: hash.digest("hex") };
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    hash.update(value);
  }
  return { size, sha256: hash.digest("hex") };
}

/**
 * Fetches every entry of a site from `baseUrl` and compares each body to the
 * manifest. Returns the paths whose body differs, the paths that could not be
 * fetched with why, and the Pages configuration files skipped. A redirect is
 * followed within the site's origin only. It cannot find a file the
 * deployment serves that the manifest does not list, since a site has no
 * listing to read.
 */
export async function compareServed(files, baseUrl, fetchImpl = fetch) {
  const base = siteBaseUrl(String(baseUrl));
  const result = { changed: [], failed: [], skipped: [], compared: 0 };
  const queue = [];
  for (const entry of files) {
    if (PAGES_CONFIGURATION_FILES.includes(entry.path)) {
      result.skipped.push(entry.path);
    } else {
      queue.push(entry);
    }
  }
  const check = async (entry) => {
    const url = servedUrl(base, entry.path);
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "follow",
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      result.failed.push({ path: entry.path, why: error.message });
      return;
    }
    if (new URL(response.url || url.href).origin !== base.origin) {
      await response.body?.cancel();
      result.failed.push({
        path: entry.path,
        why: `redirected off the site, to ${response.url}`,
      });
      return;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      result.failed.push({
        path: entry.path,
        why: `answered ${response.status}`,
      });
      return;
    }
    const digest = await boundedBodyDigest(response, entry.size);
    result.compared += 1;
    if (
      digest === undefined ||
      digest.size !== entry.size ||
      digest.sha256 !== entry.sha256
    ) {
      result.changed.push(entry.path);
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const entry = queue[next];
      next += 1;
      await check(entry);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker),
  );
  result.changed.sort();
  result.failed.sort(byPath);
  return result;
}

/** `<site>=<value>` as `[site, value]`, or throws. */
export function siteArgument(text) {
  const at = text.indexOf("=");
  if (at <= 0 || at === text.length - 1) {
    throw new UsageError(`"${text}" is not <site>=<value>.`);
  }
  return [text.slice(0, at), text.slice(at + 1)];
}

class UsageError extends Error {}

const USAGE = `Usage:
  node scripts/hosted-site-manifest.mjs write --version <X.Y.Z> --commit <sha> --out <file> <site>=<dir>...
  node scripts/hosted-site-manifest.mjs check-tree <manifest> <site>=<dir>
  node scripts/hosted-site-manifest.mjs check-served <manifest> <site>=<url>`;

function parseWriteArguments(args) {
  const options = {};
  const sites = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--version" || arg === "--commit" || arg === "--out") {
      const value = args[index + 1];
      if (value === undefined) throw new UsageError(`${arg} takes a value.`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    const [name, dir] = siteArgument(arg);
    if (name in sites)
      throw new UsageError(`the site "${name}" is named twice.`);
    sites[name] = dir;
  }
  for (const required of ["version", "commit", "out"]) {
    if (options[required] === undefined) {
      throw new UsageError(`--${required} is required.`);
    }
  }
  return { ...options, sites };
}

const report = (lines) => {
  for (const line of lines) console.log(line);
};

/** Runs one command line; resolves to the exit status. */
export async function main(argv) {
  const [command, ...args] = argv;
  if (command === "write") {
    const { version, commit, out, sites } = parseWriteArguments(args);
    const manifest = buildManifest({ version, commit, sites });
    writeFileSync(out, serializeManifest(manifest));
    report(
      Object.entries(manifest.sites).map(
        ([name, site]) => `${name}: ${site.files.length} files`,
      ),
    );
    console.log(`wrote ${out} for version ${version}, commit ${commit}`);
    return 0;
  }
  if (command === "check-tree" || command === "check-served") {
    if (args.length !== 2)
      throw new UsageError("expected <manifest> <site>=<value>.");
    const manifest = parseManifest(readFileSync(args[0], "utf8"));
    const [name, target] = siteArgument(args[1]);
    const files = siteFiles(manifest, name);
    console.log(
      `manifest for version ${manifest.version}, commit ${manifest.commit}; site "${name}", ${files.length} files`,
    );
    if (command === "check-tree") {
      const { missing, unlisted, changed } = compareTree(files, target);
      report(missing.map((path) => `missing from the tree: ${path}`));
      report(unlisted.map((path) => `not in the manifest: ${path}`));
      report(changed.map((path) => `differs: ${path}`));
      const clean = missing.length + unlisted.length + changed.length === 0;
      console.log(
        clean
          ? `${target} matches the manifest`
          : `${target} does not match the manifest`,
      );
      return clean ? 0 : 1;
    }
    const { changed, failed, skipped, compared } = await compareServed(
      files,
      target,
    );
    report(
      skipped.map((path) => `skipped, read by Pages as configuration: ${path}`),
    );
    report(failed.map(({ path, why }) => `not fetched: ${path} (${why})`));
    report(changed.map((path) => `differs: ${path}`));
    const clean = changed.length + failed.length === 0;
    console.log(
      clean
        ? `${target} serves all ${compared} compared files as the manifest lists them`
        : `${target} does not serve the files the manifest lists`,
    );
    return clean ? 0 : 1;
  }
  throw new UsageError(
    command === undefined
      ? "no command given."
      : `unknown command "${command}".`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (status) => process.exit(status),
    (error) => {
      if (error instanceof UsageError) {
        console.error(`hosted-site-manifest: ${error.message}\n${USAGE}`);
        process.exit(2);
      }
      console.error(
        `hosted-site-manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
