import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  SIGNALING_DISCOVERY_PATH,
  parseBoundedJson,
  signalingServerFromDiscoveryDocument,
} from "@alcove/core";

import { hostedSignalingDiscoveryFile } from "../../hosted/signalingDiscoveryFile";

import type { ResolvedConfig } from "vite";

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
