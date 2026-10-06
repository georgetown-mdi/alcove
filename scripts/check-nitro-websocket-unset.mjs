#!/usr/bin/env node
// nitro.config.ts websocket-unset check, run by static_checks.yaml on every PR.
//
// apps/web/server/custom-entry.ts wires no production upgrade listener onto
// the hosted server: the signaling broker is a service of its own, and a
// signaling upgrade there gets the /api refusal's 404
// (apps/web/test/integration/apiNamespace.test.ts holds that). Nitro's own
// WebSocket support -- crossws's node adapter, gated behind
// `experimental.websocket` in the Nitro config -- would attach a
// `server.on("upgrade", ...)` listener with no path check of its own, opening
// an upgrade surface on the public server that nothing here bounds or
// reviews. So `experimental.websocket` must stay unset.
//
// This is a "does not happen at runtime" claim, which CLAUDE.md's Agent
// conventions and CONTRIBUTING.md's Code Conventions say belongs in an
// executable check rather than a comment that can rot silently -- so this
// check is that gate: it fails when apps/web/nitro.config.ts turns
// `experimental.websocket` on.
//
// Driven against the REAL config, not a model of it: this loads
// apps/web/nitro.config.ts through a plain `node` import -- Node's strip-only
// type stripping loads it cleanly, the same load path
// check-web-config-native-load.mjs drives against apps/web/vite.config.ts --
// and reads the resulting object, rather than parsing the source text or
// reimplementing defineNitroConfig's own resolution.
//
// What this check does not cover:
//   - Any OTHER way an upgrade listener could be attached to the hosted
//     server. It watches only the one setting -- `experimental.websocket` --
//     that wires the crossws adapter through Nitro's own build.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The config this check guards, relative to the repository root. */
export const NITRO_CONFIG = "apps/web/nitro.config.ts";

/**
 * Loads NITRO_CONFIG under `root` through a plain `node` import and returns
 * its default export -- the real, resolved Nitro config object.
 */
export async function loadNitroConfig(root) {
  const configFile = resolve(root, NITRO_CONFIG);
  const loaded = await import(pathToFileURL(configFile).href);
  return loaded.default;
}

/** Whether a loaded Nitro config object turns `experimental.websocket` on. */
export function websocketEnabled(config) {
  return Boolean(config?.experimental?.websocket);
}

const FAILURE_MESSAGE = [
  `${NITRO_CONFIG} sets experimental.websocket, which wires a WebSocket`,
  "upgrade listener with no path check onto the hosted server, which",
  "otherwise serves no upgrade -- see this script's header comment for why.",
  "Unset it.",
].join(" ");

/**
 * Loads NITRO_CONFIG under `root` (via `load`, injectable for a test) and
 * reports `{ok, message}`.
 */
export async function checkNitroWebsocketUnset({
  root,
  load = loadNitroConfig,
} = {}) {
  const config = await load(root);
  if (websocketEnabled(config)) {
    return { ok: false, message: FAILURE_MESSAGE };
  }
  return {
    ok: true,
    message: `${NITRO_CONFIG} sets no experimental.websocket.`,
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit. `--root` points the run at another
// tree, which is how the test drives a fixture config this repository does
// not hold.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(
      "usage: node scripts/check-nitro-websocket-unset.mjs [--root <tree>]",
    );
    process.exit(2);
  }
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(args[rootFlag + 1]);

  const { ok, message } = await checkNitroWebsocketUnset({ root });
  (ok ? console.log : console.error)(
    `nitro websocket-unset check ${ok ? "passed" : "failed"}: ${message}`,
  );
  if (!ok) process.exit(1);
}
