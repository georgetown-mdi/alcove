import { getLogger } from "@alcove/core";

import type { SignalingDiagnosticSink } from "@alcove/peerjs-broker";

const log = getLogger("peerjs-broker");

/**
 * A broker diagnostic sink that writes through a prefixed `@alcove/core`
 * logger, so a test capturing core's diagnostic sink picks the broker's lines
 * out by their context. The text arrives escaped, capped and rate limited from
 * the broker's diagnostics module, so it is written as it stands.
 */
export const brokerDiagnosticSink: SignalingDiagnosticSink = (message) => {
  log.warn(message);
};
