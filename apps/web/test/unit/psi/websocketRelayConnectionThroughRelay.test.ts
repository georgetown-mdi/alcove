import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ConnectionError } from "@alcove/core";
import { RELAY_PATH } from "@alcove/websocket-relay/protocol";
import { attachWebSocketRelay } from "@alcove/websocket-relay";

import { authenticateExchange } from "../../../src/psi/authenticateExchange.js";
import { openWebSocketRelayConnection } from "../../../src/psi/transport/websocketRelayConnection.js";

import type { AddressInfo } from "node:net";
import type { PeerCloseOutcome } from "../../../src/psi/transport/waitForPeerClose.js";
import type { RendezvousRole } from "@alcove/core";
import type { WebSocketRelayConnectionOptions } from "../../../src/psi/transport/websocketRelayConnection.js";

/** The shared secret of bytes 0x00..0x1f, base64url. */
const SHARED_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i),
).toString("base64url");
/** The relay key of {@link SHARED_SECRET} (docs/spec/PROTOCOL.md). */
const RELAY_KEY =
  "1d970dcfd9f445a4c83c4ee3b03845209f891b2931e8b7bb2b41a17dd2249a9e";
const OTHER_RELAY_KEY = "fedcba9876543210".repeat(4);
const EXCHANGE_ID = "exchange-1";

/** Above the relay's 2,000,000-byte burst, so its pacing applies. */
const LARGE_FRAME_BYTES = 8 * 1024 * 1024;

interface RunningRelay {
  url: string;
  faults: Array<string>;
  stop: () => Promise<void>;
}

/** The real relay on a loopback ephemeral port, `EXCHANGE_ID` enrolled. */
async function startRelay(): Promise<RunningRelay> {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const faults: Array<string> = [];
  const relay = attachWebSocketRelay(server, {
    keyTable: {
      lookup: (exchangeId) =>
        exchangeId === EXCHANGE_ID ? RELAY_KEY : undefined,
    },
    reportFault: (message) => faults.push(message),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${RELAY_PATH}`,
    faults,
    async stop() {
      relay.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let relay: RunningRelay;
beforeEach(async () => {
  relay = await startRelay();
});
afterEach(async () => {
  await relay.stop();
  expect(relay.faults).toEqual([]);
});

/** Open one party, its socket dialing the loopback relay over `ws`. */
function openParty(
  role: RendezvousRole,
  options: Partial<WebSocketRelayConnectionOptions> = {},
) {
  return openWebSocketRelayConnection({
    url: "wss://relay.invalid/relay",
    exchangeId: EXCHANGE_ID,
    role,
    relayKey: RELAY_KEY,
    createSocket: () => new WebSocket(relay.url),
    ...options,
  });
}

/** Both parties paired through the relay and wrapped in the key exchange's
 * AEAD envelope, as the web app's exchange runs them. */
async function wrappedPair(outcomes: Array<string>) {
  const record = (role: RendezvousRole) => (outcome: PeerCloseOutcome) =>
    outcomes.push(`${role}:${outcome}`);
  const [inviter, acceptor] = await Promise.all([
    openParty("inviter", { onCloseOutcome: record("inviter") }),
    openParty("acceptor", { onCloseOutcome: record("acceptor") }),
  ]);
  const [initiator, responder] = await Promise.all([
    authenticateExchange(inviter, "initiator", SHARED_SECRET),
    authenticateExchange(acceptor, "responder", SHARED_SECRET),
  ]);
  return { initiator, responder };
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("the transport through the real relay", () => {
  test(
    "a frame above the relay's burst crosses intact inside the AEAD envelope",
    { timeout: 60_000 },
    async () => {
      const { initiator, responder } = await wrappedPair([]);
      expect(initiator.applyEncryption).toBe(true);
      expect(responder.applyEncryption).toBe(true);

      const frame = new Uint8Array(LARGE_FRAME_BYTES).map((_, i) => i * 31);
      const received = responder.connection.receive();
      await initiator.connection.send({ hello: "small" });
      await expect(received).resolves.toEqual({ hello: "small" });

      const receivedLarge = responder.connection.receive();
      await initiator.connection.send(frame);
      const large = (await receivedLarge) as Uint8Array;
      expect(large.byteLength).toBe(LARGE_FRAME_BYTES);
      expect(sha256(large)).toBe(sha256(frame));

      await Promise.all([
        initiator.connection.close(),
        responder.connection.close(),
      ]);
    },
  );

  test("the clean close delivers the final frame and resolves on the partner's relayed close", async () => {
    const outcomes: Array<string> = [];
    const { initiator, responder } = await wrappedPair(outcomes);

    await responder.connection.send("final");
    const closing = responder.connection.close();
    await expect(initiator.connection.receive()).resolves.toBe("final");
    await expect(initiator.connection.receive()).rejects.toBeInstanceOf(
      ConnectionError,
    );
    await closing;
    await initiator.connection.close();
    expect(outcomes).toEqual(["acceptor:peer-closed"]);
  });
});

describe("refusals from the real relay", () => {
  test("a proof under a key other than the enrolled one", async () => {
    await expect(
      openParty("inviter", { relayKey: OTHER_RELAY_KEY }),
    ).rejects.toMatchObject({
      kind: "transport",
      message:
        /^The WebSocket relay refused this side's proof: the key it holds/,
    });
  });

  test("an exchange id with no enrolled key", async () => {
    await expect(
      openParty("inviter", { exchangeId: "exchange-2" }),
    ).rejects.toMatchObject({
      kind: "transport",
      message: /^The WebSocket relay has no key enrolled for this exchange\./,
    });
  });

  test("a proof that expired before it reached the relay is signed again on the relay's clock and pairs", async () => {
    const [inviter, acceptor] = await Promise.all([
      openParty("inviter", { now: () => new Date(Date.now() - 400_000) }),
      openParty("acceptor"),
    ]);
    await Promise.all([inviter.close(), acceptor.close()]);
  });

  test("a partner that never arrives", async () => {
    await expect(
      openParty("inviter", { pairingTimeoutMs: 300 }),
    ).rejects.toMatchObject({
      kind: "transport",
      message: /^The exchange partner did not reach the WebSocket relay/,
    });
  });
});
