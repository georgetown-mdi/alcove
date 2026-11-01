import { afterAll, beforeAll, expect, test } from "vitest";

import {
  ConnectionError,
  deriveRelayExchangeId,
  deriveRelayKey,
  generateSharedSecret,
} from "@alcove/core";

import { parkWebSocketRelay } from "../../../src/connection/webrtc/websocketRelayConnection";
import { webSocketRelayDialsFor } from "../../../src/connection/webrtc/websocketRelayDial";
import { startWebSocketRelayProcess } from "../../signaling/websocketRelayProcess";

import type { ParkedWebSocketRelay } from "../../../src/connection/webrtc/websocketRelayConnection";
import type { WebSocketRelayProcess } from "../../signaling/websocketRelayProcess";

/**
 * The relay a run cut between the two saves of a rotation meets on its next
 * run, measured against the repository's WebSocket relay run as a process
 * (docs/spec/WEBSOCKET_RELAY.md, "A one-sided allocation"). The side that
 * saved first holds the next secret and the one before it; its partner holds
 * the one before it alone. A relay whose registrar took one side's rotation
 * holds that side's key under the exchange id, and the other side's proof
 * under its own key does not verify there.
 */

const BEFORE = generateSharedSecret();
const AHEAD = generateSharedSecret();
/** The exchange id a party's own registrar enrolled its relay key under. */
const OWN_EXCHANGE_ID = "own-relay-exchange";
/** The two secrets of a second exchange, whose ahead side owns the relay. */
const OWN_BEFORE = generateSharedSecret();
const OWN_AHEAD = generateSharedSecret();

let relay: WebSocketRelayProcess;

beforeAll(async () => {
  relay = await startWebSocketRelayProcess({
    [OWN_EXCHANGE_ID]: await deriveRelayKey(OWN_AHEAD),
    [await deriveRelayExchangeId(AHEAD)]: await deriveRelayKey(AHEAD),
    [await deriveRelayExchangeId(BEFORE)]: await deriveRelayKey(BEFORE),
  });
});

afterAll(async () => {
  await relay?.stop();
});

/** Resolve once `relay` meets `condition`, rejecting on its failure. */
function whenRelay(
  parked: ParkedWebSocketRelay,
  condition: (parked: ParkedWebSocketRelay) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (parked.failure !== undefined) {
        remove();
        reject(parked.failure);
      } else if (condition(parked)) {
        remove();
        resolve();
      }
    };
    const remove = parked.onChange(check);
    check();
  });
}

test("on a relay holding one side's key under the id, the other side's proof is refused and the first stays unpaired", async () => {
  const ahead = parkWebSocketRelay({
    url: relay.url,
    exchangeId: OWN_EXCHANGE_ID,
    relayKey: await deriveRelayKey(OWN_AHEAD),
    role: "acceptor",
  });
  const behind = parkWebSocketRelay({
    url: relay.url,
    exchangeId: OWN_EXCHANGE_ID,
    relayKey: await deriveRelayKey(OWN_BEFORE),
    role: "inviter",
  });
  try {
    const refusal = await whenRelay(behind, () => false).catch(
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(ConnectionError);
    expect((refusal as Error).message).toContain(
      "holds a key for this exchange other than the one this side's shared " +
        "secret derives",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(ahead.paired).toBe(false);
    expect(ahead.failure).toBeUndefined();
  } finally {
    ahead.close();
    behind.close();
  }
}, 30_000);

test("an acceptor holding a previous secret pairs under that secret's derived id with an inviter left on it", async () => {
  const connection = { websocketRelay: relay.url };
  const acceptorDials = await webSocketRelayDialsFor(
    connection,
    AHEAD,
    "acceptor",
    BEFORE,
  );
  const [inviterDial] = await webSocketRelayDialsFor(
    connection,
    BEFORE,
    "inviter",
  );
  expect(acceptorDials).toHaveLength(2);
  const acceptors = acceptorDials.map((dial) => parkWebSocketRelay(dial));
  const inviter = parkWebSocketRelay(inviterDial!);
  try {
    await whenRelay(inviter, (parked) => parked.paired);
    await whenRelay(acceptors[1]!, (parked) => parked.paired);
    expect(acceptors[0]!.paired).toBe(false);
    expect(acceptors[0]!.failure).toBeUndefined();
  } finally {
    for (const parked of [...acceptors, inviter]) parked.close();
  }
}, 30_000);
