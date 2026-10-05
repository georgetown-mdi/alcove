// Which outcome one connection-per-poll idle release records when the
// conditions of several hold at once: the order docs/spec/FILE_SYNC.md,
// "Session lifetime across an idle boundary", states for its outcome table.
// Each case stages a set of conditions on a stand-in client, drives one
// releaseForIdle(), and reads which single boundary counter moved.

import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import type { IdleBoundaryOutcome } from "../../../src/connection/sftpAdapterLedger";
import { captureAdapterLog, installClient } from "./ssh2SftpAdapterFixtures";

// The adapter's acquire, client-close and forced-close bounds summed, with a
// margin: advancing past it settles every release a case can stage. The bounds
// are not exported by design (see ssh2SftpAdapterTransitions.test.ts).
const EVERY_RELEASE_BOUND_MS = 10_000 + 5_000 + 1_000 + 1_000;

interface Staging {
  // A dial that never settles holds the transition queue ahead of the release.
  waitExpires?: boolean;
  // end() has latched the connection's terminal close.
  teardownLatched?: boolean;
  // An operation this side issued is still unanswered.
  operationOutstanding?: boolean;
  // No session at the boundary: the partner cleared it unobserved
  // (generation still live), or an earlier release took it (generation ended).
  sessionGone?: "generationLive" | "generationEnded";
  // The socket's half-close flags at the boundary.
  peerFinConsumed?: boolean;
  writeHalfEnded?: boolean;
  // What the ssh2 Client's end() does: closes and clears the session, only
  // ends the write half (a server withholding its close), or nothing at all.
  endDoes?: "close" | "endWriteHalf" | "nothing";
  // Whether destroying the socket clears the session.
  destroyClears?: boolean;
}

function stagedClient(staging: Staging) {
  const state = { live: true };
  const wrapper = Object.assign(new EventEmitter(), {
    open: vi.fn(),
    close: vi.fn(),
    opendir: vi.fn(),
    readdir: vi.fn(),
  });
  const rawClient = new EventEmitter() as EventEmitter &
    Record<string, unknown>;
  const socket = {
    setKeepAlive: vi.fn(),
    readableEnded: false,
    writableEnded: false,
    destroyed: false,
    destroy: vi.fn(() => {
      socket.destroyed = true;
      if (staging.destroyClears === false) return;
      state.live = false;
      rawClient.emit("close");
    }),
  };
  Object.assign(rawClient, {
    setNoDelay: vi.fn(),
    _sock: socket,
    end: vi.fn(() => {
      const endDoes = staging.endDoes ?? "close";
      if (endDoes === "nothing") return;
      socket.writableEnded = true;
      if (endDoes === "endWriteHalf") return;
      state.live = false;
      rawClient.emit("close");
    }),
  });
  const connect = vi.fn().mockImplementation(async () => {
    socket.readableEnded = false;
    socket.writableEnded = false;
    socket.destroyed = false;
    state.live = true;
  });
  const client = {
    get sftp() {
      return state.live ? wrapper : null;
    },
    connect,
    client: rawClient,
    end: vi.fn().mockResolvedValue(true),
    realPath: vi.fn().mockResolvedValue("/"),
    // Never answered, so an operation issued through it stays outstanding.
    exists: vi.fn(() => new Promise<boolean>(() => {})),
  };
  return { client, connect, state, socket, rawClient };
}

// Stage `staging`, drive one release, and return the one outcome it recorded.
async function outcomeOf(staging: Staging): Promise<IdleBoundaryOutcome> {
  vi.useFakeTimers();
  try {
    const { client, connect, state, socket } = stagedClient(staging);
    const adapter = new SSH2SFTPClientAdapter({ ephemeralSessions: true });
    captureAdapterLog(adapter);
    installClient(adapter, client);
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });

    if (staging.operationOutstanding)
      void adapter.exists("/remote/out.json").catch(() => {});
    if (staging.sessionGone === "generationEnded") {
      await adapter.releaseForIdle();
    } else if (staging.sessionGone === "generationLive") {
      state.live = false;
    }
    socket.readableEnded = staging.peerFinConsumed === true;
    socket.writableEnded = staging.writeHalfEnded === true;
    if (staging.waitExpires) {
      // The holder needs no session to dial over; a declined release reads none.
      connect.mockImplementation(() => new Promise<void>(() => {}));
      state.live = false;
      void adapter.ensureConnected().catch(() => {});
    }

    if (staging.teardownLatched)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).session.beginClose();

    const before = adapter.sessionAccounting.boundaries;
    const release = adapter.releaseForIdle().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(EVERY_RELEASE_BOUND_MS);
    await release;
    const after = adapter.sessionAccounting.boundaries;

    const moved = (Object.keys(after) as IdleBoundaryOutcome[]).filter(
      (outcome) => after[outcome] !== before[outcome],
    );
    expect(moved).toHaveLength(1);
    const [outcome] = moved as [IdleBoundaryOutcome];
    expect(after[outcome] - before[outcome]).toBe(1);
    return outcome;
  } finally {
    vi.useRealTimers();
  }
}

describe("each idle-boundary outcome is reachable on its own", () => {
  test.each<[IdleBoundaryOutcome, Staging]>([
    ["declined", { waitExpires: true }],
    ["skipped", { teardownLatched: true }],
    ["held", { operationOutstanding: true }],
    ["alreadyEnded", { sessionGone: "generationEnded" }],
    ["noSession", { sessionGone: "generationLive" }],
    ["closedByPeer", { peerFinConsumed: true }],
    ["releasedOverEndedTransport", { writeHalfEnded: true }],
    ["released", {}],
    ["didNotClose", { endDoes: "nothing" }],
    ["destroyDidNotClear", { endDoes: "endWriteHalf", destroyClears: false }],
    ["forced", { endDoes: "endWriteHalf" }],
  ])("%s", async (outcome, staging) => {
    await expect(outcomeOf(staging)).resolves.toBe(outcome);
  });
});

// Where the conditions of several rows hold at once, the row earlier in the
// spec's table is the one recorded.
describe("an earlier row's condition preempts every later one", () => {
  test.each<[IdleBoundaryOutcome, string, Staging]>([
    [
      "declined",
      "teardown latched, an operation outstanding, no session",
      {
        waitExpires: true,
        teardownLatched: true,
        operationOutstanding: true,
        sessionGone: "generationLive",
      },
    ],
    [
      "skipped",
      "an operation outstanding, no session",
      {
        teardownLatched: true,
        operationOutstanding: true,
        sessionGone: "generationLive",
      },
    ],
    [
      "held",
      "no session",
      { operationOutstanding: true, sessionGone: "generationLive" },
    ],
    [
      "held",
      "the peer's FIN consumed, the write half ended",
      {
        operationOutstanding: true,
        peerFinConsumed: true,
        writeHalfEnded: true,
      },
    ],
    [
      "alreadyEnded",
      "the peer's FIN consumed",
      { sessionGone: "generationEnded", peerFinConsumed: true },
    ],
    [
      "noSession",
      "the peer's FIN consumed, the write half ended",
      {
        sessionGone: "generationLive",
        peerFinConsumed: true,
        writeHalfEnded: true,
      },
    ],
    [
      "closedByPeer",
      "the write half ended",
      { peerFinConsumed: true, writeHalfEnded: true },
    ],
    [
      "didNotClose",
      "the peer's FIN consumed, as a session that never cleared",
      { peerFinConsumed: true, endDoes: "nothing" },
    ],
    [
      "destroyDidNotClear",
      "the peer's FIN consumed, as a session that never cleared",
      { peerFinConsumed: true, endDoes: "endWriteHalf", destroyClears: false },
    ],
    [
      "forced",
      "the peer's FIN consumed, cleared only by this side's destroy",
      { peerFinConsumed: true, endDoes: "endWriteHalf" },
    ],
    [
      "forced",
      "the write half ended, cleared only by this side's destroy",
      { writeHalfEnded: true, endDoes: "endWriteHalf" },
    ],
  ])("%s over %s", async (outcome, _over, staging) => {
    await expect(outcomeOf(staging)).resolves.toBe(outcome);
  });
});
