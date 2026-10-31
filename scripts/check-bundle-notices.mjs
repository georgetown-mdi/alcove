#!/usr/bin/env node
// Bundle notice check: `npm run check:bundle-notices`, run by static_checks.yaml
// through `npm run check:all`. Every shipped build that inlines third-party
// packages must have the license text of each package it inlines: each chunk
// of core's dist, the SFTP relay's image file and the console server at its
// head, and the hosted app and the console client, workers included, in the
// third-party-licenses.txt beside the page. Each bundle is built in memory
// from its own config, and the packages a chunk inlines are read off the
// bundler's output record (`moduleIds`): a module under node_modules names its
// package, and a module from core's dist brings what core's own in-memory
// build put in that file. A package that ships no license file fails the build
// itself (scripts/lib/bundleNotices.mjs).
//
// Reads core's dist from disk for the downstream bundles, so a stale dist
// fails here as a missing notice and a missing one stops it; rebuild core
// first. Writes no bundle to disk, though the web builds write
// apps/web/.tanstack/ when it is absent or stale. The hosted build is given a
// placeholder coordination server when VITE_SIGNALING_SERVER_URL is unset.
// Exit 0 clean, 1 when a notice is missing, core's dist is, or a build fails.

import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NOTICES_FILE,
  commentSafe,
  inlinedPackageDirs,
  packageNotice,
} from "./lib/bundleNotices.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const REBUILD_CORE =
  "rebuild core (npm run build -w packages/core) if its dist is missing or older than its sources";

/** Text compared with every run of whitespace collapsed: Rolldown re-indents
 * comment lines. */
const flatten = (text) => text.replace(/\s+/g, " ");

/** Runs `fn` with the working directory at `dir`, which the configs'
 * relative paths are written against. */
async function inDir(dir, fn) {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

async function rollupChunks(workspace, configFile) {
  const { rollup } = await import("rollup");
  const dir = join(repoRoot, workspace);
  return inDir(dir, async () => {
    // The first configuration is the JavaScript build; core's later ones
    // write declaration files.
    const [config] = [
      (await import(pathToFileURL(join(dir, configFile)).href)).default,
    ].flat();
    const chunks = [];
    const bundle = await rollup({ ...config, onwarn: () => {} });
    for (const output of [config.output].flat()) {
      const { output: files } = await bundle.generate(output);
      const outDir = output.dir ?? join(output.file, "..");
      for (const file of files) {
        if (file.type !== "chunk") continue;
        chunks.push({
          path: join(dir, outDir, file.fileName),
          code: file.code,
          moduleIds: file.moduleIds,
        });
      }
    }
    await bundle.close();
    return chunks;
  });
}

const webDir = join(repoRoot, "apps/web");

const viteFiles = (result) => [result].flat().flatMap(({ output }) => output);

async function consoleServerChunks() {
  const { build } = await import("vite");
  process.env.VITE_DEPLOYMENT_PROFILE = "console";
  const result = await build({
    configFile: join(webDir, "vite.console.config.ts"),
    logLevel: "error",
    build: { ssr: "server/console/main.ts", write: false },
  });
  return viteFiles(result)
    .filter((file) => file.type === "chunk")
    .map((file) => ({
      path: join(webDir, "dist/console-server", file.fileName),
      code: file.code,
      moduleIds: file.moduleIds,
    }));
}

/**
 * A client build's chunks, its workers' included, each paired with the text of
 * the notices file the build wrote (empty when it wrote none) as `code`.
 */
async function clientChunks(profile, configFile, outDir) {
  const { build } = await import("vite");
  process.env.VITE_DEPLOYMENT_PROFILE = profile;
  const workerChunks = [];
  const recordWorkerChunks = {
    name: "check-bundle-notices-worker-chunks",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk") workerChunks.push(file);
      }
    },
  };
  const result = await build({
    configFile: join(webDir, configFile),
    logLevel: "error",
    worker: { rollupOptions: { output: { plugins: [recordWorkerChunks] } } },
    build: { write: false },
  });
  const files = viteFiles(result);
  const notices = files.find(
    (file) => file.type === "asset" && file.fileName === NOTICES_FILE,
  )?.source;
  const text =
    notices === undefined ? "" : Buffer.from(notices).toString("utf8");
  return [
    ...files.filter((file) => file.type === "chunk"),
    ...workerChunks,
  ].map((file) => ({
    path: join(webDir, outDir, file.fileName),
    code: text,
    moduleIds: file.moduleIds,
    noticesPath: join(webDir, outDir, NOTICES_FILE),
  }));
}

/** The package directories a chunk inlines, directly or through `upstream`. */
const chunkPackageDirs = (chunk, upstream) =>
  new Set([
    ...inlinedPackageDirs(chunk.moduleIds),
    ...chunk.moduleIds.flatMap((id) => upstream.get(id) ?? []),
  ]);

/**
 * The packages missing a notice: one line per gap. A chunk with `noticesPath`
 * has its notices in that file, whose text is its `code`; any other has them
 * in its own code. `upstream` maps a built file's real path to the package
 * directories its build inlined.
 */
export function missingNotices(chunks, upstream = new Map()) {
  const gaps = new Map();
  for (const chunk of chunks) {
    const code = flatten(chunk.code);
    const written = chunk.noticesPath ? (t) => t : commentSafe;
    for (const dir of chunkPackageDirs(chunk, upstream)) {
      const key = `${chunk.noticesPath ?? chunk.path}\0${dir}`;
      if (gaps.has(key)) continue;
      const notice = packageNotice(dir);
      if (notice.texts.every((t) => code.includes(flatten(written(t))))) {
        continue;
      }
      const pkg = `${notice.name} ${notice.version} (${relative(repoRoot, dir)})`;
      gaps.set(
        key,
        chunk.noticesPath
          ? `${relative(repoRoot, chunk.noticesPath)}: lacks the license text of ${pkg}, ` +
              `which ${relative(repoRoot, chunk.path)} inlines`
          : `${relative(repoRoot, chunk.path)}: inlines ${pkg} without its license text`,
      );
    }
  }
  return [...gaps.values()];
}

/**
 * Maps the real path of each of core's built files to the package directories
 * its build inlined, or names the first file missing from core's dist.
 */
export function coreUpstream(chunks) {
  const upstream = new Map();
  for (const chunk of chunks) {
    let real;
    try {
      real = realpathSync(chunk.path);
    } catch (error) {
      if (error?.code === "ENOENT") return { missing: chunk.path };
      throw error;
    }
    upstream.set(real, inlinedPackageDirs(chunk.moduleIds));
  }
  return { upstream };
}

async function main() {
  const core = await rollupChunks("packages/core", "rollup.config.ts");
  const { upstream, missing } = coreUpstream(core);
  if (missing) {
    console.error(
      `check:bundle-notices: ${relative(repoRoot, missing)} does not exist; ${REBUILD_CORE}.`,
    );
    process.exit(1);
  }
  process.env.VITE_SIGNALING_SERVER_URL ??= "wss://signaling.example.org/api/";
  const chunks = [
    ...core,
    ...(await rollupChunks("packages/sftp-relay", "rollup.config.mjs")),
    ...(await consoleServerChunks()),
    ...(await clientChunks("hosted", "vite.hosted.config.ts", "dist/hosted")),
    ...(await clientChunks(
      "console",
      "vite.console.config.ts",
      "dist/console",
    )),
  ];
  const gaps = missingNotices(chunks, upstream);
  if (gaps.length > 0) {
    console.error(
      "check:bundle-notices: a build inlines a package without its license text. " +
        "Add bundleNotices() from scripts/lib/bundleNotices.mjs to a server " +
        "bundle's config, or bundleNoticesFile() to a client build's plugins " +
        `and worker plugins, and ${REBUILD_CORE}.`,
    );
    for (const gap of gaps) console.error(`  ${gap}`);
    process.exit(1);
  }
  const counts = new Map();
  for (const chunk of chunks) {
    const where = chunk.noticesPath ?? chunk.path;
    const dirs = counts.get(where) ?? new Set();
    for (const dir of chunkPackageDirs(chunk, upstream)) dirs.add(dir);
    counts.set(where, dirs);
  }
  for (const [where, dirs] of counts) {
    if (dirs.size === 0) continue;
    console.log(
      `check:bundle-notices: ${relative(repoRoot, where)} has the notices of ${dirs.size} inlined package(s)`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
