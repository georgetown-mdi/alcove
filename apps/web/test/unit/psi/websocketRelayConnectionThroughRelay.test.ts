import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ConnectionError } from "@alcove/core";
import { RELAY_PATH } from "@alcove/websocket-relay/protocol";
import { attachWebSocketRelay } from "@alcove/websocket-relay";

import {
  openWebSocketRelayConnection,
  parkWebSocketRelayConnection,
} from "../../../src/psi/transport/websocketRelayConnection.js";
import { authenticateExchange } from "../../../src/psi/authenticateExchange.js";

import type { MessageConnection, RendezvousRole } from "@alcove/core";
import type {
  ParkedWebSocketRelayConnection,
  WebSocketRelayConnectionOptions,
} from "../../../src/psi/transport/websocketRelayConnection.js";
import type { AddressInfo } from "node:net";
import type { PeerCloseOutcome } from "../../../src/psi/transport/waitForPeerClose.js";

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
  /** Enroll a relay key under an exchange id while the relay runs. */
  enroll: (exchangeId: string, relayKey: string) => void;
  stop: () => Promise<void>;
}

/** The real relay on a loopback ephemeral port, `EXCHANGE_ID` enrolled. */
async function startRelay(): Promise<RunningRelay> {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const faults: Array<string> = [];
  const enrolled = new Map([[EXCHANGE_ID, RELAY_KEY]]);
  const relay = attachWebSocketRelay(server, {
    keyTable: { lookup: (exchangeId) => enrolled.get(exchangeId) },
    reportFault: (message) => faults.push(message),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${RELAY_PATH}`,
    faults,
    enroll(exchangeId, relayKey) {
      enrolled.set(exchangeId, relayKey);
    },
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

/** The options of one party, its socket dialing the loopback relay over
 * `ws`. */
function partyOptions(
  role: RendezvousRole,
  options: Partial<WebSocketRelayConnectionOptions>,
): WebSocketRelayConnectionOptions {
  return {
    url: "wss://relay.invalid/relay",
    exchangeId: EXCHANGE_ID,
    role,
    relayKey: RELAY_KEY,
    createSocket: () => new WebSocket(relay.url),
    ...options,
  };
}

/** Open one party, its socket dialing the loopback relay over `ws`. */
function openParty(
  role: RendezvousRole,
  options: Partial<WebSocketRelayConnectionOptions> = {},
) {
  return openWebSocketRelayConnection(partyOptions(role, options));
}

/** Park one party, its socket dialing the loopback relay over `ws`. */
function parkParty(
  role: RendezvousRole,
  options: Partial<WebSocketRelayConnectionOptions> = {},
) {
  return parkWebSocketRelayConnection(partyOptions(role, options));
}

/** A `createSocket` dialing the loopback relay that records each socket's
 * close code. */
function recordingCloses(closeCodes: Array<number>) {
  return () => {
    const socket = new WebSocket(relay.url);
    socket.addEventListener("close", (event) => closeCodes.push(event.code));
    return socket;
  };
}

/** Resolves once `condition` holds of `parked`, and rejects with its failure
 * first. */
function whenParked(
  parked: ParkedWebSocketRelayConnection,
  condition: (parked: ParkedWebSocketRelayConnection) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
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

const isPaired = (parked: ParkedWebSocketRelayConnection) => parked.paired;

/** The key exchange over both relayed connections, one frame each way
 * inside the AEAD envelope, and a clean close. */
async function exchangeAndClose(
  inviter: MessageConnection,
  acceptor: MessageConnection,
) {
  const [initiator, responder] = await Promise.all([
    authenticateExchange(inviter, "initiator", SHARED_SECRET),
    authenticateExchange(acceptor, "responder", SHARED_SECRET),
  ]);
  await initiator.connection.send({ from: "inviter" });
  await expect(responder.connection.receive()).resolves.toEqual({
    from: "inviter",
  });
  await responder.connection.send({ from: "acceptor" });
  await expect(initiator.connection.receive()).resolves.toEqual({
    from: "acceptor",
  });
  const closing = responder.connection.close();
  await expect(initiator.connection.receive()).rejects.toBeInstanceOf(
    ConnectionError,
  );
  await closing;
  await initiator.connection.close();
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
      message: expect.stringMatching(
        /^The WebSocket relay refused this side's proof: the key it holds/,
      ),
    });
  });

  test(
    "an exchange id with no enrolled key is dialed again until the pairing wait ends, then refused with the enrollment step",
    { timeout: 30_000 },
    async () => {
      const closeCodes: Array<number> = [];
      const opening = openParty("inviter", {
        exchangeId: "exchange-2",
        createSocket: recordingCloses(closeCodes),
        pairingTimeoutMs: 2_000,
        redialIntervalMs: 200,
      });
      await expect(opening).rejects.toMatchObject({ kind: "transport" });
      await expect(opening).rejects.toThrow(
        /^The WebSocket relay has no key enrolled for this exchange\./,
      );
      expect(closeCodes.length).toBeGreaterThan(1);
      expect(new Set(closeCodes)).toEqual(new Set([4003]));
    },
  );

  test("a proof that expired before it reached the relay is signed again on the relay's clock and pairs", async () => {
    const [inviter, acceptor] = await Promise.all([
      openParty("inviter", { now: () => new Date(Date.now() - 400_000) }),
      openParty("acceptor"),
    ]);
    await Promise.all([inviter.close(), acceptor.close()]);
  });

  test("a partner that never arrives", async () => {
    const opening = openParty("inviter", { pairingTimeoutMs: 300 });
    await expect(opening).rejects.toMatchObject({ kind: "transport" });
    await expect(opening).rejects.toThrow(
      /^The exchange partner did not reach the WebSocket relay/,
    );
  });
});

describe("a parked socket through the real relay", () => {
  test(
    "a party refused as not enrolled pairs once the key is enrolled, and the exchange crosses",
    { timeout: 30_000 },
    async () => {
      const lateExchangeId = "exchange-late";
      const closeCodes: Array<number> = [];
      const inviter = parkParty("inviter", {
        exchangeId: lateExchangeId,
        relayKey: OTHER_RELAY_KEY,
        createSocket: recordingCloses(closeCodes),
        redialIntervalMs: 200,
      });
      await expect.poll(() => closeCodes).toContain(4003);
      relay.enroll(lateExchangeId, OTHER_RELAY_KEY);
      const acceptor = parkParty("acceptor", {
        exchangeId: lateExchangeId,
        relayKey: OTHER_RELAY_KEY,
      });
      await Promise.all([
        whenParked(inviter, isPaired),
        whenParked(acceptor, isPaired),
      ]);
      const [inviterRaw, acceptorRaw] = await Promise.all([
        inviter.start(),
        acceptor.start(),
      ]);
      await exchangeAndClose(inviterRaw, acceptorRaw);
    },
  );

  test(
    "a party whose partner leaves a parked pairing dials again and pairs with the partner's next socket",
    { timeout: 30_000 },
    async () => {
      const inviter = parkParty("inviter", { redialIntervalMs: 200 });
      const leaving = parkParty("acceptor");
      await Promise.all([
        whenParked(inviter, isPaired),
        whenParked(leaving, isPaired),
      ]);
      leaving.close();
      await whenParked(inviter, (parked) => !parked.paired);
      expect(inviter.failure).toBeUndefined();

      const acceptor = parkParty("acceptor");
      await Promise.all([
        whenParked(inviter, isPaired),
        whenParked(acceptor, isPaired),
      ]);
      const [inviterRaw, acceptorRaw] = await Promise.all([
        inviter.start(),
        acceptor.start(),
      ]);
      await exchangeAndClose(inviterRaw, acceptorRaw);
    },
  );

  test("a start one party sends while its partner holds its own reaches the partner, and the partner's start opens both", async () => {
    const closeCodes: Array<number> = [];
    const inviter = parkParty("inviter", {
      createSocket: recordingCloses(closeCodes),
    });
    const acceptor = parkParty("acceptor", {
      createSocket: recordingCloses(closeCodes),
    });
    await Promise.all([
      whenParked(inviter, isPaired),
      whenParked(acceptor, isPaired),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(inviter.partnerStarted || acceptor.partnerStarted).toBe(false);

    let inviterOpen = false;
    const inviterStarting = inviter.start().then((connection) => {
      inviterOpen = true;
      return connection;
    });
    await whenParked(acceptor, (parked) => parked.partnerStarted);
    expect(inviterOpen).toBe(false);

    const [inviterRaw, acceptorRaw] = await Promise.all([
      inviterStarting,
      acceptor.start(),
    ]);
    await exchangeAndClose(inviterRaw, acceptorRaw);
    await expect.poll(() => closeCodes).toEqual([1000, 1000]);
  });
});
