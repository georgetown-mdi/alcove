// The two peer waits a file-sync connection keeps apart, on both channels that
// use it: peer_timeout_ms bounds the partner's arrival at the rendezvous, and
// inactivity_timeout_ms bounds each wait on a partner (or its server) once it
// is present. Each case sets the other budget to the seven-day ceiling, so a
// wait that read the wrong setting would outlast the test's clock.

import { afterEach, describe, expect, test, vi } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import { failureCauseOf } from "../../src/failureCause";
import { MAX_TIMEOUT_SECONDS } from "../../src/config/connection";
import {
  makeMockClient,
  messageLoopInternals,
} from "../utils/fileSyncConnectionFixture";

import type { FileTransportClient } from "../../src/connection/fileSyncConnection";
import type {
  FileDropConnectionConfig,
  SFTPConnectionConfig,
} from "../../src/config/connection";

const CEILING_MS = MAX_TIMEOUT_SECONDS * 1000;
const BOUND_MS = 60_000;
const DIRECTORY = "/test";

type PeerWaitOptions = { peerTimeoutMs: number; inactivityTimeoutMs: number };

const CHANNELS: Array<{
  channel: "sftp" | "filedrop";
  config: (
    options: PeerWaitOptions,
  ) => SFTPConnectionConfig | FileDropConnectionConfig;
}> = [
  {
    channel: "sftp",
    config: (options) => ({
      channel: "sftp",
      server: { host: "sftp.example.org", path: DIRECTORY },
      options: { ...options, pollIntervalMs: 1_000 },
    }),
  },
  {
    channel: "filedrop",
    config: (options) => ({
      channel: "filedrop",
      path: DIRECTORY,
      options: { ...options, pollIntervalMs: 1_000 },
    }),
  },
];

afterEach(() => {
  vi.useRealTimers();
});

/** Settles to the error a pending wait rejected with, or `undefined` while it
 * is still waiting. */
function track(wait: Promise<unknown>): () => unknown {
  let failure: unknown;
  wait.catch((err: unknown) => {
    failure = err ?? new Error("rejected with no reason");
  });
  return () => failure;
}

async function openConnection(
  client: FileTransportClient,
  config: SFTPConnectionConfig | FileDropConnectionConfig,
): Promise<FileSyncConnection> {
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open(config);
  return conn;
}

describe.each(CHANNELS)("on $channel", ({ config }) => {
  test("an absent partner fails at peer_timeout_ms while the silence budget is long", async () => {
    vi.useFakeTimers();
    const { client } = makeMockClient();
    const conn = await openConnection(
      client,
      config({ peerTimeoutMs: BOUND_MS, inactivityTimeoutMs: CEILING_MS }),
    );
    const failure = track(conn.synchronize());

    await vi.advanceTimersByTimeAsync(BOUND_MS - 2_000);
    expect(failure()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(String(failure())).toMatch(
      /Your partner did not arrive in the shared folder.* within 1 minute\./,
    );
    await conn.close();
  });

  test("a present partner going silent fails at inactivity_timeout_ms while the arrival wait is long", async () => {
    vi.useFakeTimers();
    const { client, files } = makeMockClient();
    const conn = await openConnection(
      client,
      config({ peerTimeoutMs: CEILING_MS, inactivityTimeoutMs: BOUND_MS }),
    );
    // The state a completed rendezvous leaves: a partner, and a message this
    // side sent that the partner never consumes.
    conn.peerId = "stub-peer";
    const sentName = `${conn.id}-99.json`;
    files.set(`${DIRECTORY}/${sentName}`, Buffer.from("{}"));
    messageLoopInternals(conn).lastSentFile = sentName;
    const failure = track(conn.send({ next: true }));

    await vi.advanceTimersByTimeAsync(BOUND_MS - 2_000);
    expect(failure()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(String(failure())).toMatch(/timed out/);
    files.delete(`${DIRECTORY}/${sentName}`);
    await conn.close();
  });

  test("a transport operation left unanswered fails at inactivity_timeout_ms while the arrival wait is long", async () => {
    vi.useFakeTimers();
    const { client } = makeMockClient();
    const conn = await openConnection(
      client,
      config({ peerTimeoutMs: CEILING_MS, inactivityTimeoutMs: BOUND_MS }),
    );
    conn.peerId = "stub-peer";
    client.put = () => new Promise<void>(() => {});
    const failure = track(conn.send({ first: true }));

    await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
    expect(failure()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(String(failure())).toContain(`${BOUND_MS} ms peer-inactivity`);
  });
});

describe("each timeout failure ends with the guidance the caller supplied", () => {
  const INACTIVITY_TIMEOUT_GUIDANCE =
    "inactivity_timeout_ms sets the inactivity wait";

  async function openGuided(
    client: FileTransportClient,
    options: PeerWaitOptions & {
      locklessRendezvous?: boolean;
      retainFiles?: boolean;
      timestampInFilename?: boolean;
    },
  ): Promise<FileSyncConnection> {
    const conn = new FileSyncConnection(client, {
      verbose: -1,
      inactivityTimeoutGuidance: INACTIVITY_TIMEOUT_GUIDANCE,
    });
    await conn.open({
      channel: "filedrop",
      path: DIRECTORY,
      options: { ...options, pollIntervalMs: 1_000 },
    });
    return conn;
  }

  async function arrivalFailure(locklessRendezvous: boolean): Promise<unknown> {
    vi.useFakeTimers();
    const { client } = makeMockClient();
    const conn = await openGuided(client, {
      peerTimeoutMs: BOUND_MS,
      inactivityTimeoutMs: CEILING_MS,
      locklessRendezvous,
    });
    const failure = track(conn.synchronize());
    await vi.advanceTimersByTimeAsync(BOUND_MS + 2_000);
    await conn.close();
    return failure();
  }

  test.each([
    ["lock", false],
    ["lockless", true],
  ])(
    "an arrival timeout on the %s rendezvous is the partner-never-arrived sentence alone",
    async (_, lockless) => {
      const err = await arrivalFailure(lockless);
      expect(failureCauseOf(err)).toEqual({
        kind: "partner-never-arrived",
        channel: "filedrop",
        waitedMs: BOUND_MS,
      });
      expect((err as Error).message).toBe(
        "Your partner did not arrive in the shared folder within 1 minute.",
      );
    },
  );

  test("a transport operation timeout names inactivity_timeout_ms", async () => {
    vi.useFakeTimers();
    const { client } = makeMockClient();
    const conn = await openGuided(client, {
      peerTimeoutMs: CEILING_MS,
      inactivityTimeoutMs: BOUND_MS,
    });
    conn.peerId = "stub-peer";
    client.put = () => new Promise<void>(() => {});
    const failure = track(conn.send({ first: true }));
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    expect(String(failure())).toContain(
      `waiting on it further. ${INACTIVITY_TIMEOUT_GUIDANCE}`,
    );
  });

  test("a wait for the partner to consume a message names inactivity_timeout_ms", async () => {
    vi.useFakeTimers();
    const { client, files } = makeMockClient();
    const conn = await openGuided(client, {
      peerTimeoutMs: CEILING_MS,
      inactivityTimeoutMs: BOUND_MS,
    });
    conn.peerId = "stub-peer";
    const sentName = `${conn.id}-99.json`;
    files.set(`${DIRECTORY}/${sentName}`, Buffer.from("{}"));
    messageLoopInternals(conn).lastSentFile = sentName;
    const failure = track(conn.send({ next: true }));
    await vi.advanceTimersByTimeAsync(BOUND_MS + 2_000);
    expect(String(failure())).toContain(
      `to be consumed. ${INACTIVITY_TIMEOUT_GUIDANCE}`,
    );
    files.delete(`${DIRECTORY}/${sentName}`);
    await conn.close();
  });

  test("a wait for the partner's acknowledgement names inactivity_timeout_ms", async () => {
    vi.useFakeTimers();
    const { client } = makeMockClient();
    const conn = await openGuided(client, {
      peerTimeoutMs: CEILING_MS,
      inactivityTimeoutMs: BOUND_MS,
      retainFiles: true,
      timestampInFilename: true,
      locklessRendezvous: true,
    });
    conn.peerId = "stub-peer";
    const loop = messageLoopInternals(conn) as { seq?: number };
    loop.seq = 1;
    messageLoopInternals(conn).lastSentFile = `${conn.id}-000.json`;
    const failure = track(conn.send({ next: true }));
    await vi.advanceTimersByTimeAsync(BOUND_MS + 2_000);
    expect(String(failure())).toMatch(
      new RegExp(
        `timed out waiting for ack .*\\. ${INACTIVITY_TIMEOUT_GUIDANCE}$`,
      ),
    );
    await conn.close();
  });
});
