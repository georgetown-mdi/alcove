#!/usr/bin/env node
// Packs the part of a built @alcove/core the broker's host runs: the
// standalone signaling broker's entry, `untrusted-text.esm.js`, the WebSocket
// relay's, `websocket-relay.esm.js`, and every chunk either imports, found by
// following the built files' relative imports rather than named here. Copies
// them into an output directory beside a `sha256sum -c` manifest covering
// every file, for broker_core_build.yaml to archive, sign and publish.
//
//   node scripts/pack-broker-core.mjs <core-dist-dir> <out-dir>
//
// Prints each file written, the manifest last, one per line. Refuses an import
// of a package or of a path outside the dist directory: the archive holds
// core's own files alone, so either would be missing where it is unpacked.
// Refuses an output directory that already exists, so no earlier file is
// packed. Exit 0 on success, 1 on a refusal.

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/** The built entry point `@alcove/core/untrusted-text` resolves to on import. */
export const SIGNALING_BROKER_ENTRY = "untrusted-text.esm.js";

/** The built entry point `@alcove/core/websocket-relay` resolves to on import. */
export const WEBSOCKET_RELAY_ENTRY = "websocket-relay.esm.js";

/** Every entry point the archive packs, with the chunks each imports. */
export const BROKER_CORE_ENTRIES = [
  SIGNALING_BROKER_ENTRY,
  WEBSOCKET_RELAY_ENTRY,
];

/** The manifest's file name, inside the output directory. */
export const MANIFEST_NAME = "SHA256SUMS";

/**
 * Every module specifier a built JavaScript source names: static imports,
 * re-exports and dynamic `import()` calls with a literal argument.
 */
export function moduleSpecifiers(source) {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName }) => fileName);
}

const toPosix = (path) => path.split(sep).join("/");

/**
 * The files, relative to `distDir` and sorted, that the module graphs rooted
 * at `entries` reach through relative imports, each file once. `node:`
 * builtins are skipped; any other bare specifier, a path resolving outside
 * `distDir` or a missing file throws.
 */
export function brokerCoreFiles(distDir, entries = BROKER_CORE_ENTRIES) {
  const root = resolve(distDir);
  const found = new Set();
  const visit = (relativePath, importedFrom) => {
    if (found.has(relativePath)) return;
    const path = join(root, relativePath);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      throw new Error(
        importedFrom === undefined
          ? `${relativePath} is not a file under ${root}. Build core first: npm run build -w packages/core`
          : `${relativePath}, imported by ${importedFrom}, is not a file under ${root}.`,
      );
    }
    found.add(relativePath);
    for (const specifier of moduleSpecifiers(readFileSync(path, "utf8"))) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(
          `${relativePath} imports "${specifier}", which is not a file of the built core; the archive cannot include it.`,
        );
      }
      const target = relative(root, resolve(dirname(path), specifier));
      if (target === "" || target.startsWith("..") || isAbsolute(target)) {
        throw new Error(
          `${relativePath} imports "${specifier}", which resolves outside ${root}.`,
        );
      }
      visit(toPosix(target), relativePath);
    }
  };
  for (const entry of entries) visit(toPosix(entry), undefined);
  return [...found].sort();
}

/**
 * A `sha256sum -c` manifest of `files` under `distDir`: one
 * `<hex digest>  <path>` line each, in the order given.
 */
export function sha256Manifest(distDir, files) {
  return files
    .map((file) => {
      const digest = createHash("sha256")
        .update(readFileSync(join(distDir, file)))
        .digest("hex");
      return `${digest}  ${file}\n`;
    })
    .join("");
}

/**
 * Copies the closure of every entry in `distDir` into `outDir`, which must not
 * exist, with the manifest beside it. Returns every name written, the
 * manifest last.
 */
export function packBrokerCore(distDir, outDir) {
  const files = brokerCoreFiles(distDir);
  if (files.includes(MANIFEST_NAME)) {
    throw new Error(
      `the built core holds a module named ${MANIFEST_NAME}, the manifest's own name.`,
    );
  }
  mkdirSync(outDir);
  for (const file of files) {
    mkdirSync(dirname(join(outDir, file)), { recursive: true });
    copyFileSync(join(distDir, file), join(outDir, file));
  }
  writeFileSync(join(outDir, MANIFEST_NAME), sha256Manifest(distDir, files));
  return [...files, MANIFEST_NAME];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [distDir, outDir] = process.argv.slice(2);
  if (distDir === undefined || outDir === undefined) {
    console.error(
      "Usage: node scripts/pack-broker-core.mjs <core-dist-dir> <out-dir>",
    );
    process.exit(1);
  }
  try {
    for (const name of packBrokerCore(distDir, outDir)) console.log(name);
  } catch (error) {
    console.error(
      `pack-broker-core: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
