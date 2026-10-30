// A close() arriving while the rendezvous is publishing this party's hello,
// as the CLI's SIGINT and SIGTERM handlers call it, leaves nothing of this
// party's in the directory for the next run's entry scan to refuse
// (docs/spec/FILE_SYNC.md#phase-3----cleanup-and-close).

import { describe, expect, test } from "vitest";

import type { FileTransportClient } from "../../src/connection/fileSyncConnection";
import {
  LOCK_HELLO_BODY,
  helloName,
  joiningName,
  makeConnectedConn,
} from "../utils/fileSyncConnectionFixture";
import { makeMockClient } from "../utils/support";

const OWN_ID = "00000000-0000-4000-8000-000000000001";
const PEER_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const DIR = "/test";

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

// A transport that holds the one write `isHeld` names until released, and
// that models the process exiting once close() resolves: nothing issued after
// end() reaches the directory, while the held write, already sent, still lands.
function interruptibleClient(
  files: Map<string, Buffer>,
  isHeld: (op: "put" | "rename", destName: string) => boolean,
): {
  client: FileTransportClient;
  heldWriteReached: Promise<void>;
  release: () => void;
} {
  const { client } = makeMockClient({ files });
  let ended = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const heldWriteReached = new Promise<void>((resolve) => (reached = resolve));
  const refuseAfterExit = (): void => {
    if (ended) throw new Error("the process has exited");
  };
  return {
    heldWriteReached,
    release,
    client: {
      ...client,
      end: async () => {
        ended = true;
        await client.end();
      },
      list: async (dir) => {
        refuseAfterExit();
        return client.list(dir);
      },
      put: async (src, dest, options) => {
        refuseAfterExit();
        if (isHeld("put", baseName(dest))) {
          reached();
          await released;
        }
        await client.put(src, dest, options);
      },
      rename: async (from, to) => {
        refuseAfterExit();
        if (isHeld("rename", baseName(to))) {
          reached();
          await released;
        }
        await client.rename(from, to);
      },
      delete: async (path) => {
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
// release, and the directory's contents once both have settled.
async function interruptHeldWrite(
  files: Map<string, Buffer>,
  isHeld: (op: "put" | "rename", destName: string) => boolean,
  writeWithoutRenaming: boolean,
): Promise<{ closedBeforeRelease: boolean; left: string[] }> {
  const transport = interruptibleClient(files, isHeld);
  const conn = await makeConnectedConn(transport.client, {
    timeToLiveMs: 10_000,
    inactivityTimeoutMs: 10_000,
  });
  conn.id = OWN_ID;
  conn.options.writeWithoutRenaming = writeWithoutRenaming;

  const rendezvous = conn.synchronize().catch(() => {});
  await transport.heldWriteReached;
  let closed = false;
  const closing = conn.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closedBeforeRelease = closed;
  transport.release();
  await closing;
  await rendezvous;
  return { closedBeforeRelease, left: [...files.keys()].map(baseName).sort() };
}

describe.each([
  { mode: "temp-then-rename", writeWithoutRenaming: false },
  { mode: "write without renaming", writeWithoutRenaming: true },
])("an interrupted hello publish ($mode)", ({ writeWithoutRenaming }) => {
  const ownHello = helloName(OWN_ID);
  const peerHello = helloName(PEER_ID);
  const publishesOwnHello = (_op: string, destName: string): boolean =>
    destName === ownHello;

  test("close() waits for this party's hello to land, then sweeps it", async () => {
    const files = new Map<string, Buffer>();

    const outcome = await interruptHeldWrite(
      files,
      publishesOwnHello,
      writeWithoutRenaming,
    );

    expect(outcome.left).toEqual([]);
    expect(outcome.closedBeforeRelease).toBe(false);
  });

  test("the joiner's hello, landing after its peer hello's delete, is swept", async () => {
    const files = new Map<string, Buffer>([
      [`${DIR}/${peerHello}`, LOCK_HELLO_BODY],
    ]);

    const outcome = await interruptHeldWrite(
      files,
      publishesOwnHello,
      writeWithoutRenaming,
    );

    expect(outcome.left).toEqual([]);
    expect(outcome.closedBeforeRelease).toBe(false);
  });

  test("a close() during the joiner's sentinel write keeps the peer hello and sweeps the sentinel", async () => {
    const files = new Map<string, Buffer>([
      [`${DIR}/${peerHello}`, LOCK_HELLO_BODY],
    ]);

    const outcome = await interruptHeldWrite(
      files,
      (_op, destName) => destName === joiningName(OWN_ID),
      writeWithoutRenaming,
    );

    expect(outcome.left).toEqual([peerHello]);
    expect(outcome.closedBeforeRelease).toBe(false);
  });
});
