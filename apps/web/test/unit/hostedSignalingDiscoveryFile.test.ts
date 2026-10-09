import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer } from "vite";

import {
  SIGNALING_DISCOVERY_PATH,
  parseBoundedJson,
  signalingServerFromDiscoveryDocument,
} from "@alcove/core";

import { OWN_SIGNALING_PATH } from "@psi/transport/signalingAddress";

import devConfig, {
  devSignalingDiscoveryDocument,
  devSignalingDiscoveryFile,
} from "../../vite.config";
import { hostedSignalingDiscoveryFile } from "../../hosted/signalingDiscoveryFile";

import type { Plugin, ResolvedConfig } from "vite";
import type { AddressInfo } from "node:net";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const builtDiscoveryFile = `${appRoot}dist/hosted${SIGNALING_DISCOVERY_PATH}`;

interface EmittedAsset {
  type: string;
  fileName: string;
  source: string;
}

function runPlugin(env: Record<string, unknown>): Array<EmittedAsset> {
  const plugin = hostedSignalingDiscoveryFile();
  const emitted: Array<EmittedAsset> = [];
  const configResolved = plugin.configResolved as (
    config: Pick<ResolvedConfig, "env">,
  ) => void;
  const generateBundle = plugin.generateBundle as (this: {
    emitFile: (asset: EmittedAsset) => string;
  }) => void;
  configResolved({ env });
  generateBundle.call({
    emitFile: (asset) => {
      emitted.push(asset);
      return asset.fileName;
    },
  });
  return emitted;
}

describe("the hosted build's published coordination server", () => {
  test("names the configured server at the discovery path", () => {
    const emitted = runPlugin({
      VITE_SIGNALING_SERVER_URL: "wss://signal.example.org:8443/api/",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "asset",
      fileName: "alcove.json",
    });
    expect(parseBoundedJson(emitted[0].source)).toEqual({
      signaling_server: "wss://signal.example.org:8443/api/",
    });
  });

  test("states the mount with its slash, as the browser dials it", () => {
    const [asset] = runPlugin({
      VITE_SIGNALING_SERVER_URL: "wss://signal.example.org/api",
    });
    expect(parseBoundedJson(asset.source)).toEqual({
      signaling_server: "wss://signal.example.org/api/",
    });
  });

  test.each([undefined, "https://signal.example.org/api/", "not a url"])(
    "fails the build for the setting %j",
    (value) => {
      expect(() => runPlugin({ VITE_SIGNALING_SERVER_URL: value })).toThrow(
        /VITE_SIGNALING_SERVER_URL|cannot be published/,
      );
    },
  );

  test("is not a public/ file, which the console would serve", () => {
    expect(existsSync(`${appRoot}public${SIGNALING_DISCOVERY_PATH}`)).toBe(
      false,
    );
  });

  // Needs `npm run build -w apps/web` first.
  test.skipIf(!existsSync(builtDiscoveryFile))(
    "is in the hosted build's output, in a form the CLI reads",
    () => {
      const document = parseBoundedJson(
        readFileSync(builtDiscoveryFile, "utf8"),
      );
      expect(signalingServerFromDiscoveryDocument(document)).toBeDefined();
    },
  );
});

describe("the dev server's published coordination server", () => {
  const roots: Array<string> = [];
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const close of closers.splice(0)) await close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  });

  /** A real Vite dev server with only the plugin, behind a loopback listener. */
  async function devServer(): Promise<string> {
    const root = mkdtempSync(path.join(tmpdir(), "alcove-dev-discovery-"));
    roots.push(root);
    const vite = await createServer({
      configFile: false,
      root,
      envDir: root,
      appType: "custom",
      logLevel: "silent",
      server: { middlewareMode: true, ws: false },
      plugins: [devSignalingDiscoveryFile()],
    });
    const server = createHttpServer(vite.middlewares);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    closers.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await vite.close();
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function published(origin: string): Promise<URL | undefined> {
    const response = await fetch(new URL(SIGNALING_DISCOVERY_PATH, origin));
    expect(response.status).toBe(200);
    return signalingServerFromDiscoveryDocument(
      parseBoundedJson(await response.text()),
    );
  }

  test("names the page origin's /api/ when no server is configured", async () => {
    vi.stubEnv("VITE_SIGNALING_SERVER_URL", undefined);
    const origin = await devServer();
    const host = new URL(origin).host;
    expect((await published(origin))?.href).toBe(
      `ws://${host}${OWN_SIGNALING_PATH}`,
    );
  });

  test("names the configured server when one is set", async () => {
    vi.stubEnv("VITE_SIGNALING_SERVER_URL", "ws://127.0.0.1:9000/psi");
    const origin = await devServer();
    expect((await published(origin))?.href).toBe("ws://127.0.0.1:9000/psi/");
  });

  test("is installed by the dev config", () => {
    const plugins = devConfig({
      command: "serve",
      mode: "development",
    }).plugins?.flat() as Array<Plugin | null | false | undefined>;
    expect(plugins.map((plugin) => plugin && plugin.name)).toContain(
      devSignalingDiscoveryFile().name,
    );
  });

  test("states a wss: server for an https: dev server", () => {
    expect(
      parseBoundedJson(
        devSignalingDiscoveryDocument(undefined, "localhost:5173", true),
      ),
    ).toEqual({ signaling_server: "wss://localhost:5173/api/" });
  });
});
