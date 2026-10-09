import {
  SIGNALING_DISCOVERY_PATH,
  signalingDiscoveryDocumentSource,
} from "@alcove/core";

import type { Plugin } from "vite";

/**
 * Writes {@link SIGNALING_DISCOVERY_PATH} into the hosted build's output,
 * naming the coordination server the build is configured with
 * (`VITE_SIGNALING_SERVER_URL`), so `alcove invite` given the app's address
 * dials the server the app's own browser parties use. The build fails when the
 * setting is one no reader would take.
 */
export function hostedSignalingDiscoveryFile(): Plugin {
  let source: string;
  return {
    name: "alcove-hosted-signaling-discovery-file",
    apply: "build",
    configResolved(config) {
      source = signalingDiscoveryDocumentSource(
        String(config.env["VITE_SIGNALING_SERVER_URL"] ?? ""),
      );
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: SIGNALING_DISCOVERY_PATH.slice(1),
        source,
      });
    },
  };
}
