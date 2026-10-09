// The published entry points import no PSI engine: each caller of
// loadPsiBackend supplies its own loaders, so a browser bundle of
// `@alcove/core` reaches neither the node WASM entry nor the native addon
// through core. Read from the built artifacts, since a bundler resolves those.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, expect, test } from "vitest";

import {
  CORE_PACKAGE,
  requireFreshDists,
} from "../../../scripts/lib/distFreshness.mjs";

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
];

function importSpecifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS)
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
}

let specifiersByFile;

beforeAll(() => {
  requireFreshDists({ packages: [CORE_PACKAGE], allowOptOut: false });
  const distDir = join(CORE_PACKAGE.dir, "dist");
  specifiersByFile = new Map(
    readdirSync(distDir)
      .filter((name) => name.endsWith(".js") || name.endsWith(".cjs"))
      .map((name) => [
        name,
        importSpecifiers(readFileSync(join(distDir, name), "utf8")),
      ]),
  );
});

test("the scan reads the built entry points' imports", () => {
  expect(specifiersByFile.get("core.esm.js")).toContain("zod");
  expect(specifiersByFile.get("core.cjs")).toContain("zod");
});

test("no built entry point imports a PSI engine or a native addon", () => {
  const engineImports = [...specifiersByFile].flatMap(([file, specifiers]) =>
    [...specifiers]
      .filter(
        (specifier) =>
          specifier.startsWith("@openmined/psi.js") ||
          specifier.endsWith(".node"),
      )
      .map((specifier) => `${file}: ${specifier}`),
  );
  expect(engineImports).toEqual([]);
});
