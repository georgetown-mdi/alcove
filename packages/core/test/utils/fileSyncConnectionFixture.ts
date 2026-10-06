// The connection builders the file-sync suites share: a FileSyncConnection
// driven against the in-memory transport in support.ts, and the
// readers that reach the connection state a test cannot see from outside.

import {
  FileSyncConnection,
  type FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import type { FileDropConnectionConfig } from "../../src/config/connection";
import { makeMockClient, type MockClientOptions } from "./support";

// The poll/ack/seq counters live on the connection's composed FileSyncMessageLoop;
// the white-box pokes that read or set them reach through it. conn.seq is a
// delegating getter/setter on the connection, so it is read and written directly;
// responsibleFiles/foreignFileSnapshot/abortController are connection-side.
export function messageLoopInternals(conn: FileSyncConnection): {
  pollerActive: boolean;
  lastSentFile?: string;
  recvSeq: number;
  lastAckedNNN: number;
} {
  return (
    conn as unknown as {
      messageLoop: {
        pollerActive: boolean;
        lastSentFile?: string;
        recvSeq: number;
        lastAckedNNN: number;
      };
    }
  ).messageLoop;
}

// Put a connection into the post-open state without running the handshake.
// Calls open() with a fake filedrop config so this.config is populated and
// the per-await budget and close()'s drain deadline read inactivityTimeoutMs
// from the config rather than falling back to its one-hour default.
export async function makeConnectedConn(
  client: FileTransportClient,
  opts?: Partial<{
    pollingFrequency: number;
    timeToLiveMs: number;
    inactivityTimeoutMs: number;
    joinerRecoveryMs: number;
  }>,
): Promise<FileSyncConnection> {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: opts?.pollingFrequency ?? 10,
    timeToLive: new Date(Date.now() + (opts?.timeToLiveMs ?? 5_000)),
    verbose: -1,
    ...(opts?.joinerRecoveryMs !== undefined
      ? { joinerRecoveryMs: opts.joinerRecoveryMs }
      : {}),
  });
  const fakeConfig: FileDropConnectionConfig = {
    channel: "filedrop",
    path: "/test",
    options: { inactivityTimeoutMs: opts?.inactivityTimeoutMs ?? 50 },
  };
  await conn.open(fakeConfig);
  return conn;
}

// Drives conn.start()'s poller until its first error, returning the
// collected errors so the caller makes its own assertions. settleMs, if
// given, is an extra wait before stopping, to let a wrong reschedule bump a
// counter. pollerActiveBeforeDriverStop, captured just before that stop,
// shows whether a terminal error already stopped the poller on its own.
// stopInHandler makes the handler call conn.stop() itself, for tests
// proving the handler halts the loop.
export async function driveUntilError(
  conn: FileSyncConnection,
  opts?: {
    settleMs?: number;
    timeoutMessage?: string;
    stopInHandler?: boolean;
  },
): Promise<{ errors: unknown[]; pollerActiveBeforeDriverStop: boolean }> {
  const errors: unknown[] = [];
  let pollerActiveBeforeDriverStop!: boolean;
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));
  conn.on("error", (err) => {
    errors.push(err);
    if (opts?.stopInHandler) conn.stop();
    notifyError();
  });
  conn.start();
  try {
    await Promise.race([
      errorArrived,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                opts?.timeoutMessage ?? "timed out waiting for poll error",
              ),
            ),
          2_000,
        ),
      ),
    ]);
    if (opts?.settleMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, opts.settleMs));
  } finally {
    pollerActiveBeforeDriverStop = messageLoopInternals(conn).pollerActive;
    conn.stop();
  }
  return { errors, pollerActiveBeforeDriverStop };
}

export const LOCK_HELLO_BODY = Buffer.from(
  JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
);

export function responsibleFilesOf(conn: FileSyncConnection): Set<string> {
  return (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
}

// Drives a poller until `signal` resolves or a safety timeout fires, then
// stops it. Shared race-free scaffolding for poll-loop tests in
// fileSyncConnection.test.ts, fileSyncSynchronize.test.ts, and
// fileSyncMessageLoop.test.ts.
export async function runPoller(
  conn: FileSyncConnection,
  signal: Promise<void>,
): Promise<void> {
  conn.start();
  await Promise.race([signal, new Promise<void>((r) => setTimeout(r, 2_000))]);
  conn.stop();
}

// Builds two FileSyncConnections sharing one in-memory directory, each
// already in the post-open connected state, for concurrent-rendezvous tests.
// The generous timeToLive means a stall would exceed the vitest timeout and
// fail the test, so a passing concurrent-mismatch test is itself proof the
// failure is at rendezvous, not the peer timeout.
//
// Determinism note: the mock client's list()/put() are synchronous
// (no await/delay), so the two parties interleave predictably and each sees
// the other's hello on its first poll; added mock latency would need fixing
// there, not in production.
export function makeRendezvousPair(
  idA: string,
  optsA: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  idB: string,
  optsB: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  setup?: {
    // Passed to makeMockClient so a pair can run against a throwing/no-op
    // transport or install a spy; the two conns share the resulting client and
    // its store, matching the single-directory two-party model.
    client?: MockClientOptions;
    timeToLiveMs?: number;
    pollingFrequency?: number;
  },
): {
  connA: FileSyncConnection;
  connB: FileSyncConnection;
  files: Map<string, Buffer>;
} {
  const { client, files } = makeMockClient(setup?.client);
  const make = (
    id: string,
    opts: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  ): FileSyncConnection => {
    const conn = new FileSyncConnection(client, {
      pollingFrequency: setup?.pollingFrequency ?? 5,
      timeToLive: new Date(Date.now() + (setup?.timeToLiveMs ?? 30_000)),
      verbose: -1,
      ...opts,
    });
    conn.id = id;
    conn.connected = true;
    conn.path = "/test";
    return conn;
  };
  return { connA: make(idA, optsA), connB: make(idB, optsB), files };
}

export function makeRetainConn(
  client: FileTransportClient,
  id: string,
  peerId: string,
): FileSyncConnection {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/shared";
  conn.peerId = peerId;
  return conn;
}
