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
  let source: string | undefined;
  return {
    name: "alcove-hosted-signaling-discovery-file",
    apply: "build",
    configResolved(config) {
      const signalingServer: unknown = config.env["VITE_SIGNALING_SERVER_URL"];
      if (typeof signalingServer !== "string")
        throw new Error(
          "VITE_SIGNALING_SERVER_URL is not set, so the hosted build cannot " +
            `write ${SIGNALING_DISCOVERY_PATH}. Set it to the broker's ws: or ` +
            "wss: URL and rebuild.",
        );
      source = signalingDiscoveryDocumentSource(signalingServer);
    },
    generateBundle() {
      if (source === undefined)
        throw new Error(
          `${SIGNALING_DISCOVERY_PATH} was not prepared before the bundle was written.`,
        );
      this.emitFile({
        type: "asset",
        fileName: SIGNALING_DISCOVERY_PATH.slice(1),
        source,
      });
    },
  };
}
