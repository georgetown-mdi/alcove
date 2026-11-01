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
 * With `previousSharedSecret`, each relay dialed under the derived id is
 * dialed a second time under the id and key that secret derives, where a
 * partner that did not save the new secret dials it. A relay under an id the
 * connection or the invitation names is dialed once, under the current key,
 * the key its registrar holds.
 *
 * @throws {UsageError} if the run lists a relay and `sharedSecret` is
 *   undefined.
 */
export async function webSocketRelayDialsFor(
  connection: RunRelayConnection,
  sharedSecret: string | undefined,
  role: RendezvousRole,
  previousSharedSecret?: string,
): Promise<WebSocketRelayDial[]> {
  const relays = selectRunRelay(connection).websocket ?? [];
  if (relays.length === 0) return [];
  if (sharedSecret === undefined)
    throw new UsageError(websocketRelayNeedsSecretMessage(connection));
  const relayKey = await deriveRelayKey(sharedSecret);
  const derivedExchangeId = await deriveRelayExchangeId(sharedSecret);
  const dials = relays.map((relay) => ({
    url: relay.url,
    exchangeId: relay.exchangeId ?? derivedExchangeId,
    relayKey,
    role,
  }));
  const derivedOnly = relays.filter((relay) => relay.exchangeId === undefined);
  if (previousSharedSecret === undefined || derivedOnly.length === 0)
    return dials;
  const previousKey = await deriveRelayKey(previousSharedSecret);
  const previousExchangeId = await deriveRelayExchangeId(previousSharedSecret);
  return [
    ...dials,
    ...derivedOnly.map((relay) => ({
      url: relay.url,
      exchangeId: previousExchangeId,
      relayKey: previousKey,
      role,
    })),
  ];
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
