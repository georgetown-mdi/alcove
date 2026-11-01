import { expect, test } from "vitest";

import {
  BoundedInboundFrames,
  ConnectionError,
  PEERJS_CHUNK_MTU,
  PeerJsFrameEncoder,
  UsageError,
  checkWebSocketRelayProof,
  deriveRelayExchangeId,
  deriveRelayKey,
  deriveWebSocketRelayProofKey,
  packCloseSentinel,
  parseWebSocketRelayProof,
  statesItsOwnNextStep,
} from "@alcove/core";
import {
  boundedInboundFramesWithBounds,
  packValue,
} from "@alcove/core/testing";

import {
  FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE,
  FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_MESSAGE,
  FinalFrameUnconfirmedError,
} from "../../../src/connection/webrtc/webrtcMessageConnection";
import {
  RELAY_ABANDON_CLOSE_CODE,
  openWebSocketRelayMessageConnection,
  parkWebSocketRelay,
  relayRefusalError,
} from "../../../src/connection/webrtc/websocketRelayConnection";
import {
  webSocketRelayDialFor,
  websocketRelayNeedsSecretMessage,
} from "../../../src/connection/webrtc/websocketRelayDial";

import type {
  WebSocketRelayConnectionOptions,
  WebSocketRelayDial,
} from "../../../src/connection/webrtc/websocketRelayConnection";
import type { MessageConnection } from "@alcove/core";
import type { InboundBoundOverrides } from "@alcove/core/testing";

/**
 * A WebSocket stand-in with the surface the relay transport uses, standing in
 * for the relay's side of one socket. The real relay is driven end to end in
 * test/integration/webrtc/websocketRelay.test.ts; this exercises the orderings
 * that are hard to provoke there.
 */
class FakeRelaySocket {
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  /** The code each `close` call passed, in order. */
  readonly closeCalls: Array<number | undefined> = [];
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, handler: (event: never) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: never) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  /** Set to make each binary send add to `bufferedAmount`. */
  buffers = false;

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data));
    if (this.buffers && typeof data !== "string")
      this.bufferedAmount += data.byteLength;
  }

  close(code?: number): void {
    this.closeCalls.push(code);
    if (this.readyState === 1) this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  /** A control frame from the relay. */
  control(type: string): void {
    this.emit("message", { data: JSON.stringify({ type }) });
  }

  /** A message the relay forwards, as Node's client delivers it. */
  binary(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes);
    this.emit("message", { data: copy.buffer });
  }

  text(data: string): void {
    this.emit("message", { data });
  }

  /** The relay closes the socket. */
  closedByRelay(code: number, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  textSent(): Array<string> {
    return this.sent.filter((data): data is string => typeof data === "string");
  }

  binarySent(): Array<Uint8Array> {
    return this.sent.filter(
      (data): data is Uint8Array => typeof data !== "string",
    );
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])])
      (handler as (event: unknown) => void)(event);
  }
}

const SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index),
).toString("base64url");

const NOW = new Date("2026-01-01T00:00:00Z");
const NOW_SECONDS = NOW.getTime() / 1000;

async function relayDial(
  role: WebSocketRelayDial["role"] = "acceptor",
): Promise<WebSocketRelayDial> {
  const dial = await webSocketRelayDialFor(
    { websocketRelay: "wss://relay.example.org/relay" },
    SECRET,
    role,
  );
  if (dial === undefined) throw new Error("no relay dial");
  return dial;
}

function harness(options: WebSocketRelayConnectionOptions = {}) {
  const sockets: Array<FakeRelaySocket> = [];
  const socketFactory = (url: string): WebSocket => {
    const socket = new FakeRelaySocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  return {
    sockets,
    options: { socketFactory, now: () => NOW, ...options },
  };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

async function socketDialed(sockets: Array<FakeRelaySocket>, count = 1) {
  for (let i = 0; i < 100 && sockets.length < count; i++) await tick();
  const socket = sockets[count - 1];
  if (socket === undefined) throw new Error("no socket was dialed");
  return socket;
}

/** Dial, open, pair and start: a connection in its forwarding phase. */
async function startedConnection(
  options: WebSocketRelayConnectionOptions = {},
): Promise<{ connection: MessageConnection; socket: FakeRelaySocket }> {
  const { sockets, options: dialOptions } = harness(options);
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    dialOptions,
  );
  const socket = await socketDialed(sockets);
  socket.open();
  socket.control("paired");
  socket.control("start");
  return { connection: await opening, socket };
}

test("the hello proves the relay key for this side's role, and the start follows it", async () => {
  const { sockets, options } = harness();
  const dial = await relayDial("inviter");
  void openWebSocketRelayMessageConnection(dial, options).catch(() => {});
  const socket = await socketDialed(sockets);
  expect(socket.url).toBe("wss://relay.example.org/relay");
  expect(socket.sent).toEqual([]);
  socket.open();

  const [helloText, startText, ...rest] = socket.textSent();
  expect(rest).toEqual([]);
  expect(socket.binarySent()).toEqual([]);
  expect(JSON.parse(startText)).toEqual({ type: "start" });
  const hello = JSON.parse(helloText) as Record<string, string>;
  expect(Object.keys(hello).sort()).toEqual(
    ["exchangeId", "proof", "role", "tag", "type"].sort(),
  );
  expect(hello.type).toBe("hello");
  expect(hello.role).toBe("inviter");
  expect(hello.exchangeId).toBe(await deriveRelayExchangeId(SECRET));
  expect(hello.tag).toMatch(/^[0-9a-f]{64}$/);

  const proof = parseWebSocketRelayProof(
    new TextEncoder().encode(hello.proof),
    Buffer.from(hello.tag, "hex"),
  );
  expect(proof.expiresAtSeconds).toBe(NOW_SECONDS + 300);
  await checkWebSocketRelayProof({
    proofKey: await deriveWebSocketRelayProofKey(await deriveRelayKey(SECRET)),
    proof,
    role: "inviter",
    now: NOW,
  });
  socket.closedByRelay(1001);
});

test("a frame the relay forwards directly behind the partner's start is delivered", async () => {
  const { sockets, options } = harness();
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const socket = await socketDialed(sockets);
  socket.open();
  socket.control("paired");
  socket.control("start");
  socket.binary(packValue({ first: 1 }));
  const connection = await opening;
  expect(await connection.receive()).toEqual({ first: 1 });
  expect(socket.binaryType).toBe("arraybuffer");
});

test("a frame larger than one chunk crosses as chunk envelopes the reassembler takes", async () => {
  const { connection, socket } = await startedConnection();
  const frame = new Uint8Array(3 * PEERJS_CHUNK_MTU).map((_, i) => i % 251);
  await connection.send(frame);
  const datagrams = socket.binarySent();
  expect(datagrams.length).toBeGreaterThan(1);
  const reassembler = new BoundedInboundFrames();
  const outcomes = datagrams.map((datagram) => reassembler.accept(datagram));
  const last = outcomes.at(-1);
  expect(outcomes.slice(0, -1).every((o) => o.kind === "pending")).toBe(true);
  expect(last?.kind === "frame" && last.value).toEqual(frame);
});

test("a send waits while the socket's buffer is at the window, and resumes at the low mark", async () => {
  const { connection, socket } = await startedConnection({
    sendWindowBytes: 1_000,
    sendWindowLowBytes: 200,
    sendWindowPollMs: 1,
  });
  await connection.send("under the window");
  expect(socket.binarySent()).toHaveLength(1);

  socket.bufferedAmount = 1_000;
  let sent = false;
  const sending = connection.send("over the window").then(() => {
    sent = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(socket.binarySent()).toHaveLength(1);

  socket.bufferedAmount = 500;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toBe(false);
  expect(socket.binarySent()).toHaveLength(1);

  socket.bufferedAmount = 200;
  await sending;
  expect(socket.binarySent()).toHaveLength(2);
});

test("each chunk of a large frame waits on the window on its own", async () => {
  const { connection, socket } = await startedConnection({
    sendWindowBytes: 1_000,
    sendWindowLowBytes: 0,
    sendWindowPollMs: 1,
  });
  socket.buffers = true;
  let sent = false;
  const sending = connection
    .send(new Uint8Array(3 * PEERJS_CHUNK_MTU))
    .then(() => {
      sent = true;
    });
  const total = new PeerJsFrameEncoder().encode(
    new Uint8Array(3 * PEERJS_CHUNK_MTU),
  ).length;
  for (let chunk = 1; chunk <= total; chunk++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.binarySent()).toHaveLength(chunk);
    socket.bufferedAmount = 0;
  }
  await sending;
  expect(sent).toBe(true);
});

test("a send waiting on the window fails when the socket closes", async () => {
  const { connection, socket } = await startedConnection({
    sendWindowBytes: 1_000,
    sendWindowLowBytes: 200,
    sendWindowPollMs: 1,
  });
  socket.bufferedAmount = 5_000;
  const sending = connection.send("never sent");
  socket.closedByRelay(4000);
  await expect(sending).rejects.toBeInstanceOf(ConnectionError);
  expect(socket.binarySent()).toEqual([]);
});

test("a clean close sends the sentinel and resolves on the partner's relayed close", async () => {
  const { connection, socket } = await startedConnection();
  await connection.send("last");
  let resolved = false;
  const closing = connection.close().then(() => {
    resolved = true;
  });
  await tick();
  const datagrams = socket.binarySent();
  expect(datagrams.at(-1)).toEqual(new Uint8Array(packCloseSentinel()));
  expect(resolved).toBe(false);
  socket.closedByRelay(1000);
  await closing;
  expect(socket.closeCalls).toEqual([]);
});

test("a clean close the partner's abnormal end answers rejects as unconfirmed", async () => {
  const { connection, socket } = await startedConnection();
  const closing = connection.close();
  await tick();
  socket.closedByRelay(4000);
  const error = await closing.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(FinalFrameUnconfirmedError);
  expect((error as Error).message).toBe(
    FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE,
  );
});

test("a clean close no answer reaches within its budget ends the socket abnormally", async () => {
  const { connection, socket } = await startedConnection({
    closeFlushTimeoutMs: 20,
  });
  const error = await connection.close().catch((err: unknown) => err);
  expect(error).toBeInstanceOf(FinalFrameUnconfirmedError);
  expect((error as Error).message).toBe(
    FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_MESSAGE,
  );
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

test("the partner's sentinel drains queued frames and is answered with a normal close", async () => {
  const { connection, socket } = await startedConnection();
  socket.binary(packValue("final"));
  socket.binary(packCloseSentinel());
  expect(await connection.receive()).toBe("final");
  await expect(connection.receive()).rejects.toThrow("peer connection closed");
  expect(socket.closeCalls).toEqual([1000]);
  await connection.close();
  expect(socket.binarySent()).toEqual([]);
});

test("the partner's sentinel read while a clean close drains is answered with this side's sentinel and a wait", async () => {
  const { connection, socket } = await startedConnection({
    sendWindowBytes: 1_000,
    sendWindowLowBytes: 200,
    sendWindowPollMs: 1,
  });
  socket.bufferedAmount = 5_000;
  void connection.send("held").catch(() => {});
  let resolved = false;
  const closing = connection.close().then(() => {
    resolved = true;
  });
  await tick();
  socket.binary(packCloseSentinel());
  socket.bufferedAmount = 0;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(socket.binarySent().at(-1)).toEqual(
    new Uint8Array(packCloseSentinel()),
  );
  expect(socket.closeCalls).toEqual([]);
  expect(resolved).toBe(false);
  socket.closedByRelay(1000);
  await closing;
});

/**
 * Joins two started sockets as the relay does: a binary message is forwarded
 * to the partner, and a close is answered with its own code and closes the
 * partner behind every message already forwarded to it, with 1000 for a 1000
 * and 4000 for any other code. A socket that is not open drops a message, as
 * a WebSocket does.
 */
function relayBetween(a: FakeRelaySocket, b: FakeRelaySocket): void {
  const join = (from: FakeRelaySocket, to: FakeRelaySocket): void => {
    const send = from.send.bind(from);
    from.send = (data) => {
      send(data);
      if (typeof data === "string") return;
      const copy = new Uint8Array(data);
      setTimeout(() => {
        if (to.readyState === 1) to.binary(copy);
      }, 0);
    };
    const close = from.close.bind(from);
    from.close = (code) => {
      close(code);
      setTimeout(() => {
        if (from.readyState !== 3) from.closedByRelay(code ?? 1005);
        if (to.readyState !== 3) to.closedByRelay(code === 1000 ? 1000 : 4000);
      }, 0);
    };
  };
  join(a, b);
  join(b, a);
}

test("both parties closing at once each confirm delivery without waiting out the budget", async () => {
  const options = { closeFlushTimeoutMs: 60_000 };
  const [inviter, acceptor] = await Promise.all([
    startedConnection(options),
    startedConnection(options),
  ]);
  relayBetween(inviter.socket, acceptor.socket);
  await inviter.connection.send("inviter's last");
  await acceptor.connection.send("acceptor's last");
  expect(await inviter.connection.receive()).toBe("acceptor's last");
  expect(await acceptor.connection.receive()).toBe("inviter's last");

  const started = Date.now();
  await Promise.all([inviter.connection.close(), acceptor.connection.close()]);
  expect(Date.now() - started).toBeLessThan(1_000);
  for (const { socket } of [inviter, acceptor]) {
    expect(socket.binarySent().at(-1)).toEqual(
      new Uint8Array(packCloseSentinel()),
    );
    expect(socket.closeCalls).toEqual([1000]);
  }
});

test("a clean close one partner answers on reading the sentinel confirms both sides", async () => {
  const [closer, answerer] = await Promise.all([
    startedConnection({ closeFlushTimeoutMs: 60_000 }),
    startedConnection(),
  ]);
  relayBetween(closer.socket, answerer.socket);
  await closer.connection.send("final");
  const closing = closer.connection.close();
  expect(await answerer.connection.receive()).toBe("final");
  await expect(answerer.connection.receive()).rejects.toThrow(
    "peer connection closed",
  );
  await closing;
  expect(closer.socket.closeCalls).toEqual([]);
  expect(answerer.socket.closeCalls).toEqual([1000]);
  expect(answerer.socket.binarySent()).toEqual([]);
});

test("a malformed frame from the partner fails the connection and ends the socket abnormally", async () => {
  const { connection, socket } = await startedConnection();
  socket.binary(
    packValue({ __peerData: 7, n: 5, total: 2, data: new Uint8Array(1) }),
  );
  await expect(connection.receive()).rejects.toBeInstanceOf(ConnectionError);
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

/**
 * A started connection whose reassembler has `overrides` lowered, with the
 * kind of every outcome that reassembler returned.
 */
async function connectionWithBounds(overrides: InboundBoundOverrides) {
  const outcomes: Array<string> = [];
  const inboundFrames = (): BoundedInboundFrames => {
    const bounds = boundedInboundFramesWithBounds(overrides);
    const accept = bounds.accept.bind(bounds);
    bounds.accept = (bytes) => {
      const outcome = accept(bytes);
      outcomes.push(outcome.kind);
      return outcome;
    };
    return bounds;
  };
  return { ...(await startedConnection({ inboundFrames })), outcomes };
}

/** Forward `datagrams` in order, stopping at the first one the side refuses. */
async function forwardUntilRefused(
  socket: FakeRelaySocket,
  datagrams: Array<Uint8Array>,
): Promise<number | undefined> {
  for (const [index, datagram] of datagrams.entries()) {
    socket.binary(datagram);
    await tick();
    if (socket.closeCalls.length > 0) return index;
  }
  return undefined;
}

test("a frame larger than the receive bound is refused before its chunks are joined", async () => {
  const { connection, socket, outcomes } = await connectionWithBounds({
    maxFrameBytes: 40_000,
  });
  const datagrams = new PeerJsFrameEncoder().encode(new Uint8Array(100_000));
  expect(datagrams.every((d) => d.byteLength < 40_000)).toBe(true);

  const refusedAt = await forwardUntilRefused(socket, datagrams);
  expect(refusedAt).toBeDefined();
  expect(refusedAt).toBeLessThan(datagrams.length - 1);
  expect(outcomes.every((kind) => kind === "pending")).toBe(true);
  await expect(connection.receive()).rejects.toThrow(
    "exceeds its 40000-byte size limit",
  );
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

test("a chunk sequence declaring more chunks than the cap is refused at its first chunk", async () => {
  const { connection, socket, outcomes } = await connectionWithBounds({
    maxChunks: 4,
  });
  const datagrams = new PeerJsFrameEncoder().encode(
    new Uint8Array(6 * PEERJS_CHUNK_MTU),
  );
  expect(datagrams.length).toBeGreaterThan(4);

  expect(await forwardUntilRefused(socket, datagrams)).toBe(0);
  expect(outcomes).toEqual([]);
  await expect(connection.receive()).rejects.toThrow(
    "exceeds its 4-chunk reassembly limit",
  );
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

test("a text message once the exchange has started fails the connection", async () => {
  const { connection, socket } = await startedConnection();
  socket.text(JSON.stringify({ type: "start" }));
  await expect(connection.receive()).rejects.toMatchObject({
    kind: "protocol",
  });
});

test.each([
  [4000, "ended without a clean close"],
  [4009, "within its idle limit"],
  [4010, "partner stopped receiving. Run the exchange again."],
  [1001, "shut down"],
  [1006, "was lost (close code 1006)"],
])("a relay close %i once started fails the connection", async (code, text) => {
  const { connection, socket } = await startedConnection();
  socket.closedByRelay(code);
  await expect(connection.receive()).rejects.toThrow(text);
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test.each([
  [4004, "other than the one", "--replace-relay-key"],
  [4008, "as many exchanges as it allows", "again later"],
  [1011, "could not check this side's proof", "key table"],
  [1001, "shut down", "once it is back"],
  [4007, "refused a message this side sent (close code 4007)", "names an"],
  [4010, "the exchange partner stopped receiving", "Run the exchange again."],
])(
  "a relay close %i before the start is refused at once with its cause and next step",
  async (code, what, next) => {
    const { sockets, options } = harness({ redialIntervalMs: 1 });
    const opening = openWebSocketRelayMessageConnection(
      await relayDial(),
      options,
    );
    const socket = await socketDialed(sockets);
    socket.open();
    socket.closedByRelay(code);
    const error = await opening.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain(what);
    expect((error as Error).message).toContain(next);
    expect(statesItsOwnNextStep(error)).toBe(true);
    await sleep(20);
    expect(sockets).toHaveLength(1);
  },
);

/**
 * Open each socket the side dials and close it with `code`, after `paired`
 * where `pairFirst`, until `settled` has settled; resolves with how many.
 */
async function refuseEachDial(
  sockets: Array<FakeRelaySocket>,
  code: number,
  pairFirst: boolean,
  settled: Promise<unknown>,
): Promise<number> {
  let done = false;
  void settled.finally(() => {
    done = true;
  });
  let refused = 0;
  while (!done) {
    const socket = sockets[refused];
    if (socket !== undefined) {
      refused++;
      socket.open();
      if (pairFirst) socket.control("paired");
      socket.closedByRelay(code);
    }
    await tick();
  }
  return refused;
}

test.each([
  [4003, false, "holds no key for this exchange", "alcove enroll-relay"],
  [4006, false, "already holds a connection in this side's role", "role"],
  [4000, true, "partner left the WebSocket relay", "Agree on a time"],
  [1000, true, "partner left the WebSocket relay", "Agree on a time"],
  [4009, true, "within its idle limit", "Agree on a time"],
  [
    1006,
    false,
    "closed before the exchange started (close code 1006)",
    "reach",
  ],
  [
    4999,
    false,
    "closed before the exchange started (close code 4999)",
    "reach",
  ],
])(
  "a relay close %i before the start is dialed again, and refused with its cause once the rendezvous budget ends",
  async (code, pairFirst, what, next) => {
    const { sockets, options } = harness({
      redialIntervalMs: 5,
      rendezvousTimeoutMs: 150,
    });
    const settled = openWebSocketRelayMessageConnection(
      await relayDial(),
      options,
    ).catch((err: unknown) => err);
    const refused = await refuseEachDial(sockets, code, pairFirst, settled);
    const error = await settled;
    expect(refused).toBeGreaterThan(1);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain(what);
    expect((error as Error).message).toContain(next);
    expect(statesItsOwnNextStep(error)).toBe(true);
    for (const socket of sockets.slice(0, refused)) {
      const [hello, start, ...rest] = socket.textSent();
      expect(JSON.parse(hello)).toMatchObject({ type: "hello" });
      expect(JSON.parse(start)).toEqual({ type: "start" });
      expect(rest).toEqual([]);
    }
  },
);

test("a proof refused as expired is made again once on the relay's clock", async () => {
  const { sockets, options } = harness();
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const first = await socketDialed(sockets);
  first.open();
  const relaySeconds = NOW_SECONDS + 3_600;
  first.closedByRelay(4005, String(relaySeconds));

  const second = await socketDialed(sockets, 2);
  second.open();
  const hello = JSON.parse(second.textSent()[0]) as Record<string, string>;
  expect(hello.proof.split("\n")[2]).toBe(String(relaySeconds + 300));
  second.control("paired");
  second.control("start");
  await expect(opening).resolves.toBeDefined();
});

test("a proof refused as expired twice is refused naming the relay's clock, not this computer's", async () => {
  const { sockets, options } = harness();
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const first = await socketDialed(sockets);
  first.open();
  first.closedByRelay(4005, String(NOW_SECONDS + 3_600));
  const second = await socketDialed(sockets, 2);
  second.open();
  second.closedByRelay(4005, String(NOW_SECONDS + 7_200));
  const error = await opening.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(ConnectionError);
  expect((error as Error).message).toBe(
    "the WebSocket relay at wss://relay.example.org/relay refused this " +
      "side's proof as expired twice, the second time with a proof made on " +
      "the relay's own clock. Run the exchange again, and if the relay " +
      "refuses it the same way, check the relay and the exchange's " +
      "enrollment at its registrar.",
  );
  expect(statesItsOwnNextStep(error)).toBe(true);
  expect(sockets).toHaveLength(2);
});

test("a proof refused as expired with a relay clock past any date is not made again", async () => {
  const { sockets, options } = harness();
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const first = await socketDialed(sockets);
  first.open();
  first.closedByRelay(4005, "9999999999999999");
  const error = await opening.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(ConnectionError);
  expect((error as Error).message).toContain("Correct this computer's clock");
  expect(sockets).toHaveLength(1);
});

test("a proof refused as expired with no relay clock is not made again", async () => {
  const { sockets, options } = harness();
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const first = await socketDialed(sockets);
  first.open();
  first.closedByRelay(4005, "soon");
  await expect(opening).rejects.toThrow("Correct this computer's clock");
  expect(sockets).toHaveLength(1);
});

test("a partner that never arrives ends the wait at the rendezvous budget", async () => {
  const { sockets, options } = harness({ rendezvousTimeoutMs: 20 });
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const socket = await socketDialed(sockets);
  socket.open();
  await expect(opening).rejects.toThrow(
    "did not reach the WebSocket relay at wss://relay.example.org/relay in time",
  );
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

test("a paired partner that never starts ends the wait at the channel-open budget", async () => {
  const { sockets, options } = harness({ channelOpenTimeoutMs: 20 });
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const socket = await socketDialed(sockets);
  socket.open();
  socket.control("paired");
  await expect(opening).rejects.toThrow("did not start the exchange in time");
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

test("a relay that does not open the socket in time is abandoned and dialed again", async () => {
  const { sockets, options } = harness({
    openTimeoutMs: 20,
    redialIntervalMs: 5,
    rendezvousTimeoutMs: 120,
  });
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const socket = await socketDialed(sockets);
  await expect(opening).rejects.toThrow("did not answer in time");
  expect(sockets.length).toBeGreaterThan(1);
  for (const dialed of sockets)
    expect(dialed.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
  socket.open();
  expect(socket.sent).toEqual([]);
});

test.each([
  ["a start before the pairing", (s: FakeRelaySocket) => s.control("start")],
  [
    "a binary message before the start",
    (s: FakeRelaySocket) => {
      s.control("paired");
      s.binary(packValue("early"));
    },
  ],
  [
    "a control frame with another key",
    (s: FakeRelaySocket) => s.text(JSON.stringify({ type: "paired", x: 1 })),
  ],
  ["text that is not JSON", (s: FakeRelaySocket) => s.text("paired")],
])("%s is refused as a protocol fault", async (_, deliver) => {
  const { sockets, options } = harness();
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const socket = await socketDialed(sockets);
  socket.open();
  deliver(socket);
  await expect(opening).rejects.toMatchObject({ kind: "protocol" });
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

test("an abort before the start closes the socket and stops the dial", async () => {
  const controller = new AbortController();
  const { sockets, options } = harness({ signal: controller.signal });
  const opening = openWebSocketRelayMessageConnection(
    await relayDial(),
    options,
  );
  const socket = await socketDialed(sockets);
  socket.open();
  controller.abort();
  await expect(opening).rejects.toMatchObject({ kind: "closed" });
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

function frameTypes(socket: FakeRelaySocket): Array<unknown> {
  return socket
    .textSent()
    .map((text) => (JSON.parse(text) as { type: unknown }).type);
}

/** A parked relay and the `[paired, partnerStarted]` it showed at each change. */
async function parkedRelay(options: WebSocketRelayConnectionOptions = {}) {
  const { sockets, options: dialOptions } = harness(options);
  const relay = parkWebSocketRelay(await relayDial(), dialOptions);
  const changes: Array<[boolean, boolean]> = [];
  relay.onChange(() => changes.push([relay.paired, relay.partnerStarted]));
  return { relay, sockets, changes };
}

test("a parked relay sends its hello and holds its start until the run sends it", async () => {
  const { relay, sockets, changes } = await parkedRelay({
    channelOpenTimeoutMs: 30,
  });
  const socket = await socketDialed(sockets);
  socket.open();
  expect(frameTypes(socket)).toEqual(["hello"]);
  socket.control("paired");
  expect(relay.paired).toBe(true);
  await sleep(60);
  expect(frameTypes(socket)).toEqual(["hello"]);
  expect(relay.failure).toBeUndefined();

  const starting = relay.start();
  expect(relay.start()).toBe(starting);
  expect(frameTypes(socket)).toEqual(["hello", "start"]);
  socket.control("start");
  const connection = await starting;
  expect(changes).toEqual([
    [true, false],
    [true, true],
  ]);
  await connection.send("first");
  expect(socket.binarySent()).toHaveLength(1);
  relay.close();
  expect(socket.closeCalls).toEqual([]);
});

test("the partner's start reaching a parked relay is kept, and this side's start then opens the connection at once", async () => {
  const { relay, sockets, changes } = await parkedRelay();
  const socket = await socketDialed(sockets);
  socket.open();
  socket.control("paired");
  socket.control("start");
  expect(relay.partnerStarted).toBe(true);
  expect(frameTypes(socket)).toEqual(["hello"]);
  expect(changes).toEqual([
    [true, false],
    [true, true],
  ]);

  const connection = await relay.start();
  expect(frameTypes(socket)).toEqual(["hello", "start"]);
  socket.binary(packValue({ first: 1 }));
  expect(await connection.receive()).toEqual({ first: 1 });
});

test("the channel-open budget runs from this side's start on a pairing held parked", async () => {
  const { relay, sockets } = await parkedRelay({ channelOpenTimeoutMs: 40 });
  const socket = await socketDialed(sockets);
  socket.open();
  socket.control("paired");
  await sleep(60);
  const started = Date.now();
  await expect(relay.start()).rejects.toThrow(
    "did not start the exchange in time",
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

test("a parked pairing the partner leaves is dialed again with the start still held", async () => {
  const { relay, sockets, changes } = await parkedRelay({
    redialIntervalMs: 5,
  });
  const first = await socketDialed(sockets);
  first.open();
  first.control("paired");
  first.closedByRelay(4000);
  expect(relay.paired).toBe(false);
  expect(relay.failure).toBeUndefined();

  const second = await socketDialed(sockets, 2);
  second.open();
  expect(frameTypes(second)).toEqual(["hello"]);
  second.control("paired");
  expect(changes).toEqual([
    [true, false],
    [false, false],
    [true, false],
  ]);
  relay.close();
  expect(second.closeCalls).toEqual([1000]);
  await expect(relay.start()).rejects.toMatchObject({ kind: "closed" });
});

test("messages and a close arriving on a socket the parked relay has dialed past leave the new pairing unchanged", async () => {
  const { relay, sockets, changes } = await parkedRelay({
    redialIntervalMs: 5,
  });
  const first = await socketDialed(sockets);
  first.open();
  first.control("paired");
  first.closedByRelay(4000);

  const second = await socketDialed(sockets, 2);
  second.open();
  second.control("paired");
  const changesAtPairing = [...changes];

  first.control("paired");
  first.control("start");
  first.binary(packValue("stale"));
  first.closedByRelay(1001);
  await sleep(30);

  expect(relay.paired).toBe(true);
  expect(relay.partnerStarted).toBe(false);
  expect(relay.failure).toBeUndefined();
  expect(changes).toEqual(changesAtPairing);
  expect(sockets).toHaveLength(2);
  expect(first.closeCalls).toEqual([]);
  expect(second.closeCalls).toEqual([]);

  const starting = relay.start();
  second.control("start");
  const connection = await starting;
  second.binary(packValue({ live: 1 }));
  expect(await connection.receive()).toEqual({ live: 1 });
});

test("a socket dialed again after this side's start sends the start behind its hello", async () => {
  const { relay, sockets } = await parkedRelay({ redialIntervalMs: 5 });
  const first = await socketDialed(sockets);
  first.open();
  first.control("paired");
  const starting = relay.start();
  first.closedByRelay(1000);

  const second = await socketDialed(sockets, 2);
  second.open();
  expect(frameTypes(second)).toEqual(["hello", "start"]);
  second.control("paired");
  second.control("start");
  await expect(starting).resolves.toBeDefined();
});

test("a relay refusing the hello as not enrolled is dialed again with a fresh proof, and pairs once the key is enrolled", async () => {
  let clock = NOW;
  const { relay, sockets } = await parkedRelay({
    redialIntervalMs: 5,
    now: () => clock,
  });
  const first = await socketDialed(sockets);
  first.open();
  first.closedByRelay(4003);
  clock = new Date(NOW.getTime() + 60_000);

  const second = await socketDialed(sockets, 2);
  second.open();
  const hello = JSON.parse(second.textSent()[0]) as Record<string, string>;
  expect(hello.proof.split("\n")[2]).toBe(String(NOW_SECONDS + 60 + 300));
  second.control("paired");
  expect(relay.paired).toBe(true);
  expect(relay.failure).toBeUndefined();
  relay.close();
});

test("a proof made again on the relay's clock is made on that clock on every later socket", async () => {
  let clock = NOW;
  const { relay, sockets } = await parkedRelay({
    redialIntervalMs: 5,
    now: () => clock,
  });
  const relaySeconds = NOW_SECONDS + 3_600;
  const first = await socketDialed(sockets);
  first.open();
  first.closedByRelay(4005, String(relaySeconds));
  const second = await socketDialed(sockets, 2);
  second.open();
  second.closedByRelay(4003);
  clock = new Date(NOW.getTime() + 10_000);

  const third = await socketDialed(sockets, 3);
  third.open();
  const hello = JSON.parse(third.textSent()[0]) as Record<string, string>;
  expect(hello.proof.split("\n")[2]).toBe(String(relaySeconds + 10 + 300));
  relay.close();
});

test("closing a parked relay while it waits to dial again stops the dialing and refuses the start", async () => {
  const { relay, sockets, changes } = await parkedRelay({
    redialIntervalMs: 20,
  });
  const first = await socketDialed(sockets);
  first.open();
  first.closedByRelay(4003);
  relay.close();
  await sleep(60);
  expect(sockets).toHaveLength(1);
  expect(relay.failure).toBeUndefined();
  expect(changes).toEqual([]);
  await expect(relay.start()).rejects.toMatchObject({ kind: "closed" });
});

test("closing a relay after this side's start has been sent closes abnormally", async () => {
  const { relay, sockets } = await parkedRelay();
  const socket = await socketDialed(sockets);
  socket.open();
  socket.control("paired");
  const starting = relay.start();
  relay.close();
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
  await expect(starting).rejects.toMatchObject({ kind: "closed" });
});

test("a parked relay's refusal reaches its listeners and a later start", async () => {
  const { relay, sockets, changes } = await parkedRelay();
  const socket = await socketDialed(sockets);
  socket.open();
  socket.closedByRelay(4004);
  expect(relay.failure?.message).toContain("other than the one");
  expect(changes).toEqual([[false, false]]);
  await expect(relay.start()).rejects.toBe(relay.failure);
});

test("a binary message to a parked relay the partner has started is refused as a protocol fault", async () => {
  const { relay, sockets } = await parkedRelay();
  const socket = await socketDialed(sockets);
  socket.open();
  socket.control("paired");
  socket.control("start");
  socket.binary(packValue("early"));
  expect(relay.failure).toMatchObject({ kind: "protocol" });
  expect(socket.closeCalls).toEqual([RELAY_ABANDON_CLOSE_CODE]);
});

test("a relay parked under a signal already aborted dials no socket", async () => {
  const controller = new AbortController();
  controller.abort();
  const { relay, sockets } = await parkedRelay({ signal: controller.signal });
  await sleep(20);
  expect(sockets).toEqual([]);
  expect(relay.failure).toMatchObject({ kind: "closed" });
});

test("a run with no shared secret refuses the relay before dialing", async () => {
  const dialing = webSocketRelayDialFor(
    { websocketRelay: "wss://relay.example.org/relay" },
    undefined,
    "inviter",
  );
  await expect(dialing).rejects.toBeInstanceOf(UsageError);
  await expect(dialing).rejects.toThrow(
    websocketRelayNeedsSecretMessage({
      websocketRelay: "wss://relay.example.org/relay",
    }),
  );
});

test("a connection naming no relay resolves no dial, secret or not", async () => {
  expect(await webSocketRelayDialFor({}, undefined, "inviter")).toBeUndefined();
  expect(await webSocketRelayDialFor({}, SECRET, "inviter")).toBeUndefined();
});

test("the dial names relay_registrar's exchange id when one is set", async () => {
  const dial = await webSocketRelayDialFor(
    {
      websocketRelay: "wss://relay.example.org/relay",
      relayRegistrar: {
        url: "https://registrar.example.org",
        exchangeId: "acme-weekly",
      },
    },
    SECRET,
    "acceptor",
  );
  expect(dial).toEqual({
    url: "wss://relay.example.org/relay",
    exchangeId: "acme-weekly",
    relayKey: await deriveRelayKey(SECRET),
    role: "acceptor",
  });
});

test("an unknown relay close code before the start names the code", () => {
  const error = relayRefusalError("wss://relay.example.org/relay", 4999, "");
  expect(error.message).toContain("(close code 4999)");
  expect(error.kind).toBe("transport");
});

test("the frame encoder the transport uses chunks at the relay's chunk size", () => {
  const datagrams = new PeerJsFrameEncoder().encode(
    new Uint8Array(2 * PEERJS_CHUNK_MTU),
  );
  expect(datagrams.every((d) => d.byteLength <= 16_384)).toBe(true);
});
