import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  ConnectionError,
  getDiagnosticSink,
  getLogger,
  raceWebRtcAgainstRelays,
  setDiagnosticSink,
} from "@alcove/core";

import {
  PartnerNoShowError,
  waitForIncomingConnection,
} from "@psi/transport/waitForConnection";
import {
  WEB_RELAY_FALLBACK,
  openRunConnectionWithRelayFallback,
} from "@psi/transport/relayFallback";

import type {
  MessageConnection,
  ParkedRelay,
  RendezvousRole,
  WebRtcPathFailure,
} from "@alcove/core";
import type Peer from "peerjs";
import type { RunConnection } from "@psi/transport/runConnection";
import type { WebRtcPathHooks } from "@psi/transport/relayFallback";

// The web app's side of core's fallback race -- what it resolves with, which
// failure stays fatal, what it closes and releases, and how it logs -- and the
// run's open around it. The race itself is held in
// packages/core/test/connection/relayFallback.test.ts.

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
 * A parked relay as made: its start opens at once where the partner is
 * paired and started on it, and waits otherwise until it fails.
 */
class FakeRelay implements ParkedRelay {
  failure: ConnectionError | undefined;
  closeCalls = 0;
  readonly connection = fakeConnection();
  private readonly listeners = new Set<() => void>();
  private rejectStart: ((error: unknown) => void) | undefined;

  constructor(
    readonly url: string,
    readonly paired = false,
    readonly partnerStarted = false,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<MessageConnection> {
    if (this.paired && this.partnerStarted)
      return Promise.resolve(this.connection);
    return new Promise((_resolve, reject) => {
      this.rejectStart = reject;
    });
  }

  close(): void {
    this.closeCalls += 1;
  }

  fail(message: string): void {
    this.failure = new ConnectionError(message, "transport");
    this.rejectStart?.(this.failure);
    for (const listener of [...this.listeners]) listener();
  }
}

/** A WebRTC path the test drives, rejecting on its signal as the real one does. */
function fakeWebRtc({ ignoresAbort = false } = {}) {
  let resolve!: (runConnection: RunConnection) => void;
  let reject!: (error: unknown) => void;
  let onPathFailed: ((failure: WebRtcPathFailure) => void) | undefined;
  const runConnection = { connection: fakeConnection(), release: vi.fn() };
  const open = (hooks: Required<WebRtcPathHooks>): Promise<RunConnection> =>
    new Promise((res, rej) => {
      onPathFailed = hooks.onPathFailed;
      resolve = res;
      reject = rej;
      if (ignoresAbort) return;
      hooks.signal.addEventListener("abort", () =>
        rej(new Error("opening the connection was aborted")),
      );
    });
  return {
    open,
    runConnection,
    pathFails: () => onPathFailed?.("channel-not-opened"),
    opens: () => resolve(runConnection),
    fails: (error: unknown) => reject(error),
  };
}

function race(
  role: RendezvousRole,
  relays: Array<FakeRelay>,
  webRtc = fakeWebRtc(),
) {
  const outcome = raceWebRtcAgainstRelays(
    { role, relays, openWebRtc: webRtc.open },
    WEB_RELAY_FALLBACK,
  );
  outcome.catch(() => {});
  return { outcome, webRtc };
}

/** Let promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a relay that carries the exchange resolves with its connection and nothing to release", async () => {
  const relay = new FakeRelay("wss://a.test/relay", true, true);
  const { outcome } = race("inviter", [relay]);
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: relay.url });
  expect(result.connection.connection).toBe(relay.connection);
  expect(() => result.connection.release()).not.toThrow();
});

test("a channel that opens first resolves with the run connection it opened", async () => {
  const relay = new FakeRelay("wss://a.test/relay", true);
  const { outcome, webRtc } = race("inviter", [relay]);
  webRtc.opens();
  const result = await outcome;
  expect(result.path).toEqual({ kind: "webrtc" });
  expect(result.connection).toBe(webRtc.runConnection);
});

test("a security failure stays fatal after a path failure", async () => {
  const relay = new FakeRelay("wss://a.test/relay", true);
  const { outcome, webRtc } = race("acceptor", [relay]);
  webRtc.pathFails();
  await settle();
  const refusal = new ConnectionError("endpoint refused", "security");
  webRtc.fails(refusal);
  await expect(outcome).rejects.toBe(refusal);
  expect(relay.closeCalls).toBe(1);
});

test("both paths failing together fail with the WebRTC failure and log each relay's refusal", async () => {
  const a = new FakeRelay("wss://a.test/relay");
  const b = new FakeRelay("wss://b.test/relay", true);
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

test("a relay is logged by its origin, and the WebRTC failure without its text", async () => {
  const log = getLogger("relayFallback");
  const priorLevel = log.getLevel();
  log.setLevel("debug", false);
  try {
    const relay = new FakeRelay("wss://a.test/relay?token=private");
    const { outcome, webRtc } = race("inviter", [relay]);
    webRtc.pathFails();
    webRtc.fails(new ConnectionError("private detail", "transport"));
    await settle();
    relay.fail("refused");
    await expect(outcome).rejects.toMatchObject({ kind: "transport" });
    expect(logLines).toContain(
      "the WebSocket relay at wss://a.test ended before the exchange started on it",
    );
    expect(logLines).toContain(
      "the WebRTC connection did not open; the exchange can still start on the WebSocket relay",
    );
    expect(logLines.some((line) => line.includes("private"))).toBe(false);
  } finally {
    log.setLevel(priorLevel, false);
  }
});

test("a channel that opens after the relay carried the exchange is closed and released", async () => {
  const relay = new FakeRelay("wss://a.test/relay", true, true);
  const { outcome, webRtc } = race(
    "inviter",
    [relay],
    fakeWebRtc({ ignoresAbort: true }),
  );
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

/** Long enough that a run still waiting for its partner shows as waiting. */
const PARTNER_WAIT_MS = 60_000;

/**
 * The inviter's WebRTC open up to its wait for the partner's connection, on a
 * PeerJS peer the test drives.
 */
function inviterWaitingOn(peer: EventEmitter) {
  return async ({ signal, onPathFailed }: WebRtcPathHooks) => {
    await waitForIncomingConnection(peer as unknown as Peer, {
      signal,
      timeoutMs: PARTNER_WAIT_MS,
      ...(onPathFailed !== undefined && { onPathFailed }),
    });
    return { connection: fakeConnection(), release: () => {} };
  };
}

/** What PeerJS emits as its socket to the coordination server drops. */
function dropCoordinationServer(peer: EventEmitter): Error {
  const lost = Object.assign(new Error("Lost connection to server."), {
    type: "network",
  });
  peer.emit("error", lost);
  peer.emit("disconnected", "inviter-id");
  return lost;
}

/** `promise`'s rejection, or "still waiting" if it has not settled within `ms`. */
function rejectionWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<unknown> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), ms)),
  ]);
}

test("with every listed relay failed, losing the coordination server during the inviter's wait fails the open with that failure, not as a no-show", async () => {
  const record = { sent: [] as Array<unknown>, closes: [] as Array<number> };
  const peer = new EventEmitter();
  const opening = openRunConnectionWithRelayFallback(
    {
      role: "inviter",
      sharedSecret: SHARED_SECRET,
      relays: [{ url: "wss://relay.test/relay", exchangeId: "exchange" }],
      signal: new AbortController().signal,
      onCloseOutcome: () => {},
      openWebRtc: inviterWaitingOn(peer),
    },
    { createSocket: () => idleSocket(record), pairingTimeoutMs: 20 },
  );
  opening.catch(() => {});
  await vi.waitFor(() => expect(peer.listenerCount("disconnected")).toBe(1));
  const lost = dropCoordinationServer(peer);

  const failure = await rejectionWithin(opening, 5_000);
  expect(failure).toBe(lost);
  expect(failure).not.toBeInstanceOf(PartnerNoShowError);
});

test("with no relay listed, losing the coordination server during the inviter's wait fails the open at once with that failure", async () => {
  const peer = new EventEmitter();
  const opening = openRunConnectionWithRelayFallback({
    role: "inviter",
    sharedSecret: SHARED_SECRET,
    relays: [],
    signal: new AbortController().signal,
    onCloseOutcome: () => {},
    openWebRtc: inviterWaitingOn(peer),
  });
  opening.catch(() => {});
  await vi.waitFor(() => expect(peer.listenerCount("disconnected")).toBe(1));
  const lost = dropCoordinationServer(peer);

  expect(await rejectionWithin(opening, 1_000)).toBe(lost);
});
