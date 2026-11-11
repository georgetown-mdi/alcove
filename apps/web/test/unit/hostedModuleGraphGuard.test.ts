import { createContext, runInContext } from "node:vm";
import { join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";
import { build } from "vite";

import {
  DIFFIE_HELLMAN_PACKAGE,
  clientModuleGraphGuard,
  isDiffieHellmanModule,
  isServerOnlyModule,
} from "../../hosted/moduleGraphGuard";
import {
  browserSshDedupe,
  browserSshDependencyAliases,
  srcAliasEntries,
} from "../../vite.config";

import type { AliasOptions, Rolldown } from "vite";

type OutputChunk = Rolldown.OutputChunk;
type RolldownOutput = Rolldown.RolldownOutput;

const requireFromWeb = createRequire(import.meta.url);
const webRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(webRoot, "../..");

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

describe("isDiffieHellmanModule", () => {
  test.each([
    "diffie-hellman",
    "/repo/node_modules/diffie-hellman/browser.js",
    "C:\\repo\\node_modules\\diffie-hellman\\lib\\dh.js",
    "/repo/node_modules/@microsoft/dev-tunnels-ssh/node_modules/diffie-hellman/browser.js",
  ])("names %s", (id) => {
    expect(isDiffieHellmanModule(id)).toBe(true);
  });

  // Packages diffie-hellman brings that other dependencies bring too.
  test.each([
    "/repo/apps/web/src/psi/transport/browserSsh/stubs/diffieHellman.ts",
    "/repo/node_modules/diffie-hellman-extra/index.js",
    "/repo/node_modules/@noble/curves/abstract/montgomery.js",
    "/repo/node_modules/bn.js/lib/bn.js",
    "/repo/node_modules/safe-buffer/index.js",
    "randombytes/browser.js",
  ])("passes %s", (id) => {
    expect(isDiffieHellmanModule(id)).toBe(false);
  });

  // The alias hands the stub to every importer of diffie-hellman, so a second
  // dependency requiring it would get a stub that throws; it fails here first.
  test("is required in package-lock.json only by the SSH library", () => {
    const lock = JSON.parse(
      readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"),
    ) as {
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        }
      >;
    };
    const requirers = Object.entries(lock.packages)
      .filter(([, entry]) =>
        [
          entry.dependencies,
          entry.optionalDependencies,
          entry.peerDependencies,
        ].some((list) => list !== undefined && DIFFIE_HELLMAN_PACKAGE in list),
      )
      .map(([path]) => path);
    expect(requirers).toEqual(["node_modules/@microsoft/dev-tunnels-ssh"]);
  });
});

describe("the diffie-hellman chain over a real browser build", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  /**
   * Build `main` as a browser library bundle and return its one chunk. The
   * project root is this app's, as in the hosted build, since `dedupe`
   * resolves from it; nothing is written there.
   */
  async function buildBrowserSshFixture(
    main: string,
    resolveOptions: { alias: AliasOptions; dedupe?: Array<string> },
  ): Promise<OutputChunk> {
    root = mkdtempSync(join(tmpdir(), "alcove-module-graph-"));
    writeFileSync(join(root, "main.js"), main);
    const output = (await build({
      root: webRoot,
      configFile: false,
      envFile: false,
      publicDir: false,
      logLevel: "silent",
      resolve: resolveOptions,
      build: {
        write: false,
        minify: false,
        lib: {
          entry: join(root, "main.js"),
          formats: ["iife"],
          name: "fixture",
        },
      },
      plugins: [clientModuleGraphGuard()],
    })) as RolldownOutput | Array<RolldownOutput>;
    const outputs = Array.isArray(output) ? output : [output];
    const chunks = outputs
      .flatMap(({ output: files }) => files)
      .filter((file): file is OutputChunk => file.type === "chunk");
    expect(chunks).toHaveLength(1);
    return chunks[0];
  }

  const sshAlgorithmsPath = requireFromWeb.resolve(
    "@microsoft/dev-tunnels-ssh/algorithms/sshAlgorithms",
  );
  const libraryFixture = `import { SshAlgorithms } from ${JSON.stringify(sshAlgorithmsPath)}; console.log(SshAlgorithms);`;
  const clientFixture = `import { connectBrowserSsh } from ${JSON.stringify(
    join(webRoot, "src/psi/transport/browserSsh/browserSshClient.ts"),
  )}; globalThis.connectBrowserSsh = connectBrowserSsh;`;

  test("fails a bundle of the library without the diffie-hellman alias", async () => {
    await expect(
      buildBrowserSshFixture(libraryFixture, {
        alias: browserSshDependencyAliases.filter(
          ({ find }) => !find.test("diffie-hellman"),
        ),
      }),
    ).rejects.toThrow(
      /diffie-hellman package: .*\bdiffie-hellman \(from \S*webKeyExchange\.js\)/,
    );
  });

  test("passes a bundle of the library with the alias", async () => {
    const chunk = await buildBrowserSshFixture(libraryFixture, {
      alias: browserSshDependencyAliases,
    });
    expect(Object.keys(chunk.modules).some(isDiffieHellmanModule)).toBe(false);
  });

  test("bundles the client with the hosted aliases: one buffer, and the library's Node code never runs", async () => {
    const chunk = await buildBrowserSshFixture(clientFixture, {
      alias: [...srcAliasEntries, ...browserSshDependencyAliases],
      dedupe: browserSshDedupe,
    });
    const modules = Object.keys(chunk.modules).map((id) =>
      id.replace(/\\/g, "/"),
    );
    expect(
      modules.filter((id) => /\/node_modules\/buffer\/index\.js$/.test(id)),
    ).toHaveLength(1);
    // A browser has `self` and `crypto.subtle` and no `process`; the library
    // chooses its WebCrypto classes there, and a Node class loaded anyway would
    // read `process` and throw.
    const page = createContext({
      self: {},
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      console: { log() {}, warn() {}, error() {}, debug() {} },
      setTimeout,
      clearTimeout,
      queueMicrotask,
    });
    runInContext(chunk.code, page);
    expect(
      typeof (page as { connectBrowserSsh?: unknown }).connectBrowserSsh,
    ).toBe("function");
  });
});
