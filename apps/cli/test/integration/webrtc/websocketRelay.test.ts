import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, expect, test } from "vitest";

import {
  ConnectionError,
  EncryptedMessageConnection,
  PeerJsFrameEncoder,
  authenticateConnection,
  deriveRelayExchangeId,
  deriveRelayKey,
  generateSharedSecret,
  handshakeRoleForRendezvousRole,
} from "@alcove/core";

import { SEND_WINDOW_BYTES } from "../../../src/connection/webrtc/webrtcMessageConnection";
import {
  openWebSocketRelayMessageConnection,
  parkWebSocketRelay,
  webSocketRelayHello,
} from "../../../src/connection/webrtc/websocketRelayConnection";
import { webSocketRelayDialFor } from "../../../src/connection/webrtc/websocketRelayDial";
import { startWebSocketRelayProcess } from "../../signaling/websocketRelayProcess";

import type {
  ParkedWebSocketRelay,
  WebSocketRelayConnectionOptions,
  WebSocketRelayDial,
} from "../../../src/connection/webrtc/websocketRelayConnection";
import type { WebSocketRelayProcess } from "../../signaling/websocketRelayProcess";
import type { MessageConnection, RendezvousRole } from "@alcove/core";

/**
 * The CLI's relay transport end to end: two parties dialing the repository's
 * real WebSocket relay, run as a process over a key table of its own, with the
 * key exchange requesting the wrap and every later frame inside it.
 */

const SECRET = generateSharedSecret();
const UNENROLLED_SECRET = generateSharedSecret();
const WRONG_KEY_SECRET = generateSharedSecret();

/** The relay's own per-message cap (packages/websocket-relay/src/protocol.ts). */
const RELAY_MAX_MESSAGE_BYTES = 16_384;

let relay: WebSocketRelayProcess;

function digest(value: unknown): string {
  if (!(value instanceof Uint8Array)) throw new Error("not a byte frame");
  return createHash("sha256").update(value).digest("hex");
}

beforeAll(async () => {
  relay = await startWebSocketRelayProcess({
    [await deriveRelayExchangeId(SECRET)]: await deriveRelayKey(SECRET),
  });
});

afterAll(async () => {
  await relay?.stop();
});

async function dialFor(
  role: RendezvousRole,
  secret = SECRET,
): Promise<WebSocketRelayDial> {
  const dial = await webSocketRelayDialFor(
    { websocketRelay: relay.url },
    secret,
    role,
  );
  if (dial === undefined) throw new Error("no relay dial");
  return dial;
}

/** What sockets made through {@link recordingSockets} sent and received. */
interface SocketRecord {
  socketFactory: (url: string) => WebSocket;
  /** Every binary message any of the sockets sent to the relay. */
  binarySent: Array<Uint8Array>;
  /** Every binary message the relay forwarded to any of the sockets. */
  binaryForwarded: Array<Uint8Array>;
  /** The code of each close the sockets saw. */
  closeCodes: Array<number>;
}

/** A socket factory recording each socket's traffic, with an optional text rewrite. */
function recordingSockets(
  rewriteText: (text: string) => string = (text) => text,
): SocketRecord {
  const record: SocketRecord = {
    socketFactory: (url) => {
      const socket = new WebSocket(url);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          send(rewriteText(data));
          return;
        }
        if (ArrayBuffer.isView(data))
          record.binarySent.push(
            new Uint8Array(
              data.buffer,
              data.byteOffset,
              data.byteLength,
            ).slice(),
          );
        send(data);
      };
      socket.addEventListener("message", (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer)
          record.binaryForwarded.push(new Uint8Array(event.data.slice(0)));
      });
      socket.addEventListener("close", (event: CloseEvent) => {
        record.closeCodes.push(event.code);
      });
      return socket;
    },
    binarySent: [],
    binaryForwarded: [],
    closeCodes: [],
  };
  return record;
}

/** Run the key exchange over both relayed connections with the wrap requested. */
async function authenticated(
  inviterRaw: MessageConnection,
  acceptorRaw: MessageConnection,
  secret = SECRET,
): Promise<{ inviter: MessageConnection; acceptor: MessageConnection }> {
  const authenticate = async (
    connection: MessageConnection,
    role: RendezvousRole,
  ): Promise<MessageConnection> => {
    const handshakeRole = handshakeRoleForRendezvousRole(role);
    const { sessionKey, applyEncryption } = await authenticateConnection(
      connection,
      { sharedSecret: secret },
      handshakeRole,
      true,
      { history: [] },
    );
    expect(applyEncryption).toBe(true);
    return EncryptedMessageConnection.create(
      connection,
      sessionKey,
      handshakeRole,
    );
  };
  const [inviter, acceptor] = await Promise.all([
    authenticate(inviterRaw, "inviter"),
    authenticate(acceptorRaw, "acceptor"),
  ]);
  return { inviter, acceptor };
}

/** Pair both parties through the relay and run the key exchange with the wrap requested. */
async function authenticatedPair(
  options: WebSocketRelayConnectionOptions = {},
): Promise<{ inviter: MessageConnection; acceptor: MessageConnection }> {
  const [inviterRaw, acceptorRaw] = await Promise.all([
    openWebSocketRelayMessageConnection(await dialFor("inviter"), options),
    openWebSocketRelayMessageConnection(await dialFor("acceptor"), options),
  ]);
  return authenticated(inviterRaw, acceptorRaw);
}

/** Resolves once `condition` holds of `relay`, and rejects with its failure first. */
function whenRelay(
  relay: ParkedWebSocketRelay,
  condition: (relay: ParkedWebSocketRelay) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (relay.failure !== undefined) {
        remove();
        reject(relay.failure);
      } else if (condition(relay)) {
        remove();
        resolve();
      }
    };
    const remove = relay.onChange(check);
    check();
  });
}

const isPaired = (relay: ParkedWebSocketRelay): boolean => relay.paired;

/** One frame each way inside the wrap, then a clean close both sides confirm. */
async function exchangeAndClose(pair: {
  inviter: MessageConnection;
  acceptor: MessageConnection;
}): Promise<void> {
  await pair.inviter.send({ from: "inviter" });
  expect(await pair.acceptor.receive()).toEqual({ from: "inviter" });
  await pair.acceptor.send({ from: "acceptor" });
  expect(await pair.inviter.receive()).toEqual({ from: "acceptor" });
  const closing = pair.inviter.close();
  await expect(pair.acceptor.receive()).rejects.toThrow(
    "peer connection closed",
  );
  await pair.acceptor.close().catch(() => {});
  await closing;
}

test("two parties pair through the relay, exchange wrapped frames, and the close confirms delivery", async () => {
  const { inviter, acceptor } = await authenticatedPair();
  const large = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 7) % 256);

  await acceptor.send({ step: 1 });
  expect(await inviter.receive()).toEqual({ step: 1 });
  await inviter.send(large);
  expect(digest(await acceptor.receive())).toBe(digest(large));

  const final = new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 253);
  await acceptor.send(final);
  const closing = acceptor.close();
  expect(digest(await inviter.receive())).toBe(digest(final));
  await expect(inviter.receive()).rejects.toThrow("peer connection closed");
  await inviter.close().catch(() => {});
  await expect(closing).resolves.toBeUndefined();
}, 60_000);

// No CLI run dials this transport until the fallback selects it, so this test
// wraps the connection the way authenticateRun does.
test("a payload frame crosses the relay only inside the wrap", async () => {
  const marker = `alcove-plaintext-marker-${randomBytes(8).toString("hex")}`;
  const markerBytes = Buffer.from(marker);
  const contains = (frame: Uint8Array): boolean =>
    Buffer.from(frame).includes(markerBytes);
  const record = { record: marker };
  const bytes = new TextEncoder().encode(marker.repeat(2_000));
  // The same frames framed without the wrap show the marker, so the search
  // below would find it in an unwrapped frame.
  const encoder = new PeerJsFrameEncoder();
  expect(encoder.encode(record).some(contains)).toBe(true);
  expect(encoder.encode(bytes).some(contains)).toBe(true);

  const sockets = recordingSockets();
  const { inviter, acceptor } = await authenticatedPair({
    socketFactory: sockets.socketFactory,
  });
  const forwardedBeforePayload = sockets.binaryForwarded.length;
  await inviter.send(record);
  expect(await acceptor.receive()).toEqual(record);
  await inviter.send(bytes);
  expect(digest(await acceptor.receive())).toBe(digest(bytes));

  const forwarded = sockets.binaryForwarded;
  expect(forwarded.length - forwardedBeforePayload).toBeGreaterThan(1);
  expect(forwarded.filter(contains)).toEqual([]);
  expect(contains(Buffer.concat(forwarded))).toBe(false);

  const closing = inviter.close();
  await expect(acceptor.receive()).rejects.toThrow("peer connection closed");
  await acceptor.close().catch(() => {});
  await closing;
}, 60_000);

test("both parties closing at once each confirm delivery without waiting out the budget", async () => {
  const closeCodes: Array<number | undefined> = [];
  const socketFactory = (url: string): WebSocket => {
    const socket = new WebSocket(url);
    const close = socket.close.bind(socket);
    socket.close = (code) => {
      closeCodes.push(code);
      close(code);
    };
    return socket;
  };
  const { inviter, acceptor } = await authenticatedPair({
    socketFactory,
    closeFlushTimeoutMs: 60_000,
  });
  await inviter.send({ last: "inviter" });
  await acceptor.send({ last: "acceptor" });
  expect(await inviter.receive()).toEqual({ last: "acceptor" });
  expect(await acceptor.receive()).toEqual({ last: "inviter" });

  const started = Date.now();
  await Promise.all([inviter.close(), acceptor.close()]);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(closeCodes).toEqual([1000, 1000]);
}, 60_000);

test("a sender the relay paces keeps its socket's buffer within the send window", async () => {
  let largestBuffered = 0;
  const socketFactory = (url: string): WebSocket => {
    const socket = new WebSocket(url);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (ArrayBuffer.isView(data))
        expect(data.byteLength).toBeLessThanOrEqual(RELAY_MAX_MESSAGE_BYTES);
      send(data);
      largestBuffered = Math.max(largestBuffered, socket.bufferedAmount);
    };
    return socket;
  };
  const { inviter, acceptor } = await authenticatedPair({ socketFactory });
  // Past the relay's 2,000,000-byte burst, so its byte rate holds the sender.
  const frames = 6;
  const frame = new Uint8Array(2 * 1024 * 1024);
  const started = Date.now();
  const receiving = (async () => {
    for (let i = 0; i < frames; i++) await acceptor.receive();
  })();
  for (let i = 0; i < frames; i++) await inviter.send(frame);
  await receiving;
  expect(Date.now() - started).toBeGreaterThan(3_000);
  expect(largestBuffered).toBeGreaterThanOrEqual(SEND_WINDOW_BYTES);
  expect(largestBuffered).toBeLessThanOrEqual(
    SEND_WINDOW_BYTES + RELAY_MAX_MESSAGE_BYTES,
  );
  const closing = inviter.close();
  await expect(acceptor.receive()).rejects.toThrow("peer connection closed");
  await acceptor.close().catch(() => {});
  await closing;
}, 60_000);

test("a relay that holds no key for the exchange is dialed again until the budget ends, then refused with the enrollment step", async () => {
  const sockets = recordingSockets();
  await expect(
    openWebSocketRelayMessageConnection(
      await dialFor("inviter", UNENROLLED_SECRET),
      {
        socketFactory: sockets.socketFactory,
        rendezvousTimeoutMs: 2_000,
        redialIntervalMs: 200,
      },
    ),
  ).rejects.toThrow(
    `the WebSocket relay at ${relay.url} holds no key for this exchange`,
  );
  expect(sockets.closeCodes.length).toBeGreaterThan(1);
  expect(new Set(sockets.closeCodes)).toEqual(new Set([4003]));
}, 30_000);

test("a party refused as not enrolled pairs once its partner enrolls the key, and the exchange crosses", async () => {
  const secret = generateSharedSecret();
  let refusedOnce!: () => void;
  const refused = new Promise<void>((resolve) => {
    refusedOnce = resolve;
  });
  const socketFactory = (url: string): WebSocket => {
    const socket = new WebSocket(url);
    socket.addEventListener("close", (event: CloseEvent) => {
      if (event.code === 4003) refusedOnce();
    });
    return socket;
  };
  const inviter = parkWebSocketRelay(await dialFor("inviter", secret), {
    socketFactory,
    redialIntervalMs: 200,
  });
  await refused;
  relay.enroll({
    [await deriveRelayExchangeId(secret)]: await deriveRelayKey(secret),
  });
  const acceptor = parkWebSocketRelay(await dialFor("acceptor", secret));
  await Promise.all([
    whenRelay(inviter, isPaired),
    whenRelay(acceptor, isPaired),
  ]);

  const [inviterRaw, acceptorRaw] = await Promise.all([
    inviter.start(),
    acceptor.start(),
  ]);
  await exchangeAndClose(await authenticated(inviterRaw, acceptorRaw, secret));
}, 60_000);

test("a party whose partner leaves a parked pairing dials again and pairs with the partner's next socket", async () => {
  const inviter = parkWebSocketRelay(await dialFor("inviter"), {
    redialIntervalMs: 200,
  });
  const leaving = parkWebSocketRelay(await dialFor("acceptor"));
  await Promise.all([
    whenRelay(inviter, isPaired),
    whenRelay(leaving, isPaired),
  ]);
  leaving.close();
  await whenRelay(inviter, (parked) => !parked.paired);
  expect(inviter.failure).toBeUndefined();

  const acceptor = parkWebSocketRelay(await dialFor("acceptor"));
  await Promise.all([
    whenRelay(inviter, isPaired),
    whenRelay(acceptor, isPaired),
  ]);
  const [inviterRaw, acceptorRaw] = await Promise.all([
    inviter.start(),
    acceptor.start(),
  ]);
  await exchangeAndClose(await authenticated(inviterRaw, acceptorRaw));
}, 60_000);

test("a start one party defers reaches its partner through the relay, and the partner's own start opens both", async () => {
  const sockets = recordingSockets();
  const inviter = parkWebSocketRelay(await dialFor("inviter"), {
    socketFactory: sockets.socketFactory,
  });
  const acceptor = parkWebSocketRelay(await dialFor("acceptor"), {
    socketFactory: sockets.socketFactory,
  });
  await Promise.all([
    whenRelay(inviter, isPaired),
    whenRelay(acceptor, isPaired),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(inviter.partnerStarted || acceptor.partnerStarted).toBe(false);

  let inviterOpen = false;
  const inviterStarting = inviter.start().then((connection) => {
    inviterOpen = true;
    return connection;
  });
  await whenRelay(acceptor, (parked) => parked.partnerStarted);
  expect(inviterOpen).toBe(false);
  expect(sockets.binaryForwarded).toEqual([]);

  const [inviterRaw, acceptorRaw] = await Promise.all([
    inviterStarting,
    acceptor.start(),
  ]);
  await exchangeAndClose(await authenticated(inviterRaw, acceptorRaw));
  expect(sockets.closeCodes).toEqual([1000, 1000]);
}, 60_000);

const PROOF_REFUSED_MESSAGE =
  "holds a key for this exchange other than the one this side's shared " +
  "secret derives";

test("a proof made with a key other than the enrolled one is refused before any frame crosses", async () => {
  const sockets = recordingSockets();
  const dial = {
    ...(await dialFor("inviter")),
    relayKey: await deriveRelayKey(WRONG_KEY_SECRET),
  };
  expect(dial.exchangeId).toBe(await deriveRelayExchangeId(SECRET));
  const refusal: unknown = await openWebSocketRelayMessageConnection(dial, {
    socketFactory: sockets.socketFactory,
  }).catch((err: unknown) => err);
  expect(refusal).toBeInstanceOf(ConnectionError);
  expect((refusal as Error).message).toContain(PROOF_REFUSED_MESSAGE);
  expect(sockets.closeCodes).toEqual([4004]);
  expect(sockets.binarySent).toEqual([]);
  expect(sockets.binaryForwarded).toEqual([]);
});

test("a proof made for one role in a hello claiming the other is refused before any frame crosses", async () => {
  const acceptorHello = JSON.parse(
    await webSocketRelayHello(await dialFor("acceptor"), new Date()),
  ) as Record<string, string>;
  let rewritten = 0;
  const sockets = recordingSockets((text) => {
    const frame = JSON.parse(text) as Record<string, string>;
    if (frame.type !== "hello") return text;
    expect(frame.role).toBe("inviter");
    rewritten++;
    return JSON.stringify({ ...acceptorHello, role: "inviter" });
  });
  const refusal: unknown = await openWebSocketRelayMessageConnection(
    await dialFor("inviter"),
    { socketFactory: sockets.socketFactory },
  ).catch((err: unknown) => err);
  expect(rewritten).toBe(1);
  expect(refusal).toBeInstanceOf(ConnectionError);
  expect((refusal as Error).message).toContain(PROOF_REFUSED_MESSAGE);
  expect(sockets.closeCodes).toEqual([4004]);
  expect(sockets.binarySent).toEqual([]);
  expect(sockets.binaryForwarded).toEqual([]);
});

test("a second socket in a role the relay already holds is dialed again, then refused as role taken", async () => {
  const controller = new AbortController();
  const first = openWebSocketRelayMessageConnection(await dialFor("inviter"), {
    signal: controller.signal,
  });
  const firstSettled = first.catch((err: unknown) => err);
  // The relay checks hellos in arrival order, so let the first one land.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const sockets = recordingSockets();
  await expect(
    openWebSocketRelayMessageConnection(await dialFor("inviter"), {
      socketFactory: sockets.socketFactory,
      rendezvousTimeoutMs: 1_500,
      redialIntervalMs: 200,
    }),
  ).rejects.toThrow("already holds a connection in this side's role");
  expect(sockets.closeCodes.length).toBeGreaterThan(1);
  expect(new Set(sockets.closeCodes)).toEqual(new Set([4006]));
  controller.abort();
  await firstSettled;
}, 30_000);
