#!/usr/bin/env node
// Bundle notice check: `npm run check:bundle-notices`, run by static_checks.yaml
// through `npm run check:all`. Every chunk of the bundles that inline
// third-party packages -- core's dist, the SFTP relay's image file and the
// console server -- must carry the license text of each package it inlines.
// Each bundle is built in memory from its own config, and the packages a chunk
// inlines are read off the bundler's output record (`moduleIds`): a module
// under node_modules names its package, and a module from core's dist brings
// what core's own in-memory build put in that file. A package that ships no
// license file fails the build itself (scripts/lib/bundleNotices.mjs).
//
// Reads core's dist from disk for the two downstream bundles, so a stale dist
// fails here as a missing notice; rebuild core first. Writes no bundle to
// disk, though the console build writes apps/web/.tanstack/ when it is absent
// or stale. Exit 0 clean, 1 when a notice is missing or a build fails.

import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commentSafe,
  inlinedPackageDirs,
  packageNotice,
} from "./lib/bundleNotices.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

async function consoleServerChunks() {
  const { build } = await import("vite");
  const dir = join(repoRoot, "apps/web");
  process.env.VITE_DEPLOYMENT_PROFILE = "console";
  const result = await build({
    configFile: join(dir, "vite.console.config.ts"),
    logLevel: "error",
    build: { ssr: "server/console/main.ts", write: false },
  });
  return [result]
    .flat()
    .flatMap(({ output }) => output)
    .filter((file) => file.type === "chunk")
    .map((file) => ({
      path: join(dir, "dist/console-server", file.fileName),
      code: file.code,
      moduleIds: file.moduleIds,
    }));
}

/**
 * The packages each chunk is missing the notice of: one line per gap. `upstream`
 * maps a built file's real path to the package directories its build inlined.
 */
export function missingNotices(chunks, upstream = new Map()) {
  const gaps = [];
  for (const chunk of chunks) {
    const dirs = new Set(inlinedPackageDirs(chunk.moduleIds));
    for (const id of chunk.moduleIds) {
      for (const dir of upstream.get(id) ?? []) dirs.add(dir);
    }
    const code = flatten(chunk.code);
    for (const dir of dirs) {
      const notice = packageNotice(dir);
      if (notice.texts.every((t) => code.includes(flatten(commentSafe(t))))) {
        continue;
      }
      gaps.push(
        `${relative(repoRoot, chunk.path)}: inlines ${notice.name} ${notice.version} ` +
          `(${relative(repoRoot, dir)}) without its license text`,
      );
    }
  }
  return gaps;
}

async function main() {
  const core = await rollupChunks("packages/core", "rollup.config.ts");
  const upstream = new Map(
    core.map((chunk) => [
      realpathSync(chunk.path),
      inlinedPackageDirs(chunk.moduleIds),
    ]),
  );
  const relay = await rollupChunks("packages/sftp-relay", "rollup.config.mjs");
  const server = await consoleServerChunks();
  const gaps = missingNotices([...core, ...relay, ...server], upstream);
  if (gaps.length > 0) {
    console.error(
      "check:bundle-notices: a bundle inlines a package without its license text. " +
        "Add bundleNotices() from scripts/lib/bundleNotices.mjs to the bundle's " +
        "config, and rebuild core (npm run build -w packages/core) if its dist " +
        "is older than its sources.",
    );
    for (const gap of gaps) console.error(`  ${gap}`);
    process.exit(1);
  }
  for (const chunk of [...core, ...relay, ...server]) {
    const count = new Set([
      ...inlinedPackageDirs(chunk.moduleIds),
      ...chunk.moduleIds.flatMap((id) => upstream.get(id) ?? []),
    ]).size;
    if (count === 0) continue;
    console.log(
      `check:bundle-notices: ${relative(repoRoot, chunk.path)} carries the notices of ${count} inlined package(s)`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
