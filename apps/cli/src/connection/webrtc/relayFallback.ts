import {
  AuthenticationError,
  getLogger,
  raceWebRtcAgainstRelays,
  redactAndSanitizeForDisplay,
  sanitizeErrorForDisplay,
} from "@alcove/core";

import { openWebRtcMessageConnection } from "./webrtcMessageConnection";
import { parkWebSocketRelay } from "./websocketRelayConnection";

import type { WebRtcMessageConnectionOptions } from "./webrtcMessageConnection";
import type {
  WebSocketRelayConnectionOptions,
  WebSocketRelayDial,
} from "./websocketRelayConnection";
import type { WebRtcPeerOptions } from "./weriftPeer";
import type { MessageConnection, RelayFallbackAdapter } from "@alcove/core";

/**
 * The fallback from WebRTC to the WebSocket relay
 * (docs/spec/WEBRTC_TRANSPORT.md, Falling back to the WebSocket relay), run by
 * core's {@link raceWebRtcAgainstRelays} over this application's transports.
 */

/**
 * The command-line application's side of the race: a certificate that did not
 * verify stays fatal after a path failure, and a relay's address and every
 * failure are logged redacted and escaped.
 *
 * @internal
 */
export const CLI_RELAY_FALLBACK: RelayFallbackAdapter<MessageConnection> = {
  log: getLogger("webrtc"),
  fromRelay: (connection) => connection,
  closeUnused: (connection) => {
    void connection.close().catch(() => {});
  },
  isFatal: (error) => error instanceof AuthenticationError,
  displayUrl: (url) => redactAndSanitizeForDisplay(url),
  describeWebRtcFailure: (error) => sanitizeErrorForDisplay(error),
  displayRefusal: (refusal) => sanitizeErrorForDisplay(refusal),
};

/**
 * Open the run's connection to its partner: over WebRTC alone when the run
 * lists no WebSocket relay, which dials nothing else, and otherwise raced
 * against those relays by {@link raceWebRtcAgainstRelays}.
 *
 * @param relayOptions Tests only.
 */
export async function openWebRtcWithRelayFallback(
  options: WebRtcPeerOptions & WebRtcMessageConnectionOptions,
  relays: ReadonlyArray<WebSocketRelayDial>,
  relayOptions: WebSocketRelayConnectionOptions = {},
): Promise<MessageConnection> {
  if (relays.length === 0) return openWebRtcMessageConnection(options);
  const parked = relays.map((dial) =>
    parkWebSocketRelay(dial, {
      rendezvousTimeoutMs: options.rendezvousTimeoutMs,
      channelOpenTimeoutMs: options.channelOpenTimeoutMs,
      inactivityTimeoutMs: options.inactivityTimeoutMs,
      closeFlushTimeoutMs: options.closeFlushTimeoutMs,
      ...relayOptions,
    }),
  );
  const { connection } = await raceWebRtcAgainstRelays(
    {
      role: options.role,
      relays: parked,
      signal: options.signal,
      openWebRtc: ({ signal, onPathFailed }) =>
        openWebRtcMessageConnection({ ...options, signal, onPathFailed }),
    },
    CLI_RELAY_FALLBACK,
  );
  return connection;
}
