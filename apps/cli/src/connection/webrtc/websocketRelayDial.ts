import {
  UsageError,
  deriveRelayExchangeId,
  deriveRelayKey,
} from "@alcove/core";

import type { WebSocketRelayDial } from "./websocketRelayConnection";
import type { RendezvousRole, WebRTCConnectionConfig } from "@alcove/core";

/**
 * The refusal a run gets when its connection names a WebSocket relay and the
 * run holds no shared secret to make the relay's proof from.
 *
 * @internal exported for testing
 */
export function websocketRelayNeedsSecretMessage(url: string): string {
  return (
    `the WebSocket relay at ${url} takes a proof made from the exchange's ` +
    "shared secret, and this run holds none. Establish one with 'alcove " +
    "invite' and 'alcove accept', or remove connection.websocket_relay."
  );
}

/**
 * Resolve the connection's `websocket_relay` into what its socket is dialed
 * with, before anything is dialed: the relay key derived from the current
 * shared secret, and the exchange id that key is enrolled under, which is
 * `relay_registrar`'s when one is set and otherwise the id derived from the
 * secret, the one an enrollment without a token uses (docs/spec/PROTOCOL.md,
 * "Relay credential derivation"). Returns `undefined` when the connection
 * names no relay.
 *
 * @throws {UsageError} if the connection names a relay and `sharedSecret` is
 *   undefined.
 */
export async function webSocketRelayDialFor(
  connection: Pick<WebRTCConnectionConfig, "websocketRelay" | "relayRegistrar">,
  sharedSecret: string | undefined,
  role: RendezvousRole,
): Promise<WebSocketRelayDial | undefined> {
  const url = connection.websocketRelay;
  if (url === undefined) return undefined;
  if (sharedSecret === undefined)
    throw new UsageError(websocketRelayNeedsSecretMessage(url));
  return {
    url,
    exchangeId:
      connection.relayRegistrar?.exchangeId ??
      (await deriveRelayExchangeId(sharedSecret)),
    relayKey: await deriveRelayKey(sharedSecret),
    role,
  };
}
