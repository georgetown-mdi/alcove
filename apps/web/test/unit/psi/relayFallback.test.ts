import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  ConnectionError,
  getDiagnosticSink,
  setDiagnosticSink,
} from "@alcove/core";

import {
  openRunConnectionWithRelayFallback,
  raceWebRtcAgainstRelays,
} from "@psi/transport/relayFallback";

import type { MessageConnection, RendezvousRole } from "@alcove/core";
import type {
  WebRtcPathFailure,
  WebRtcPathHooks,
} from "@psi/transport/relayFallback";
import type { ParkedWebSocketRelayConnection } from "@psi/transport/websocketRelayConnection";
import type { RunConnection } from "@psi/transport/runConnection";

// The web fallback race over fake transports: where each role sends its
// start, what sends it, which path wins, and what is closed or released.
// The CLI's race (apps/cli/test/unit/connection/relayFallback.test.ts) holds
// the same cases, since both parties must agree on the wire.

const logLines: Array<string> = [];
const priorSink = getDiagnosticSink();
beforeEach(() => {
  setDiagnosticSink((_method, _prefix, args) => {
    logLines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  setDiagnosticSink(priorSink);
  logLines.length = 0;
});

/** A connection that records its close. */
function fakeConnection(): MessageConnection & { closes: number } {
  const connection = {
    closes: 0,
    send: () => Promise.resolve(),
    receive: () => Promise.resolve(undefined),
    close: () => {
      connection.closes += 1;
      return Promise.resolve();
    },
  };
  return connection;
}

/**
 * A parked relay the test drives: pairing, the partner's start and a failure
 * are set by hand, and `start()` resolves as the real one does, once this
 * side has started and the partner's start has arrived on a pairing.
 */
class FakeRelay implements ParkedWebSocketRelayConnection {
  paired = false;
  partnerStarted = false;
  failure: ConnectionError | undefined;
  startCalls = 0;
  closeCalls = 0;
  /** The socket closes as this side's start is sent, failing the relay. */
  failOnStart = false;
  readonly connection = fakeConnection();
  private opened = false;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private starting:
    | {
        promise: Promise<MessageConnection>;
        resolve: (connection: MessageConnection) => void;
        reject: (error: unknown) => void;
      }
    | undefined;

  constructor(readonly url: string) {}

  onChange = (listener: () => void): (() => void) => {
    const call = (): void => listener();
    this.listeners.add(call);
    return () => this.listeners.delete(call);
  };

  start = (): Promise<MessageConnection> => {
    this.startCalls += 1;
    if (this.starting === undefined) {
      let resolve!: (connection: MessageConnection) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<MessageConnection>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.starting = { promise, resolve, reject };
      if (this.failure !== undefined) reject(this.failure);
      else if (this.failOnStart) queueMicrotask(() => this.fail());
      else this.openIfReady();
    }
    return this.starting.promise;
  };

  close = (): void => {
    this.closeCalls += 1;
    if (this.opened || this.closed || this.failure !== undefined) return;
    this.closed = true;
    this.listeners.clear();
    this.starting?.reject(new ConnectionError("stopped", "closed"));
  };

  get startSent(): boolean {
    return this.starting !== undefined;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Whether this side's start is out on this relay and the relay may still carry it. */
  get holdsStart(): boolean {
    return this.startSent && !this.closed && this.failure === undefined;
  }

  pair(): void {
    this.paired = true;
    this.notify();
  }

  partnerLeaves(): void {
    this.paired = false;
    this.partnerStarted = false;
    this.notify();
  }

  partnerStarts(): void {
    this.partnerStarted = true;
    this.openIfReady();
    this.notify();
  }

  fail(message = `refused at ${this.url}`): void {
    this.failure = new ConnectionError(message, "transport");
    this.paired = false;
    this.partnerStarted = false;
    this.starting?.reject(this.failure);
    this.notify();
  }

  private openIfReady(): void {
    if (
      this.starting === undefined ||
      this.failOnStart ||
      !this.paired ||
      !this.partnerStarted
    )
      return;
    this.opened = true;
    this.starting.resolve(this.connection);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** A WebRTC path the test drives, rejecting on its signal as the real one does. */
function fakeWebRtc({ ignoresAbort = false } = {}) {
  let resolve!: (runConnection: RunConnection) => void;
  let reject!: (error: unknown) => void;
  let hooks: Required<WebRtcPathHooks> | undefined;
  const runConnection = { connection: fakeConnection(), release: vi.fn() };
  const open = (given: Required<WebRtcPathHooks>): Promise<RunConnection> =>
    new Promise((res, rej) => {
      hooks = given;
      resolve = res;
      reject = rej;
      if (ignoresAbort) return;
      given.signal.addEventListener("abort", () =>
        rej(new Error("opening the connection was aborted")),
      );
    });
  return {
    open,
    runConnection,
    pathFails: (failure: WebRtcPathFailure = "channel-not-opened") =>
      hooks?.onPathFailed(failure),
    opens: () => resolve(runConnection),
    fails: (error: unknown) => reject(error),
    get aborted(): boolean {
      return hooks?.signal.aborted === true;
    },
  };
}

function race(
  role: RendezvousRole,
  parked: Array<FakeRelay>,
  webRtc = fakeWebRtc(),
  signal?: AbortSignal,
) {
  const outcome = raceWebRtcAgainstRelays({
    role,
    relays: parked,
    openWebRtc: webRtc.open,
    signal,
  });
  outcome.catch(() => {});
  return { outcome, webRtc };
}

/** Let promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function relays(...names: Array<string>): Array<FakeRelay> {
  return names.map((name) => new FakeRelay(`wss://${name}.test/relay`));
}

test("a channel that opens first carries the exchange and closes every relay unused", async () => {
  const [a, b] = relays("a", "b");
  b.pair();
  const { outcome, webRtc } = race("inviter", [a, b]);
  webRtc.opens();
  const result = await outcome;
  expect(result.path).toEqual({ kind: "webrtc" });
  expect(result.runConnection).toBe(webRtc.runConnection);
  expect([a.startSent, b.startSent]).toEqual([false, false]);
  expect([a.isClosed, b.isClosed]).toEqual([true, true]);
});

test("the inviter sends its start on the first paired relay in list order only", async () => {
  const [a, b, c] = relays("a", "b", "c");
  b.pair();
  c.pair();
  const { outcome, webRtc } = race("inviter", [a, b, c]);
  webRtc.pathFails();
  await settle();
  expect([a.startSent, b.startSent, c.startSent]).toEqual([false, true, false]);
  expect(webRtc.aborted).toBe(false);
  b.partnerStarts();
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: b.url });
  expect(result.runConnection.connection).toBe(b.connection);
  expect(webRtc.aborted).toBe(true);
  expect([a.isClosed, c.isClosed]).toEqual([true, true]);
});

test("an inviter with no paired relay sends its start on the first to pair", async () => {
  const [a, b] = relays("a", "b");
  const { outcome, webRtc } = race("inviter", [a, b]);
  webRtc.pathFails("connection-failed");
  await settle();
  expect([a.startSent, b.startSent]).toEqual([false, false]);
  b.pair();
  a.pair();
  expect([a.startSent, b.startSent]).toEqual([false, true]);
  b.partnerStarts();
  expect((await outcome).path).toEqual({ kind: "websocket-relay", url: b.url });
});

test("the partner's start abandons WebRTC, and the inviter starts on the relay it arrived on", async () => {
  const [a, b] = relays("a", "b");
  a.pair();
  b.pair();
  const { outcome, webRtc } = race("inviter", [a, b]);
  b.partnerStarts();
  expect(webRtc.aborted).toBe(true);
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: b.url });
  expect(a.startSent).toBe(false);
  expect(a.isClosed).toBe(true);
});

test("the acceptor sends its start on every paired relay and keeps the one the inviter's start arrives on", async () => {
  const [a, b, c] = relays("a", "b", "c");
  a.pair();
  b.pair();
  const { outcome, webRtc } = race("acceptor", [a, b, c]);
  webRtc.pathFails();
  await settle();
  expect([a.startSent, b.startSent, c.startSent]).toEqual([true, true, false]);
  c.pair();
  expect(c.startSent).toBe(true);
  b.partnerStarts();
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: b.url });
  expect(webRtc.aborted).toBe(true);
  expect([a.isClosed, b.isClosed, c.isClosed]).toEqual([true, false, true]);
});

test("the inviter's start reaching the acceptor first abandons WebRTC and starts every paired relay", async () => {
  const [a, b] = relays("a", "b");
  a.pair();
  b.pair();
  const { outcome, webRtc } = race("acceptor", [a, b]);
  a.partnerStarts();
  expect(webRtc.aborted).toBe(true);
  expect([a.startSent, b.startSent]).toEqual([true, true]);
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: a.url });
  expect(b.isClosed).toBe(true);
});

test("a channel that opens after the start was sent still carries the exchange", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race("acceptor", [a]);
  webRtc.pathFails();
  await settle();
  expect(a.startSent).toBe(true);
  webRtc.opens();
  expect((await outcome).path).toEqual({ kind: "webrtc" });
  expect(a.isClosed).toBe(true);
});

test.each<WebRtcPathFailure>([
  "channel-not-opened",
  "connection-failed",
  "signaling-unreachable",
])(
  "a WebRTC open that fails after a path failure (%s) leaves the exchange to the relay",
  async (failure) => {
    const [a] = relays("a");
    const { outcome, webRtc } = race("inviter", [a]);
    webRtc.pathFails(failure);
    webRtc.fails(new ConnectionError("no path", "transport"));
    await settle();
    a.pair();
    expect(a.startSent).toBe(true);
    a.partnerStarts();
    expect((await outcome).path).toEqual({
      kind: "websocket-relay",
      url: a.url,
    });
  },
);

test("a WebRTC failure with no path failure before it fails the run and closes every relay", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race("inviter", [a]);
  const noShow = new Error("the partner did not arrive");
  webRtc.fails(noShow);
  await expect(outcome).rejects.toBe(noShow);
  expect(a.startSent).toBe(false);
  expect(a.isClosed).toBe(true);
});

test("a security failure stays fatal after a path failure", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race("acceptor", [a]);
  webRtc.pathFails();
  await settle();
  const refusal = new ConnectionError("endpoint refused", "security");
  webRtc.fails(refusal);
  await expect(outcome).rejects.toBe(refusal);
  expect(a.isClosed).toBe(true);
});

test("both paths failing together fail with the WebRTC failure and log each relay's refusal", async () => {
  const [a, b] = relays("a", "b");
  b.pair();
  const { outcome, webRtc } = race("inviter", [a, b]);
  webRtc.pathFails();
  const webRtcFailure = new ConnectionError(
    "channel did not open",
    "transport",
  );
  webRtc.fails(webRtcFailure);
  a.fail("relay a refused");
  b.fail("relay b refused");
  await expect(outcome).rejects.toBe(webRtcFailure);
  expect(logLines.some((line) => line.includes("relay a refused"))).toBe(true);
  expect(logLines.some((line) => line.includes("relay b refused"))).toBe(true);
});

test("every relay failing while WebRTC still tries leaves the run to WebRTC", async () => {
  const [a] = relays("a");
  const { outcome, webRtc } = race("inviter", [a]);
  webRtc.pathFails();
  a.fail();
  await settle();
  webRtc.opens();
  expect((await outcome).path).toEqual({ kind: "webrtc" });
});

test("an abandoned WebRTC open with every relay failed fails with the relay's refusal", async () => {
  const [a] = relays("a");
  a.pair();
  a.failOnStart = true;
  const { outcome, webRtc } = race("inviter", [a]);
  a.partnerStarts();
  expect(webRtc.aborted).toBe(true);
  await expect(outcome).rejects.toMatchObject({
    message: `refused at ${a.url}`,
  });
});

test("the partner leaving a parked pairing, with no start on another relay, keeps the inviter's start on that relay", async () => {
  const [a, b] = relays("a", "b");
  a.pair();
  b.pair();
  const { outcome, webRtc } = race("inviter", [a, b]);
  webRtc.pathFails();
  await settle();
  a.partnerLeaves();
  await settle();
  expect([a.startSent, b.startSent]).toEqual([true, false]);
  expect(a.isClosed).toBe(false);
  a.pair();
  a.partnerStarts();
  expect((await outcome).path).toEqual({ kind: "websocket-relay", url: a.url });
  expect(a.startCalls).toBe(1);
});

test("the partner leaving the inviter's relay and starting on another moves the inviter's start there, closing the first", async () => {
  const [a, b] = relays("a", "b");
  a.pair();
  b.pair();
  const events: Array<string> = [];
  const closeA = a.close;
  a.close = () => {
    events.push("close a");
    closeA();
  };
  const startB = b.start;
  b.start = () => {
    events.push("start b");
    return startB();
  };
  const { outcome, webRtc } = race("inviter", [a, b]);
  webRtc.pathFails();
  await settle();
  a.partnerLeaves();
  b.partnerStarts();
  expect(a.isClosed).toBe(true);
  expect(events).toEqual(["close a", "start b"]);
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: b.url });
  expect(a.startCalls).toBe(1);
});

test("the inviter's start is never held by two relays at once", async () => {
  const group = relays("a", "b", "c");
  const [a, b, c] = group;
  const held: Array<number> = [];
  for (const relay of group) {
    const start = relay.start;
    relay.start = () => {
      held.push(
        group.filter((other) => other !== relay && other.holdsStart).length,
      );
      return start();
    };
  }
  a.pair();
  b.pair();
  c.pair();
  const { outcome, webRtc } = race("inviter", group);
  webRtc.pathFails();
  await settle();
  a.partnerLeaves();
  await settle();
  a.pair();
  a.partnerLeaves();
  await settle();
  expect([a.startSent, b.startSent, c.startSent]).toEqual([true, false, false]);
  c.partnerStarts();
  expect((await outcome).path).toEqual({ kind: "websocket-relay", url: c.url });
  expect([a.isClosed, b.isClosed]).toEqual([true, true]);
  expect(held).toEqual([0, 0]);
});

test("a partner that left before the start gets the acceptor's start once it pairs again", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race("acceptor", [a]);
  a.partnerLeaves();
  webRtc.pathFails();
  await settle();
  expect(a.startSent).toBe(false);
  a.pair();
  expect(a.startSent).toBe(true);
  a.partnerStarts();
  expect((await outcome).path.kind).toBe("websocket-relay");
});

test("the inviter's start moves to the next paired relay when its chosen one fails", async () => {
  const [a, b] = relays("a", "b");
  a.pair();
  b.pair();
  const { outcome, webRtc } = race("inviter", [a, b]);
  webRtc.pathFails();
  await settle();
  expect([a.startSent, b.startSent]).toEqual([true, false]);
  a.fail();
  await settle();
  expect(b.startSent).toBe(true);
  b.partnerStarts();
  expect((await outcome).path).toEqual({ kind: "websocket-relay", url: b.url });
});

test("the run's interrupt fails the race, closes every relay and aborts WebRTC", async () => {
  const [a] = relays("a");
  a.pair();
  const interrupt = new AbortController();
  const { outcome, webRtc } = race(
    "inviter",
    [a],
    fakeWebRtc(),
    interrupt.signal,
  );
  interrupt.abort();
  await expect(outcome).rejects.toMatchObject({ kind: "closed" });
  expect(a.isClosed).toBe(true);
  expect(webRtc.aborted).toBe(true);
});

test("a channel that opens after the relay carried the exchange is closed and released", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race(
    "inviter",
    [a],
    fakeWebRtc({ ignoresAbort: true }),
  );
  a.partnerStarts();
  await outcome;
  webRtc.opens();
  await settle();
  expect(webRtc.runConnection.connection.closes).toBe(1);
  expect(webRtc.runConnection.release).toHaveBeenCalledTimes(1);
});

/** A socket that never opens, recording what it is sent and how it closes. */
function idleSocket(record: { sent: Array<unknown>; closes: Array<number> }) {
  const socket = new EventTarget() as unknown as WebSocket;
  Object.assign(socket, {
    readyState: 0,
    send: (data: unknown) => record.sent.push(data),
    close: (code: number) => record.closes.push(code),
  });
  return socket;
}

const SHARED_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i),
).toString("base64url");

test("an empty relay list opens WebRTC alone, on the run's own signal, and dials no relay socket", async () => {
  const createSocket = vi.fn((): WebSocket => {
    throw new Error("no relay socket may be dialed");
  });
  const signal = new AbortController().signal;
  const runConnection = { connection: fakeConnection(), release: vi.fn() };
  const openWebRtc = vi.fn(() => Promise.resolve(runConnection));
  const onRunNotice = vi.fn();

  const opened = await openRunConnectionWithRelayFallback(
    {
      role: "inviter",
      sharedSecret: SHARED_SECRET,
      relays: [],
      signal,
      onCloseOutcome: () => {},
      onRunNotice,
      openWebRtc,
    },
    { createSocket },
  );

  expect(opened).toBe(runConnection);
  expect(openWebRtc).toHaveBeenCalledWith({ signal });
  expect(openWebRtc.mock.calls[0]).not.toHaveProperty([0, "onPathFailed"]);
  expect(createSocket).not.toHaveBeenCalled();
  expect(onRunNotice).not.toHaveBeenCalled();
});

test("a listed relay is dialed as the WebRTC open starts, and a channel that opens closes it unused and says so", async () => {
  const record = { sent: [] as Array<unknown>, closes: [] as Array<number> };
  const dialed: Array<string> = [];
  const createSocket = vi.fn((url: string) => {
    dialed.push(url);
    return idleSocket(record);
  });
  const runConnection = { connection: fakeConnection(), release: vi.fn() };
  let hooks: WebRtcPathHooks | undefined;
  let openWebRtc!: (runConnection: RunConnection) => void;
  const onRunNotice = vi.fn();

  const opening = openRunConnectionWithRelayFallback(
    {
      role: "acceptor",
      sharedSecret: SHARED_SECRET,
      relays: [{ url: "wss://relay.test/relay", exchangeId: "exchange" }],
      signal: new AbortController().signal,
      onCloseOutcome: () => {},
      onRunNotice,
      openWebRtc: (given) =>
        new Promise((resolve) => {
          hooks = given;
          openWebRtc = resolve;
        }),
    },
    { createSocket },
  );
  await vi.waitFor(() => expect(dialed).toEqual(["wss://relay.test/relay"]));
  expect(hooks?.onPathFailed).toBeTypeOf("function");
  openWebRtc(runConnection);

  expect(await opening).toBe(runConnection);
  expect(record.sent).toEqual([]);
  expect(record.closes).toEqual([1000]);
  expect(onRunNotice.mock.calls).toEqual([
    ["This exchange runs over the WebRTC connection."],
  ]);
});

test("a listed relay closes unused on the run's interrupt and the open fails as cancelled", async () => {
  const record = { sent: [] as Array<unknown>, closes: [] as Array<number> };
  const createSocket = vi.fn(() => idleSocket(record));
  const interrupt = new AbortController();
  const opening = openRunConnectionWithRelayFallback(
    {
      role: "inviter",
      sharedSecret: SHARED_SECRET,
      relays: [{ url: "wss://relay.test/relay", exchangeId: "exchange" }],
      signal: interrupt.signal,
      onCloseOutcome: () => {},
      openWebRtc: ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("opening the connection was aborted")),
          ),
        ),
    },
    { createSocket },
  );
  opening.catch(() => {});
  await vi.waitFor(() => expect(createSocket).toHaveBeenCalledTimes(1));
  interrupt.abort();
  await expect(opening).rejects.toMatchObject({ kind: "closed" });
  expect(record.closes).toEqual([1000]);
});
