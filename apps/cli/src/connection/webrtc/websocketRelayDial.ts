import {
  UsageError,
  deriveRelayExchangeId,
  deriveRelayKey,
  selectRunRelay,
} from "@alcove/core";

import type { WebSocketRelayDial } from "./websocketRelayConnection";
import type {
  RendezvousRole,
  RunRelayConnection,
  WebRTCConnectionConfig,
} from "@alcove/core";

/**
 * The refusal a run gets when its connection lists WebSocket relays and the
 * run holds no shared secret to make their proofs from, naming every relay
 * the run lists. It names no edit that leaves them out: a webrtc run with no
 * shared secret is refused whatever relays it lists
 * (`WEBRTC_RENDEZVOUS_SECRET_REQUIRED` in run/prepare.ts).
 *
 * @internal exported for testing
 */
export function websocketRelayNeedsSecretMessage(
  connection: RunRelayConnection,
): string {
  const urls = (selectRunRelay(connection).websocket ?? []).map(
    (relay) => relay.url,
  );
  const one = urls.length === 1;
  return (
    `the WebSocket ${one ? "relay" : "relays"} at ${urls.join(" and ")} ` +
    `${one ? "takes" : "take"} a proof made from the exchange's shared ` +
    "secret, and this run holds none. Establish one with 'alcove invite' " +
    "and 'alcove accept'."
  );
}

/**
 * Resolve every WebSocket relay a run lists (`selectRunRelay(...).websocket`
 * in core: the connection's own `websocket_relay`, then the invitation's,
 * less those `allowed_relays` leaves out) into what its socket is dialed
 * with, before anything is dialed: the relay key derived from the current
 * shared secret, and the exchange id that key is enrolled under at that
 * relay, the one the connection or the invitation names for it and
 * otherwise the id derived from the secret, the one an enrollment without a
 * token uses (docs/spec/PROTOCOL.md, "Relay credential derivation"). Empty
 * when the run lists none.
 *
 * @throws {UsageError} if the run lists a relay and `sharedSecret` is
 *   undefined.
 */
export async function webSocketRelayDialsFor(
  connection: RunRelayConnection,
  sharedSecret: string | undefined,
  role: RendezvousRole,
): Promise<WebSocketRelayDial[]> {
  const relays = selectRunRelay(connection).websocket ?? [];
  if (relays.length === 0) return [];
  if (sharedSecret === undefined)
    throw new UsageError(websocketRelayNeedsSecretMessage(connection));
  const relayKey = await deriveRelayKey(sharedSecret);
  const derivedExchangeId = await deriveRelayExchangeId(sharedSecret);
  return relays.map((relay) => ({
    url: relay.url,
    exchangeId: relay.exchangeId ?? derivedExchangeId,
    relayKey,
    role,
  }));
}

/** @internal */
export async function webSocketRelayDialFor(
  connection: Pick<WebRTCConnectionConfig, "websocketRelay" | "relayRegistrar">,
  sharedSecret: string | undefined,
  role: RendezvousRole,
): Promise<WebSocketRelayDial | undefined> {
  const [dial] = await webSocketRelayDialsFor(
    {
      websocketRelay: connection.websocketRelay,
      relayRegistrar: connection.relayRegistrar,
    },
    sharedSecret,
    role,
  );
  return dial;
}
