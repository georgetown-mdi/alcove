// Writing without renaming (docs/spec/FILE_SYNC.md, Writing without
// renaming): with the option on, every write site writes its final name
// directly, pre-tracks it in delete mode, and issues no rename; with it off,
// a rename the server refuses ends the run naming the option.

import { describe, expect, test } from "vitest";

import {
  FileSyncConnection,
  type FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import { DEFAULT_RENAME_REFUSED_GUIDANCE } from "../../src/connection/fileSyncPublish";
import { fromEventConnection } from "../../src/connection/messageConnection";
import {
  TransportOperationStalledError,
  TransportPublishIndeterminateError,
  causeChainSome,
  statesItsOwnNextStep,
} from "../../src/errors";
import { exchangePayloads } from "../../src/payloadExchange";
import { withCapturedLogs } from "../../src/testing";
import { makeMockClient } from "../utils/support";
import { responsibleFilesOf } from "../utils/fileSyncConnectionFixture";

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const DIR = "/test";

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

// One party's view of the shared in-memory directory, recording every write,
// rename and delete it issues by file name. `failPutTo` makes a put write its
// bytes and then reject, as a connection lost after the server created the
// file does. `holdDelete` parks a delete until the returned promise settles.
// `failDeleteOnce` makes the first delete of that name reject without deleting.
function recordingClient(
  files: Map<string, Buffer>,
  opts: {
    failPutTo?: (name: string) => boolean;
    holdDelete?: (name: string) => Promise<void> | undefined;
    failDeleteOnce?: string;
    renameError?: Error;
  } = {},
): {
  client: FileTransportClient;
  ops: string[];
  written: Map<string, Buffer>;
} {
  const { client } = makeMockClient({
    files,
    ...(opts.renameError !== undefined
      ? { renameError: opts.renameError }
      : {}),
  });
  const ops: string[] = [];
  const written = new Map<string, Buffer>();
  let deleteFailurePending = opts.failDeleteOnce !== undefined;
  return {
    ops,
    written,
    client: {
      ...client,
      put: async (src, dest, putOptions) => {
        ops.push(`put:${baseName(dest)}`);
        await client.put(src, dest, putOptions);
        written.set(baseName(dest), files.get(dest)!);
        if (opts.failPutTo?.(baseName(dest)))
          throw new Error("connection lost after the write began");
      },
      rename: async (from, to) => {
        ops.push(`rename:${baseName(from)}->${baseName(to)}`);
        return client.rename(from, to);
      },
      delete: async (p) => {
        ops.push(`delete:${baseName(p)}`);
        if (deleteFailurePending && baseName(p) === opts.failDeleteOnce) {
          deleteFailurePending = false;
          throw Object.assign(new Error("_delete: Permission denied"), {
            code: 3,
          });
        }
        await opts.holdDelete?.(baseName(p));
        return client.delete(p);
      },
      safeDelete: async (p) => {
        ops.push(`safeDelete:${baseName(p)}`);
        return client.safeDelete(p);
      },
    },
  };
}

type PartyOptions = Partial<
  ConstructorParameters<typeof FileSyncConnection>[1]
>;

function party(
  id: string,
  client: FileTransportClient,
  opts: PartyOptions,
): FileSyncConnection {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 10_000),
    verbose: -1,
    ...opts,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = DIR;
  return conn;
}

const RETAIN = {
  locklessRendezvous: true,
  retainFiles: true,
  timestampInFilename: true,
};

function nextData(conn: FileSyncConnection): Promise<unknown> {
  return new Promise((resolve) => conn.once("data", resolve));
}

// Runs one message each way, plus a second from A so a retain-mode sender
// waits on the receiver's ack, then closes both parties.
async function exchangeAndClose(
  a: FileSyncConnection,
  b: FileSyncConnection,
): Promise<void> {
  const bGotFirst = nextData(b);
  const aGot = nextData(a);
  a.start();
  b.start();
  await a.send({ from: "a", n: 1 });
  expect(await bGotFirst).toEqual({ from: "a", n: 1 });
  await b.send({ from: "b" });
  expect(await aGot).toEqual({ from: "b" });
  const bGotSecond = nextData(b);
  await a.send({ from: "a", n: 2 });
  expect(await bGotSecond).toEqual({ from: "a", n: 2 });
  await Promise.all([a.close(), b.close()]);
}

function expectNoRenameOrTemp(ops: string[]): void {
  expect(ops.filter((op) => op.startsWith("rename:"))).toEqual([]);
  expect(ops.filter((op) => op.includes("temp-"))).toEqual([]);
}

describe("both parties write without renaming", () => {
  test("lock path: the joiner writes its sentinel, deletes the peer hello, writes its hello, then deletes the sentinel", async () => {
    const files = new Map<string, Buffer>();
    const a = recordingClient(files);
    const b = recordingClient(files);
    const connA = party(ID_A, a.client, { writeWithoutRenaming: true });
    const connB = party(ID_B, b.client, { writeWithoutRenaming: true });

    const syncA = connA.synchronize();
    await expect.poll(() => files.has(`${DIR}/${ID_A}-hello.json`)).toBe(true);
    await Promise.all([syncA, connB.synchronize()]);

    expect(a.ops[0]).toBe(`put:${ID_A}-hello.json`);
    expect(b.ops.slice(0, 4)).toEqual([
      `put:${ID_B}-joining.json`,
      `delete:${ID_A}-hello.json`,
      `put:${ID_B}-hello.json`,
      `delete:${ID_B}-joining.json`,
    ]);

    await exchangeAndClose(connA, connB);
    expectNoRenameOrTemp([...a.ops, ...b.ops]);
    expect([...files.keys()]).toEqual([]);
  });

  test("lockless rendezvous: hellos, acks and messages are written to their final names", async () => {
    const files = new Map<string, Buffer>();
    const a = recordingClient(files);
    const b = recordingClient(files);
    const opts = { writeWithoutRenaming: true, locklessRendezvous: true };
    const connA = party(ID_A, a.client, opts);
    const connB = party(ID_B, b.client, opts);

    await Promise.all([connA.synchronize(), connB.synchronize()]);
    expect(a.ops).toContain(`put:${ID_A}-${ID_B}-hello-ack.json`);
    expect(b.ops).toContain(`put:${ID_B}-${ID_A}-hello-ack.json`);

    await exchangeAndClose(connA, connB);
    expectNoRenameOrTemp([...a.ops, ...b.ops]);
    expect([...files.keys()]).toEqual([]);
  });

  test("retain mode: messages and message acks are written to their final names and kept", async () => {
    const files = new Map<string, Buffer>();
    const a = recordingClient(files);
    const b = recordingClient(files);
    const opts = { writeWithoutRenaming: true, ...RETAIN };
    const connA = party(ID_A, a.client, opts);
    const connB = party(ID_B, b.client, opts);

    await Promise.all([connA.synchronize(), connB.synchronize()]);
    await exchangeAndClose(connA, connB);

    expectNoRenameOrTemp([...a.ops, ...b.ops]);
    const messageAcks = b.ops.filter(
      (op) => op.startsWith(`put:${ID_B}-${ID_A}-`) && op.endsWith("-ack.json"),
    );
    // The hello ack and one ack per message from A.
    expect(messageAcks.length).toBe(3);
    expect(responsibleFilesOf(connA).size).toBe(0);
    expect(files.size).toBeGreaterThan(0);
  });

  test("the abort marker is written to its final name", async () => {
    const files = new Map<string, Buffer>();
    const a = recordingClient(files);
    const conn = party(ID_A, a.client, { writeWithoutRenaming: true });
    conn.peerId = ID_B;
    conn.armAbort(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    await conn.writeAbortMarker();
    expect(a.ops).toEqual([`put:${ID_A}-abort.json`]);
    expect(files.has(`${DIR}/${ID_A}-abort.json`)).toBe(true);
  });
});

describe("a lock joiner writing without renaming, against a peer without the mode", () => {
  test("the peer completes rendezvous and runs its loop while the joiner's sentinel is still listed", async () => {
    const files = new Map<string, Buffer>();
    let releaseSentinelDelete!: () => void;
    const sentinelDeleteHeld = new Promise<void>(
      (resolve) => (releaseSentinelDelete = resolve),
    );
    const a = recordingClient(files);
    const b = recordingClient(files, {
      holdDelete: (name) =>
        name === `${ID_B}-joining.json` ? sentinelDeleteHeld : undefined,
    });
    const connA = party(ID_A, a.client, {});
    const connB = party(ID_B, b.client, { writeWithoutRenaming: true });
    const errorsA: unknown[] = [];
    connA.on("error", (err) => errorsA.push(err));

    const syncA = connA.synchronize();
    await expect.poll(() => files.has(`${DIR}/${ID_A}-hello.json`)).toBe(true);
    const syncB = connB.synchronize();

    // A sees B's hello beside B's sentinel, completes, and polls its loop
    // with the sentinel still present.
    await syncA;
    expect(connA.peerId).toBe(ID_B);
    expect(files.has(`${DIR}/${ID_B}-joining.json`)).toBe(true);
    connA.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(errorsA).toEqual([]);

    releaseSentinelDelete();
    await syncB;
    expect(connB.peerId).toBe(ID_A);
    expect(files.has(`${DIR}/${ID_B}-joining.json`)).toBe(false);

    const aGot = nextData(connA);
    const bGot = nextData(connB);
    connB.start();
    await connB.send({ from: "b" });
    expect(await aGot).toEqual({ from: "b" });
    await connA.send({ from: "a" });
    expect(await bGot).toEqual({ from: "a" });
    await Promise.all([connA.close(), connB.close()]);

    expectNoRenameOrTemp(b.ops);
    expect(a.ops.some((op) => op.startsWith("rename:"))).toBe(true);
    expect(errorsA).toEqual([]);
    expect([...files.keys()]).toEqual([]);
  });
});

test("a lock joiner whose sentinel delete fails after its hello is written completes, warns, and removes the sentinel at close", async () => {
  const files = new Map<string, Buffer>();
  const sentinel = `${ID_B}-joining.json`;
  const a = recordingClient(files);
  const b = recordingClient(files, { failDeleteOnce: sentinel });
  const errorsB: unknown[] = [];

  // The parties are built inside the capture so their loggers bind to it.
  const [, logs] = await withCapturedLogs(async () => {
    const connA = party(ID_A, a.client, {});
    const connB = party(ID_B, b.client, { writeWithoutRenaming: true });
    connB.on("error", (err) => errorsB.push(err));
    const syncA = connA.synchronize();
    await expect.poll(() => files.has(`${DIR}/${ID_A}-hello.json`)).toBe(true);
    await Promise.all([syncA, connB.synchronize()]);

    expect(connB.peerId).toBe(ID_A);
    expect(files.has(`${DIR}/${sentinel}`)).toBe(true);
    expect(responsibleFilesOf(connB).has(sentinel)).toBe(true);

    // B's loop lists its own lingering sentinel without reporting it.
    const aGot = nextData(connA);
    const bGot = nextData(connB);
    connA.start();
    connB.start();
    await connB.send({ from: "b" });
    expect(await aGot).toEqual({ from: "b" });
    await connA.send({ from: "a" });
    expect(await bGot).toEqual({ from: "a" });
    await Promise.all([connA.close(), connB.close()]);
  });

  expect(errorsB).toEqual([]);
  expect(files.has(`${DIR}/${sentinel}`)).toBe(false);
  const warnings = logs.filter(
    (entry) => entry.level === "WARN" && entry.message.includes(sentinel),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0].message).toContain("Permission denied");
});

describe("a direct write that throws leaves its final name tracked for cleanup()", () => {
  test("the hello", async () => {
    const files = new Map<string, Buffer>();
    const helloName = `${ID_A}-hello.json`;
    const a = recordingClient(files, {
      failPutTo: (name) => name === helloName,
    });
    const conn = party(ID_A, a.client, { writeWithoutRenaming: true });

    await expect(conn.synchronize()).rejects.toThrow(/connection lost/);
    expect(responsibleFilesOf(conn).has(helloName)).toBe(true);
    await conn.cleanup();
    expect(files.has(`${DIR}/${helloName}`)).toBe(false);
  });

  test("the joining sentinel, before the peer hello is deleted", async () => {
    const files = new Map<string, Buffer>();
    files.set(
      `${DIR}/${ID_A}-hello.json`,
      Buffer.from(
        JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
      ),
    );
    const sentinel = `${ID_B}-joining.json`;
    const b = recordingClient(files, { failPutTo: (n) => n === sentinel });
    const conn = party(ID_B, b.client, { writeWithoutRenaming: true });

    await expect(conn.synchronize()).rejects.toThrow(/connection lost/);
    expect(responsibleFilesOf(conn).has(sentinel)).toBe(true);
    await conn.cleanup();
    expect(files.has(`${DIR}/${sentinel}`)).toBe(false);
    expect(files.has(`${DIR}/${ID_A}-hello.json`)).toBe(true);
  });

  test("the joiner's hello, leaving the sentinel for the peer's recovery", async () => {
    const files = new Map<string, Buffer>();
    files.set(
      `${DIR}/${ID_A}-hello.json`,
      Buffer.from(
        JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
      ),
    );
    const helloName = `${ID_B}-hello.json`;
    const b = recordingClient(files, { failPutTo: (n) => n === helloName });
    const conn = party(ID_B, b.client, { writeWithoutRenaming: true });

    await expect(conn.synchronize()).rejects.toThrow(/connection lost/);
    expect(responsibleFilesOf(conn).has(helloName)).toBe(true);
    expect(responsibleFilesOf(conn).has(`${ID_B}-joining.json`)).toBe(false);
    await conn.cleanup();
    expect(files.has(`${DIR}/${helloName}`)).toBe(false);
    expect(files.has(`${DIR}/${ID_B}-joining.json`)).toBe(true);
  });

  test("the lockless hello ack, swept by the rendezvous rollback", async () => {
    const files = new Map<string, Buffer>();
    const ackName = `${ID_A}-${ID_B}-hello-ack.json`;
    const a = recordingClient(files, { failPutTo: (n) => n === ackName });
    const b = recordingClient(files);
    const opts = { writeWithoutRenaming: true, locklessRendezvous: true };
    const connA = party(ID_A, a.client, opts);
    const connB = party(ID_B, b.client, {
      ...opts,
      timeToLive: new Date(Date.now() + 300),
    });

    const results = await Promise.allSettled([
      connA.synchronize(),
      connB.synchronize(),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(a.ops).toContain(`safeDelete:${ackName}`);
    expect(files.has(`${DIR}/${ackName}`)).toBe(false);
    await connB.close();
  });

  test("a message, which is reported as an unsettled publish and spends its seq", async () => {
    const files = new Map<string, Buffer>();
    const a = recordingClient(files, {
      failPutTo: (n) => n.startsWith(`${ID_A}-`) && n !== `${ID_A}-hello.json`,
    });
    const conn = party(ID_A, a.client, { writeWithoutRenaming: true });
    conn.peerId = ID_B;

    const err = await conn.send({ m: 1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TransportPublishIndeterminateError);
    expect(statesItsOwnNextStep(err)).toBe(true);
    expect(((err as Error).cause as Error).message).toMatch(/connection lost/);
    const written = [...files.keys()].map(baseName);
    expect(written.length).toBe(1);
    expect(responsibleFilesOf(conn).has(written[0])).toBe(true);
    await expect(conn.send({ m: 2 })).rejects.toThrow(
      /sequence number 0 was spent/,
    );
    await conn.cleanup();
    expect(files.size).toBe(0);
  });
});

describe("a payload send whose put throws, through the message bridge", () => {
  async function payloadSendReport(
    writeWithoutRenaming: boolean,
    failPutTo: (name: string) => boolean,
  ): Promise<{ raised: unknown; reported: number }> {
    const files = new Map<string, Buffer>();
    const a = recordingClient(files, { failPutTo });
    const conn = party(ID_A, a.client, { writeWithoutRenaming });
    conn.peerId = ID_B;
    const messages = fromEventConnection(conn);
    let reported = 0;
    const raised = await exchangePayloads(
      messages,
      "initiator",
      { hasData: false },
      1_000,
      () => reported++,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    await messages.close().catch(() => {});
    await conn.cleanup();
    return { raised, reported };
  }

  test("with the mode on, a direct write of the message opens the record obligation", async () => {
    const { raised, reported } = await payloadSendReport(
      true,
      (n) => n.startsWith(`${ID_A}-`) && n !== `${ID_A}-hello.json`,
    );
    expect(
      causeChainSome(
        raised,
        (link) => link instanceof TransportPublishIndeterminateError,
      ),
    ).toBe(true);
    expect(reported).toBe(1);
  });

  test("with the mode off, a put of the temp before any rename does not", async () => {
    const { raised, reported } = await payloadSendReport(false, (n) =>
      n.startsWith("temp-"),
    );
    expect(
      causeChainSome(
        raised,
        (link) =>
          link instanceof Error && link.message.includes("connection lost"),
      ),
    ).toBe(true);
    expect(
      causeChainSome(
        raised,
        (link) => link instanceof TransportPublishIndeterminateError,
      ),
    ).toBe(false);
    expect(reported).toBe(0);
  });
});

describe("with the mode off, a refused rename names the option", () => {
  const noSuchFile = (): Error =>
    Object.assign(new Error("_rename: No such file"), { code: 2 });

  test("at the hello publish, with the default remedy", async () => {
    const files = new Map<string, Buffer>();
    const a = recordingClient(files, { renameError: noSuchFile() });
    const conn = party(ID_A, a.client, {});

    const err = await conn.synchronize().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain(
      `${ID_A}-hello.json was written under a temporary name but could not ` +
        "be renamed into place",
    );
    expect(err?.message).toContain("The server may not allow renames.");
    expect(err?.message).toContain(DEFAULT_RENAME_REFUSED_GUIDANCE);
    expect((err?.cause as { code?: unknown }).code).toBe(2);
    expect(a.ops[0]).toMatch(/^put:temp-hello-/);
  });

  test("at a message publish, with the caller's remedy", async () => {
    const files = new Map<string, Buffer>();
    const a = recordingClient(files, {
      renameError: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    });
    const conn = party(ID_A, a.client, {
      renameRefusedGuidance: "Pass --example-flag.",
    });
    conn.peerId = ID_B;

    await expect(conn.send({ m: 1 })).rejects.toThrow(
      /could not be renamed into place: .*The server may not allow renames\. Pass --example-flag\.$/,
    );
  });

  test.each([
    {
      refusal: "SFTP permission denied",
      error: () =>
        Object.assign(new Error("_rename: Permission denied"), { code: 3 }),
      quoted: "with SFTP status 3 (_rename: Permission denied)",
    },
    {
      refusal: "a folder's EPERM",
      error: () =>
        Object.assign(
          new Error("EPERM: operation not permitted, rename 'a' -> 'b'"),
          { code: "EPERM" },
        ),
      quoted: "(EPERM: operation not permitted, rename 'a' -> 'b')",
    },
    {
      refusal: "the generic SFTP failure",
      error: () => Object.assign(new Error("_rename: Failure"), { code: 4 }),
      quoted: "with SFTP status 4 (_rename: Failure)",
    },
  ])(
    "a rename refused with $refusal is quoted and names the option",
    async ({ error, quoted }) => {
      const files = new Map<string, Buffer>();
      const refusal = error();
      const a = recordingClient(files, { renameError: refusal });
      const conn = party(ID_A, a.client, {});

      const err = await conn.synchronize().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain(
        `could not be renamed into place: the rename failed ${quoted}. ` +
          "The server may not allow renames.",
      );
      expect(err?.message).toContain(DEFAULT_RENAME_REFUSED_GUIDANCE);
      expect(err?.cause).toBe(refusal);
    },
  );

  test("a rename failure that states its own next step is reported as itself", async () => {
    const files = new Map<string, Buffer>();
    const stalled = new TransportOperationStalledError("file rename stalled");
    const a = recordingClient(files, { renameError: stalled });
    const conn = party(ID_A, a.client, {});

    await expect(conn.synchronize()).rejects.toBe(stalled);
  });

  test("a rename failure with no status or error code, a refused host key on re-dial, is reported as itself", async () => {
    const files = new Map<string, Buffer>();
    const hostDenied = new Error("Host denied (verification failed)");
    const a = recordingClient(files, { renameError: hostDenied });
    const conn = party(ID_A, a.client, {});

    await expect(conn.synchronize()).rejects.toBe(hostDenied);
  });
});

test("the mode is not advertised: the hello is byte-for-byte the same with it on or off", async () => {
  const helloBody = async (writeWithoutRenaming: boolean): Promise<Buffer> => {
    const a = recordingClient(new Map<string, Buffer>());
    const conn = party(ID_A, a.client, {
      writeWithoutRenaming,
      timeToLive: new Date(Date.now() + 30),
    });
    await conn.synchronize().catch(() => {});
    const [body] = [...a.written.values()];
    return body;
  };
  const direct = await helloBody(true);
  expect(direct.length).toBeGreaterThan(0);
  expect(direct).toEqual(await helloBody(false));
});
