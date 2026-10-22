import { expect, test } from "vitest";

import { ConnectionError } from "../../src/errors";
import { raceWebRtcAgainstRelays } from "../../src/connection/relayFallback";

import type {
  ParkedRelay,
  RelayFallbackAdapter,
  WebRtcPathFailure,
} from "../../src/connection/relayFallback";
import type { MessageConnection } from "../../src/connection/messageConnection";
import type { RendezvousRole } from "../../src/rendezvousRoles";

// The fallback race over fake transports: where each role sends its start,
// what sends it, which path wins, what is closed, and what the race hands its
// adapter. Each app's suite holds its own adapter to the same race.

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

/** The connection the race resolves with: what the adapter made of a path's. */
interface RaceConnection {
  connection: MessageConnection;
}

/**
 * A parked relay the test drives: pairing, the partner's start and a failure
 * are set by hand, and `start()` resolves as the real one does, once this
 * side has started and the partner's start has arrived on a pairing.
 */
class FakeRelay implements ParkedRelay {
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

  close(): void {
    this.closeCalls += 1;
    if (this.opened || this.closed || this.failure !== undefined) return;
    this.closed = true;
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
  let resolve!: (connection: RaceConnection) => void;
  let reject!: (error: unknown) => void;
  let hooks:
    | {
        signal: AbortSignal;
        onPathFailed: (failure: WebRtcPathFailure) => void;
      }
    | undefined;
  const opened: RaceConnection = { connection: fakeConnection() };
  const open = (given: NonNullable<typeof hooks>): Promise<RaceConnection> =>
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
    opened,
    pathFails: (failure: WebRtcPathFailure = "channel-not-opened") =>
      hooks?.onPathFailed(failure),
    opens: () => resolve(opened),
    fails: (error: unknown) => reject(error),
    get aborted(): boolean {
      return hooks?.signal.aborted === true;
    },
  };
}

/** The failure the test adapter takes as fatal after a path failure. */
class FatalWebRtcError extends Error {}

/**
 * An adapter that records what the race hands it: each logged line with its
 * level, and each connection it closed as unused.
 */
function recordingAdapter() {
  const lines: Array<[level: string, line: string]> = [];
  const closedUnused: Array<RaceConnection> = [];
  const adapter: RelayFallbackAdapter<RaceConnection> = {
    log: {
      debug: (line: string) => lines.push(["debug", line]),
      info: (line: string) => lines.push(["info", line]),
      warn: (line: string) => lines.push(["warn", line]),
    },
    fromRelay: (connection) => ({ connection }),
    closeUnused: (connection) => closedUnused.push(connection),
    isFatal: (error) => error instanceof FatalWebRtcError,
    displayUrl: (url) => `<${url}>`,
    describeWebRtcFailure: (error) =>
      `WebRTC failed: ${(error as Error).message}`,
    displayRefusal: (refusal) => `refusal: ${refusal.message}`,
  };
  return { adapter, lines, closedUnused };
}

function race(
  role: RendezvousRole,
  parked: Array<FakeRelay>,
  webRtc = fakeWebRtc(),
  signal?: AbortSignal,
) {
  const recording = recordingAdapter();
  const outcome = raceWebRtcAgainstRelays(
    { role, relays: parked, openWebRtc: webRtc.open, signal },
    recording.adapter,
  );
  outcome.catch(() => {});
  return { outcome, webRtc, ...recording };
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
  expect(result.connection).toBe(webRtc.opened);
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
  expect(result.connection.connection).toBe(b.connection);
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

test("a second relay that opens after the first carried the exchange is closed unused", async () => {
  const [a, b] = relays("a", "b");
  a.pair();
  b.pair();
  a.partnerStarted = true;
  b.partnerStarted = true;
  const { outcome, closedUnused } = race("acceptor", [a, b]);
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: a.url });
  await settle();
  expect(closedUnused).toEqual([{ connection: b.connection }]);
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

test("a failure the adapter takes as fatal stays fatal after a path failure", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc } = race("acceptor", [a]);
  webRtc.pathFails();
  await settle();
  const refusal = new FatalWebRtcError("certificate did not verify");
  webRtc.fails(refusal);
  await expect(outcome).rejects.toBe(refusal);
  expect(a.isClosed).toBe(true);
});

test("both paths failing together fail with the WebRTC failure and log each relay's refusal as a warning", async () => {
  const [a, b] = relays("a", "b");
  b.pair();
  const { outcome, webRtc, lines } = race("inviter", [a, b]);
  webRtc.pathFails();
  const webRtcFailure = new ConnectionError(
    "channel did not open",
    "transport",
  );
  webRtc.fails(webRtcFailure);
  a.fail("relay a refused");
  b.fail("relay b refused");
  await expect(outcome).rejects.toBe(webRtcFailure);
  expect(lines.filter(([level]) => level === "warn")).toEqual([
    ["warn", "refusal: relay a refused"],
    ["warn", "refusal: relay b refused"],
  ]);
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
  const closeA = a.close.bind(a);
  a.close = () => {
    events.push("close a");
    closeA();
  };
  const startB = b.start.bind(b);
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
  expect(a.closeCalls).toBe(1);
  expect(events).toEqual(["close a", "start b"]);
  expect(b.startSent).toBe(true);
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: b.url });
  expect(result.connection.connection).toBe(b.connection);
  expect(a.startCalls).toBe(1);
});

test("the inviter's start is never held by two relays at once", async () => {
  const group = relays("a", "b", "c");
  const [a, b, c] = group;
  const held: Array<number> = [];
  for (const relay of group) {
    const start = relay.start.bind(relay);
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

test("a channel that opens after the relay carried the exchange is closed unused", async () => {
  const [a] = relays("a");
  a.pair();
  const { outcome, webRtc, closedUnused } = race(
    "inviter",
    [a],
    fakeWebRtc({ ignoresAbort: true }),
  );
  a.partnerStarts();
  await outcome;
  webRtc.opens();
  await settle();
  expect(closedUnused).toHaveLength(1);
  expect(closedUnused[0]).toBe(webRtc.opened);
});

test("the race logs its start, a relay's end, a moved start and the carrying path, each address as the adapter shows it", async () => {
  const [a, b, c] = relays("a", "b", "c");
  a.pair();
  b.pair();
  const { outcome, webRtc, lines } = race("inviter", [a, b, c]);
  c.fail();
  webRtc.pathFails();
  await settle();
  webRtc.fails(new ConnectionError("channel did not open", "transport"));
  await settle();
  a.partnerLeaves();
  b.partnerStarts();
  await outcome;
  expect(lines).toEqual([
    [
      "debug",
      "the WebSocket relay at <wss://c.test/relay> ended before the exchange started on it",
    ],
    ["debug", "the WebRTC path reported a failure (channel-not-opened)"],
    [
      "info",
      "no WebRTC connection has opened yet, so this side also offers the exchange on the WebSocket relay",
    ],
    [
      "debug",
      "WebRTC failed: channel did not open; the exchange can still start on the WebSocket relay",
    ],
    [
      "debug",
      "the exchange partner left the WebSocket relay at <wss://a.test/relay> and started on the one at <wss://b.test/relay>, so this side starts there",
    ],
    [
      "info",
      "the exchange runs over the WebSocket relay at <wss://b.test/relay>",
    ],
  ]);
});

test("the partner's start sending this side's start is logged as abandoning WebRTC, and a channel that carries the exchange as WebRTC", async () => {
  const [a] = relays("a");
  a.pair();
  const relayRun = race("inviter", [a]);
  a.partnerStarts();
  await relayRun.outcome;
  expect(relayRun.lines.filter(([level]) => level === "info")).toEqual([
    [
      "info",
      "the exchange partner started the exchange on the WebSocket relay, so this side starts it there and stops trying WebRTC",
    ],
    [
      "info",
      "the exchange runs over the WebSocket relay at <wss://a.test/relay>",
    ],
  ]);

  const webRtcRun = race("inviter", relays("b"));
  webRtcRun.webRtc.opens();
  await webRtcRun.outcome;
  expect(webRtcRun.lines).toEqual([
    ["info", "the exchange runs over the WebRTC connection"],
  ]);
});
