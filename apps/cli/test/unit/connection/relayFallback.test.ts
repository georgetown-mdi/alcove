import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import {
  AuthenticationError,
  ConnectionError,
  setDiagnosticSink,
  setLogLevel,
} from "@alcove/core";

import { RELAY_ABANDON_CLOSE_CODE } from "../../../src/connection/webrtc/websocketRelayConnection";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";

import type { MessageConnection, RendezvousRole } from "@alcove/core";
import type { ParkedWebSocketRelay } from "../../../src/connection/webrtc/websocketRelayConnection";
import type { WebRtcPathFailure } from "../../../src/connection/webrtc/weriftPeer";

const webRtcDials = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock(
  "../../../src/connection/webrtc/webrtcMessageConnection",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/connection/webrtc/webrtcMessageConnection")
    >()),
    openWebRtcMessageConnection: vi.fn(
      (options: Record<string, unknown>) =>
        new Promise<MessageConnection>(() => {
          webRtcDials.push(options);
        }),
    ),
  }),
);

const { openWebRtcWithRelayFallback, raceWebRtcAgainstRelays } =
  await import("../../../src/connection/webrtc/relayFallback");

snapshotDiagnosticSinkAndLevel();

afterEach(() => {
  webRtcDials.length = 0;
});

/** A connection that records its close. */
function fakeConnection(): MessageConnection & { closes: number } {
  const connection = {
    closes: 0,
    send: async () => {},
    receive: async () => undefined,
    close: async () => {
      connection.closes += 1;
    },
  };
  return connection;
}

/**
 * A parked relay the test drives: pairing, the partner's start and a failure
 * are set by hand, and `start()` resolves as the real one does, once this
 * side has started and the partner's start has arrived on a pairing.
 */
class FakeRelay implements ParkedWebSocketRelay {
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

  onChange(listener: () => void): () => void {
    const call = (): void => listener();
    this.listeners.add(call);
    return () => this.listeners.delete(call);
  }

  start(): Promise<MessageConnection> {
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
  }

  /** The code the real relay closes with, by {@link ParkedWebSocketRelay.close}'s contract. */
  closeCode: number | undefined;

  close(): void {
    if (this.opened || this.closed || this.failure !== undefined) return;
    this.closed = true;
    this.closeCalls += 1;
    this.closeCode = this.startSent ? RELAY_ABANDON_CLOSE_CODE : 1000;
    this.listeners.clear();
    this.starting?.reject(new ConnectionError("stopped", "closed"));
  }

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
  let resolve!: (connection: MessageConnection) => void;
  let reject!: (error: unknown) => void;
  let hooks:
    | {
        signal: AbortSignal;
        onPathFailed: (failure: WebRtcPathFailure) => void;
      }
    | undefined;
  const connection = fakeConnection();
  const open = (given: NonNullable<typeof hooks>): Promise<MessageConnection> =>
    new Promise((res, rej) => {
      hooks = given;
      resolve = res;
      reject = rej;
      if (ignoresAbort) return;
      given.signal.addEventListener("abort", () =>
        rej(
          new ConnectionError("the WebRTC rendezvous was cancelled", "closed"),
        ),
      );
    });
  return {
    open,
    connection,
    pathFails: (failure: WebRtcPathFailure = "channel-not-opened") =>
      hooks?.onPathFailed(failure),
    opens: () => resolve(connection),
    fails: (error: unknown) => reject(error),
    get aborted(): boolean {
      return hooks?.signal.aborted === true;
    },
  };
}

function race(
  role: RendezvousRole,
  relays: FakeRelay[],
  webRtc = fakeWebRtc(),
  signal?: AbortSignal,
) {
  const outcome = raceWebRtcAgainstRelays({
    role,
    relays,
    openWebRtc: webRtc.open,
    signal,
  });
  outcome.catch(() => {});
  return { outcome, webRtc };
}

/** Let promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function relays(...urls: string[]): FakeRelay[] {
  return urls.map((url) => new FakeRelay(`wss://${url}.test/relay`));
}

/**
 * Record, at each start sent on one of `group`, how many others of `group`
 * already hold this side's start.
 */
function recordStartsHeldElsewhere(group: FakeRelay[]): number[] {
  const held: number[] = [];
  for (const relay of group) {
    const start = relay.start.bind(relay);
    relay.start = () => {
      held.push(
        group.filter((other) => other !== relay && other.holdsStart).length,
      );
      return start();
    };
  }
  return held;
}

test("a channel that opens first carries the exchange and closes every relay unused", async () => {
  const [a, b] = relays("a", "b");
  b.pair();
  const { outcome, webRtc } = race("inviter", [a, b]);
  webRtc.opens();
  const result = await outcome;
  expect(result.path).toEqual({ kind: "webrtc" });
  expect(result.connection).toBe(webRtc.connection);
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
  expect(result.connection).toBe(b.connection);
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
  const result = await outcome;
  expect(result.path).toEqual({ kind: "webrtc" });
  expect(a.isClosed).toBe(true);
});

test("a WebRTC wait that fails after a path failure leaves the exchange to the relay", async () => {
  const [a] = relays("a");
  const { outcome, webRtc } = race("inviter", [a]);
  webRtc.pathFails();
  webRtc.fails(new ConnectionError("no path", "transport"));
  await settle();
  a.pair();
  a.partnerStarts();
  expect((await outcome).path).toEqual({ kind: "websocket-relay", url: a.url });
});

test("an unreachable coordination server sends the start", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race("inviter", [a]);
  webRtc.pathFails("signaling-unreachable");
  webRtc.fails(new ConnectionError("unreachable", "transport"));
  await settle();
  expect(a.startSent).toBe(true);
  a.partnerStarts();
  expect((await outcome).path.kind).toBe("websocket-relay");
});

test("a WebRTC failure with no path failure before it fails the run and closes every relay", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race("inviter", [a]);
  const refusal = new ConnectionError("id taken", "usage");
  webRtc.fails(refusal);
  await expect(outcome).rejects.toBe(refusal);
  expect(a.startSent).toBe(false);
  expect(a.isClosed).toBe(true);
});

test("a signaling certificate that did not verify stays fatal after a path failure", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race("acceptor", [a]);
  webRtc.pathFails();
  await settle();
  const refusal = new AuthenticationError("certificate did not verify");
  webRtc.fails(refusal);
  await expect(outcome).rejects.toBe(refusal);
  expect(a.isClosed).toBe(true);
});

test("both budgets expiring together fail with the WebRTC failure and log each relay's refusal", async () => {
  const lines: string[] = [];
  setDiagnosticSink((_method, _prefix, args) => {
    lines.push(args.map(String).join(" "));
  });
  setLogLevel(logLibrary.levels.INFO);
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
  expect(lines.some((line) => line.includes("relay a refused"))).toBe(true);
  expect(lines.some((line) => line.includes("relay b refused"))).toBe(true);
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

test("an abandoned WebRTC wait with every relay failed fails with the relay's refusal", async () => {
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
  const { outcome, webRtc } = race("inviter", [a, b]);
  webRtc.pathFails();
  await settle();
  a.partnerLeaves();
  b.partnerStarts();
  expect(a.isClosed).toBe(true);
  expect(a.closeCode).toBe(RELAY_ABANDON_CLOSE_CODE);
  expect(b.startSent).toBe(true);
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: b.url });
  expect(result.connection).toBe(b.connection);
  expect(a.startCalls).toBe(1);
});

test("the inviter's start is never held by two relays at once", async () => {
  const [a, b, c] = relays("a", "b", "c");
  const held = recordStartsHeldElsewhere([a, b, c]);
  a.pair();
  b.pair();
  c.pair();
  const { outcome, webRtc } = race("inviter", [a, b, c]);
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
  expect([a.startSent, b.startSent]).toEqual([true, false]);
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

test("a channel that opens after the relay carried the exchange is closed", async () => {
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
  expect(webRtc.connection.closes).toBe(1);
});

const BROKER = {
  host: "broker.test",
  port: 443,
  path: "/",
  key: "peerjs",
  secure: true,
};

test("an empty relay list opens WebRTC alone and dials no relay socket", async () => {
  const socketFactory = vi.fn((): WebSocket => {
    throw new Error("no relay socket may be dialed");
  });
  void openWebRtcWithRelayFallback(
    {
      location: BROKER,
      role: "inviter",
      sharedSecret: "secret",
    },
    [],
    { socketFactory },
  );
  await settle();
  expect(webRtcDials).toHaveLength(1);
  expect(webRtcDials[0]).not.toHaveProperty("onPathFailed");
  expect(socketFactory).not.toHaveBeenCalled();
});

test("a listed relay is dialed as the WebRTC rendezvous starts", async () => {
  const dialed: string[] = [];
  const socketFactory = vi.fn((url: string): WebSocket => {
    dialed.push(url);
    const socket = new EventTarget() as unknown as WebSocket;
    Object.assign(socket, { readyState: 0, close: () => {}, send: () => {} });
    return socket;
  });
  const interrupt = new AbortController();
  const opening = openWebRtcWithRelayFallback(
    {
      location: BROKER,
      role: "acceptor",
      sharedSecret: "secret",
      signal: interrupt.signal,
    },
    [
      {
        url: "wss://relay.test/relay",
        exchangeId: "exchange",
        relayKey: "0".repeat(64),
        role: "acceptor",
      },
    ],
    { socketFactory },
  );
  opening.catch(() => {});
  await vi.waitFor(() => expect(dialed).toEqual(["wss://relay.test/relay"]));
  expect(webRtcDials).toHaveLength(1);
  expect(webRtcDials[0]).toHaveProperty("onPathFailed");
  interrupt.abort();
  await expect(opening).rejects.toMatchObject({ kind: "closed" });
});
