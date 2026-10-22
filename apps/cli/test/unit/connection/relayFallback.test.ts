import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import {
  AuthenticationError,
  ConnectionError,
  raceWebRtcAgainstRelays,
  redactAndSanitizeForDisplay,
  setDiagnosticSink,
  setLogLevel,
} from "@alcove/core";

import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";

import type {
  MessageConnection,
  ParkedRelay,
  RendezvousRole,
  WebRtcPathFailure,
} from "@alcove/core";

// The CLI's side of core's fallback race: what it resolves with, which
// failure stays fatal, what it closes and how it logs. The race itself is
// held in packages/core/test/connection/relayFallback.test.ts.

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

const { CLI_RELAY_FALLBACK, openWebRtcWithRelayFallback } =
  await import("../../../src/connection/webrtc/relayFallback");

snapshotDiagnosticSinkAndLevel();

afterEach(() => {
  webRtcDials.length = 0;
});

/** Capture every logged line at `level` and above. */
function captureLines(level: logLibrary.LogLevelNumbers): Array<string> {
  const lines: Array<string> = [];
  setDiagnosticSink((_method, _prefix, args) => {
    lines.push(args.map(String).join(" "));
  });
  setLogLevel(level);
  return lines;
}

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
  let resolve!: (connection: MessageConnection) => void;
  let reject!: (error: unknown) => void;
  let onPathFailed: ((failure: WebRtcPathFailure) => void) | undefined;
  const connection = fakeConnection();
  const open = (hooks: {
    signal: AbortSignal;
    onPathFailed: (failure: WebRtcPathFailure) => void;
  }): Promise<MessageConnection> =>
    new Promise((res, rej) => {
      onPathFailed = hooks.onPathFailed;
      resolve = res;
      reject = rej;
      if (ignoresAbort) return;
      hooks.signal.addEventListener("abort", () =>
        rej(
          new ConnectionError("the WebRTC rendezvous was cancelled", "closed"),
        ),
      );
    });
  return {
    open,
    connection,
    pathFails: () => onPathFailed?.("channel-not-opened"),
    opens: () => resolve(connection),
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
    CLI_RELAY_FALLBACK,
  );
  outcome.catch(() => {});
  return { outcome, webRtc };
}

/** Let promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a relay that carries the exchange resolves with its own connection", async () => {
  const relay = new FakeRelay("wss://a.test/relay", true, true);
  const { outcome } = race("inviter", [relay]);
  const result = await outcome;
  expect(result.path).toEqual({ kind: "websocket-relay", url: relay.url });
  expect(result.connection).toBe(relay.connection);
});

test("a signaling certificate that did not verify stays fatal after a path failure", async () => {
  const relay = new FakeRelay("wss://a.test/relay", true);
  const { outcome, webRtc } = race("acceptor", [relay]);
  webRtc.pathFails();
  await settle();
  const refusal = new AuthenticationError("certificate did not verify");
  webRtc.fails(refusal);
  await expect(outcome).rejects.toBe(refusal);
  expect(relay.closeCalls).toBe(1);
});

test("both budgets expiring together fail with the WebRTC failure and log each relay's refusal", async () => {
  const lines = captureLines(logLibrary.levels.INFO);
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
  expect(lines.some((line) => line.includes("relay a refused"))).toBe(true);
  expect(lines.some((line) => line.includes("relay b refused"))).toBe(true);
});

test("a relay's address and the WebRTC failure are logged escaped", async () => {
  const lines = captureLines(logLibrary.levels.DEBUG);
  const url = "wss://a.test/relay\u001b[2J";
  const relay = new FakeRelay(url);
  const { outcome, webRtc } = race("inviter", [relay]);
  webRtc.pathFails();
  webRtc.fails(new ConnectionError("no channel\u001b[2J", "transport"));
  await settle();
  relay.fail("refused");
  await expect(outcome).rejects.toMatchObject({ kind: "transport" });
  expect(
    lines.some((line) =>
      line.includes(
        `the WebSocket relay at ${redactAndSanitizeForDisplay(url)} ended`,
      ),
    ),
  ).toBe(true);
  expect(
    lines.some((line) =>
      line.includes("; the exchange can still start on the WebSocket relay"),
    ),
  ).toBe(true);
  expect(lines.some((line) => line.includes("\u001b"))).toBe(false);
});

test("a channel that opens after the relay carried the exchange is closed", async () => {
  const relay = new FakeRelay("wss://a.test/relay", true, true);
  const { outcome, webRtc } = race(
    "inviter",
    [relay],
    fakeWebRtc({ ignoresAbort: true }),
  );
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
