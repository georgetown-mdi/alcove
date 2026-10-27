import net from "node:net";

import { afterAll, beforeAll, expect, test } from "vitest";

import {
  deriveRelayExchangeId,
  deriveRelayKey,
  generateSharedSecret,
} from "@alcove/core";
import { loopbackTlsCert } from "@alcove/testkit/loopbackTlsCert";

import { parkWebSocketRelay } from "../../../src/connection/webrtc/websocketRelayConnection";
import { webSocketRelayDialFor } from "../../../src/connection/webrtc/websocketRelayDial";
import { askWebSocketRelay } from "../../../src/doctor/websocketRelay";
import { startTlsBrokerFront } from "../../signaling/tlsBrokerFront";
import { startWebSocketRelayProcess } from "../../signaling/websocketRelayProcess";

import type { WebSocketRelayDial } from "../../../src/connection/webrtc/websocketRelayConnection";
import type { TlsBrokerFront } from "../../signaling/tlsBrokerFront";
import type { WebSocketRelayProcess } from "../../signaling/websocketRelayProcess";
import type { RendezvousRole } from "@alcove/core";

/**
 * `alcove doctor relay`'s question to a WebSocket relay, asked of the
 * repository's real relay over Node's own WebSocket client: each answer the
 * check tells apart, and a TLS front whose certificate this process does not
 * trust, as on a network that intercepts TLS.
 */

const SECRET = generateSharedSecret();
const UNENROLLED_SECRET = generateSharedSecret();
const WRONG_KEY_SECRET = generateSharedSecret();
const PARTNERED_SECRET = generateSharedSecret();

/** A bound no answer below comes near, so a lapse fails the test rather than answering. */
const BOUND_MS = 20_000;

let relay: WebSocketRelayProcess;
let front: TlsBrokerFront | undefined;

beforeAll(async () => {
  relay = await startWebSocketRelayProcess({
    [await deriveRelayExchangeId(SECRET)]: await deriveRelayKey(SECRET),
    [await deriveRelayExchangeId(PARTNERED_SECRET)]:
      await deriveRelayKey(PARTNERED_SECRET),
    [await deriveRelayExchangeId(WRONG_KEY_SECRET)]:
      await deriveRelayKey(UNENROLLED_SECRET),
  });
  if (loopbackTlsCert !== null)
    front = await startTlsBrokerFront(
      loopbackTlsCert,
      Number(new URL(relay.url).port),
    );
});

afterAll(async () => {
  await front?.stop();
  await relay?.stop();
});

async function dialFor(
  secret: string,
  url = relay.url,
  role: RendezvousRole = "inviter",
): Promise<WebSocketRelayDial> {
  const dial = await webSocketRelayDialFor(
    { websocketRelay: url },
    secret,
    role,
  );
  if (dial === undefined) throw new Error("no relay dial");
  return dial;
}

function ask(dial: WebSocketRelayDial) {
  return askWebSocketRelay(dial, AbortSignal.timeout(BOUND_MS));
}

test("a relay holding the exchange's key admits the run's proof", async () => {
  await expect(ask(await dialFor(SECRET))).resolves.toEqual({
    outcome: "admitted",
  });
});

test("a relay holding no key for the exchange does not admit it, with 4003", async () => {
  await expect(ask(await dialFor(UNENROLLED_SECRET))).resolves.toEqual({
    outcome: "not_admitted",
    closeCode: 4003,
  });
});

test("a relay holding another key for the exchange does not admit it, with 4004", async () => {
  await expect(ask(await dialFor(WRONG_KEY_SECRET))).resolves.toEqual({
    outcome: "not_admitted",
    closeCode: 4004,
  });
});

test("a port nothing listens on is not reached", async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

  await expect(
    ask(await dialFor(SECRET, `ws://127.0.0.1:${port}/relay`)),
  ).resolves.toEqual({ outcome: "not_reached", certificateNotChecked: false });
});

test.skipIf(loopbackTlsCert === null)(
  "a relay behind a certificate this host does not trust is a certificate failure, not an unreachable relay",
  async () => {
    if (front === undefined) throw new Error("no TLS front");
    await expect(
      ask(await dialFor(SECRET, `wss://localhost:${front.port}/relay`)),
    ).resolves.toEqual({ outcome: "certificate_not_verified" });
  },
);

test("a partner waiting at the relay is paired with the check, and dials again once the check closes", async () => {
  const partner = parkWebSocketRelay(
    await dialFor(PARTNERED_SECRET, relay.url, "acceptor"),
    { redialIntervalMs: 100 },
  );
  try {
    const pairedOnce = new Promise<void>((resolve) => {
      const remove = partner.onChange(() => {
        if (!partner.paired) return;
        remove();
        resolve();
      });
    });

    await expect(ask(await dialFor(PARTNERED_SECRET))).resolves.toEqual({
      outcome: "admitted",
    });
    await pairedOnce;
    const unpaired = new Promise<void>((resolve) => {
      const remove = partner.onChange(() => {
        if (partner.paired) return;
        remove();
        resolve();
      });
    });
    await unpaired;
    expect(partner.failure).toBeUndefined();
  } finally {
    partner.close();
  }
});
