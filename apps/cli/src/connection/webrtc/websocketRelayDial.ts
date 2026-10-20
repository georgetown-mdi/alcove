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
  RunWebSocketRelay,
  WebRTCConnectionConfig,
} from "@alcove/core";

/**
 * The refusal a run gets when its connection lists a WebSocket relay and the
 * run holds no shared secret to make the relay's proof from: `source` names
 * the setting that lists it, the connection's own `websocket_relay` or the
 * invitation's relay.
 *
 * @internal exported for testing
 */
export function websocketRelayNeedsSecretMessage(
  url: string,
  source: RunWebSocketRelay["source"] = "own",
): string {
  return (
    `the WebSocket relay at ${url} takes a proof made from the exchange's ` +
    "shared secret, and this run holds none. Establish one with 'alcove " +
    "invite' and 'alcove accept', or remove " +
    (source === "own"
      ? "connection.websocket_relay."
      : "websocket from connection.invitation_relay.")
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
  const [first] = relays;
  if (first === undefined) return [];
  if (sharedSecret === undefined)
    throw new UsageError(
      websocketRelayNeedsSecretMessage(first.url, first.source),
    );
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
