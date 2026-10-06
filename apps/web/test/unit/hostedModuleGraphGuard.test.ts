import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";
import { build } from "vite";

import {
  clientModuleGraphGuard,
  isServerOnlyModule,
} from "../../hosted/moduleGraphGuard";

const requireFromWeb = createRequire(import.meta.url);

describe("isServerOnlyModule", () => {
  test.each([
    "node:fs",
    "/repo/node_modules/env-schema/index.js",
    "C:\\repo\\node_modules\\dotenv\\lib\\main.js",
    "dotenv/config",
    "env-schema",
  ])("names %s", (id) => {
    expect(isServerOnlyModule(id)).toBe(true);
  });

  test.each([
    "url",
    "__vite-browser-external",
    "/repo/node_modules/env-schema-extra/index.js",
    "/repo/node_modules/dotenv-expand/lib/main.js",
    "/repo/src/node:thing.ts",
  ])("passes %s", (id) => {
    expect(isServerOnlyModule(id)).toBe(false);
  });
});

describe("clientModuleGraphGuard over a real browser build", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function buildFixture(
    main: string,
    worker = "postMessage(1);",
  ): Promise<void> {
    root = mkdtempSync(join(tmpdir(), "alcove-module-graph-"));
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><script type="module" src="./main.js"></script>',
    );
    writeFileSync(join(root, "main.js"), main);
    writeFileSync(join(root, "worker.js"), worker);
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      resolve: {
        alias: { "env-schema": requireFromWeb.resolve("env-schema") },
      },
      build: { write: false },
      plugins: [clientModuleGraphGuard()],
      worker: { plugins: () => [clientModuleGraphGuard()] },
    });
  }

  test("fails on a node: import", async () => {
    await expect(
      buildFixture(
        'import { readFileSync } from "node:fs"; console.log(readFileSync);',
      ),
    ).rejects.toThrow(/server-only modules: node:fs \(from .*main\.js\)/);
  });

  test("fails on a side-effect-only node: import", async () => {
    await expect(buildFixture('import "node:path";')).rejects.toThrow(
      /server-only modules: node:path \(from .*main\.js\)/,
    );
  });

  test("fails on a node: import in a worker", async () => {
    await expect(
      buildFixture(
        'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });',
        'import { join } from "node:path"; postMessage(join("a", "b"));',
      ),
    ).rejects.toThrow(/server-only modules: node:path \(from .*worker\.js\)/);
  });

  test("fails on env-schema", async () => {
    await expect(
      buildFixture(
        'import envSchema from "env-schema"; console.log(envSchema);',
      ),
    ).rejects.toThrow(
      /server-only modules: \S*node_modules\/env-schema\/\S* \(from \S*main\.js\)/,
    );
  });

  test("passes a graph with neither", async () => {
    await expect(
      buildFixture('import url from "url"; console.log(url, "ok");'),
    ).resolves.toBeUndefined();
  });
});
