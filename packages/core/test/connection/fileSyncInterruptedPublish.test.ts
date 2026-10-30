// A close() arriving while the rendezvous is publishing one of this party's
// files, as the CLI's SIGINT and SIGTERM handlers call it, leaves nothing of
// this party's in the directory for the next run's entry scan to refuse
// (docs/spec/FILE_SYNC.md#phase-3----cleanup-and-close).

import { describe, expect, test } from "vitest";

import type { FileTransportClient } from "../../src/connection/fileSyncConnection";
import { ackMarkerName, LOCK_SUFFIX } from "../../src/connection/fileSyncNames";
import {
  LOCK_HELLO_BODY,
  helloBodyFor,
  helloName,
  joiningName,
  makeConnectedConn,
} from "../utils/fileSyncConnectionFixture";
import { makeMockClient } from "../utils/support";

const OWN_ID = "00000000-0000-4000-8000-000000000001";
const PEER_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const DIR = "/test";

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

type HeldOp = "put" | "rename" | "createExclusive";

interface Mode {
  writeWithoutRenaming: boolean;
  locklessRendezvous?: boolean;
}

// A transport that holds the one write `isHeld` names until released, and
// that models the process exiting once close() resolves: nothing issued after
// end() reaches the directory, while the held write, already sent, still lands.
// `started` records every operation as it starts, safeDelete aside, so a test
// can see what the rendezvous issued after the held write returned.
function interruptibleClient(
  files: Map<string, Buffer>,
  isHeld: (op: HeldOp, destName: string) => boolean,
  hideAtEntry: string[],
): {
  client: FileTransportClient;
  heldWriteReached: Promise<void>;
  release: () => void;
  started: string[];
} {
  const { client } = makeMockClient({ files, hideAtEntry });
  let ended = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const heldWriteReached = new Promise<void>((resolve) => (reached = resolve));
  const started: string[] = [];
  const refuseAfterExit = (): void => {
    if (ended) throw new Error("the process has exited");
  };
  const holdIfNamed = async (op: HeldOp, dest: string): Promise<void> => {
    if (isHeld(op, baseName(dest))) {
      reached();
      await released;
    }
  };
  return {
    heldWriteReached,
    release,
    started,
    client: {
      ...client,
      end: async () => {
        ended = true;
        await client.end();
      },
      list: async (dir) => {
        started.push("list");
        refuseAfterExit();
        return client.list(dir);
      },
      get: async (path, options) => {
        started.push(`get:${baseName(path)}`);
        refuseAfterExit();
        return client.get(path, options);
      },
      put: async (src, dest, options) => {
        started.push(`put:${baseName(dest)}`);
        refuseAfterExit();
        await holdIfNamed("put", dest);
        await client.put(src, dest, options);
      },
      rename: async (from, to) => {
        started.push(`rename:${baseName(to)}`);
        refuseAfterExit();
        await holdIfNamed("rename", to);
        await client.rename(from, to);
      },
      createExclusive: async (path) => {
        started.push(`createExclusive:${baseName(path)}`);
        refuseAfterExit();
        await holdIfNamed("createExclusive", path);
        await client.createExclusive(path);
      },
      exists: async (path) => {
        started.push(`exists:${baseName(path)}`);
        refuseAfterExit();
        return client.exists(path);
      },
      delete: async (path) => {
        started.push(`delete:${baseName(path)}`);
        refuseAfterExit();
        await client.delete(path);
      },
      safeDelete: async (path) => {
        if (!ended) await client.safeDelete(path);
      },
    },
  };
}

// Starts the rendezvous, closes the connection once the held write is in
// flight, and releases that write only after close() has had time to run to
// the end without waiting for it. Returns whether close() resolved before the
// release, the operations the rendezvous started after the release, and the
// directory's contents once both have settled.
async function interruptHeldWrite(
  files: Map<string, Buffer>,
  isHeld: (op: HeldOp, destName: string) => boolean,
  mode: Mode,
  hideAtEntry: string[] = [],
): Promise<{
  closedBeforeRelease: boolean;
  startedAfterRelease: string[];
  left: string[];
}> {
  const transport = interruptibleClient(files, isHeld, hideAtEntry);
  const conn = await makeConnectedConn(transport.client, {
    timeToLiveMs: 10_000,
    inactivityTimeoutMs: 10_000,
  });
  conn.id = OWN_ID;
  conn.options.writeWithoutRenaming = mode.writeWithoutRenaming;
  conn.options.locklessRendezvous = mode.locklessRendezvous ?? false;

  const rendezvous = conn.synchronize().catch(() => {});
  await transport.heldWriteReached;
  let closed = false;
  const closing = conn.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closedBeforeRelease = closed;
  const startedBeforeRelease = transport.started.length;
  transport.release();
  await closing;
  await rendezvous;
  return {
    closedBeforeRelease,
    startedAfterRelease: transport.started.slice(startedBeforeRelease),
    left: [...files.keys()].map(baseName).sort(),
  };
}

// Whether the next run, in the same mode, gets past its entry scan of what an
// interrupted run left: the entry guard refuses before any write, so a write
// shows it accepted the directory.
async function nextRunPassesEntryScan(
  files: Map<string, Buffer>,
  mode: Mode,
): Promise<boolean> {
  const ops: string[] = [];
  const { client } = makeMockClient({ files: new Map(files), ops });
  const conn = await makeConnectedConn(client, {
    timeToLiveMs: 200,
    inactivityTimeoutMs: 10_000,
  });
  conn.id = OWN_ID;
  conn.options.writeWithoutRenaming = mode.writeWithoutRenaming;
  conn.options.locklessRendezvous = mode.locklessRendezvous ?? false;
  await conn.synchronize().catch(() => {});
  await conn.close();
  return ops.some((op) => op.startsWith("put-start:"));
}

describe.each([
  { mode: "temp-then-rename", writeWithoutRenaming: false },
  { mode: "write without renaming", writeWithoutRenaming: true },
])("an interrupted publish ($mode)", ({ writeWithoutRenaming }) => {
  const lockMode: Mode = { writeWithoutRenaming };
  const locklessMode: Mode = { writeWithoutRenaming, locklessRendezvous: true };
  const ownHello = helloName(OWN_ID);
  const peerHello = helloName(PEER_ID);
  const publishesOwnHello = (_op: string, destName: string): boolean =>
    destName === ownHello;

  test("close() waits for this party's hello to land, then sweeps it", async () => {
    const files = new Map<string, Buffer>();

    const outcome = await interruptHeldWrite(
      files,
      publishesOwnHello,
      lockMode,
    );

    expect(outcome.left).toEqual([]);
    expect(outcome.closedBeforeRelease).toBe(false);
    expect(outcome.startedAfterRelease).toEqual([]);
    expect(await nextRunPassesEntryScan(files, lockMode)).toBe(true);
  });

  test("the joiner's hello, landing after its peer hello's delete, is swept", async () => {
    const files = new Map<string, Buffer>([
      [`${DIR}/${peerHello}`, LOCK_HELLO_BODY],
    ]);

    const outcome = await interruptHeldWrite(
      files,
      publishesOwnHello,
      lockMode,
    );

    expect(outcome.left).toEqual([]);
    expect(outcome.closedBeforeRelease).toBe(false);
    // Written without renaming, the hello is followed by the sentinel's
    // delete, the last step from the peer hello's delete to this party's hello.
    expect(outcome.startedAfterRelease).toEqual(
      writeWithoutRenaming ? [`delete:${joiningName(OWN_ID)}`] : [],
    );
    expect(await nextRunPassesEntryScan(files, lockMode)).toBe(true);
  });

  test("a close() during the joiner's sentinel write keeps the peer hello and sweeps the sentinel", async () => {
    const files = new Map<string, Buffer>([
      [`${DIR}/${peerHello}`, LOCK_HELLO_BODY],
    ]);

    const outcome = await interruptHeldWrite(
      files,
      (_op, destName) => destName === joiningName(OWN_ID),
      lockMode,
    );

    expect(outcome.left).toEqual([peerHello]);
    expect(outcome.closedBeforeRelease).toBe(false);
    expect(outcome.startedAfterRelease).toEqual([]);
    expect(await nextRunPassesEntryScan(files, lockMode)).toBe(true);
  });

  test("a close() during the lockless ack write sweeps the ack and this party's hello", async () => {
    const locklessBody = helloBodyFor({
      locklessRendezvous: true,
      retainFiles: false,
    });
    const peerLocklessHello = helloName(PEER_ID, locklessBody);
    const ackName = ackMarkerName(
      OWN_ID,
      peerLocklessHello.slice(0, -".json".length),
    );
    const files = new Map<string, Buffer>([
      [`${DIR}/${peerLocklessHello}`, locklessBody],
    ]);

    const outcome = await interruptHeldWrite(
      files,
      (_op, destName) => destName === ackName,
      locklessMode,
    );

    expect(outcome.left).toEqual([peerLocklessHello]);
    expect(outcome.closedBeforeRelease).toBe(false);
    expect(outcome.startedAfterRelease).toEqual([]);
    expect(await nextRunPassesEntryScan(files, locklessMode)).toBe(true);
  });

  test("a close() during the lock's exclusive create sweeps the lock and this party's hello", async () => {
    const lockName = `${OWN_ID}-${PEER_ID}${LOCK_SUFFIX}`;
    const files = new Map<string, Buffer>([
      [`${DIR}/${peerHello}`, LOCK_HELLO_BODY],
    ]);

    // The peer hello is hidden from the entry scan, so this party takes the
    // hello exchange and races the lock rather than joining.
    const outcome = await interruptHeldWrite(
      files,
      (op, destName) => op === "createExclusive" && destName === lockName,
      lockMode,
      [peerHello],
    );

    expect(outcome.left).toEqual([peerHello]);
    expect(outcome.closedBeforeRelease).toBe(false);
    expect(outcome.startedAfterRelease).toEqual([]);
    expect(await nextRunPassesEntryScan(files, lockMode)).toBe(true);
  });
});
