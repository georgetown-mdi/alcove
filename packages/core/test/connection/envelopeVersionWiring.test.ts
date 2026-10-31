import { describe, expect, test, vi } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import type { FileSyncMessageLoop } from "../../src/connection/fileSyncMessageLoop";
import { isMessageName } from "../../src/connection/fileSyncNames";
import {
  createMessagePipe,
  fromEventConnection,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { EncryptedMessageConnection } from "../../src/connection/encryptedMessageConnection";
import { runKex, supportedVersions } from "../../src/kex";
import type * as VersionHello from "../../src/versionHello";
import {
  driveUntilError,
  makeRendezvousPair,
  runPoller,
} from "../utils/fileSyncConnectionFixture";
import { makeMockClient } from "../utils/support";

// The envelope-version wiring from the key exchange to the file-sync frames,
// driven with a second envelope version: this build implements only 1, so
// here the build's version is 2, which the message loop then accepts as
// negotiated. Each party's first frame stays at 1 whatever was negotiated
// (docs/spec/FILE_SYNC.md, "Message body format").
vi.mock("../../src/versionHello", async (importOriginal) => ({
  ...(await importOriginal<typeof VersionHello>()),
  ENVELOPE_VERSION: 2,
}));

const NEGOTIATED = 2;
const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const PSK = new Uint8Array(32).fill(0x42);

const MODES = [
  { mode: "delete", options: {} },
  {
    mode: "retain",
    options: {
      locklessRendezvous: true,
      retainFiles: true,
      timestampInFilename: true,
    },
  },
] as const;

async function negotiatedPair(options: (typeof MODES)[number]["options"]) {
  const { connA, connB, files } = makeRendezvousPair(
    ID_A,
    options,
    ID_B,
    options,
  );
  await Promise.all([connA.synchronize(), connB.synchronize()]);
  connA.useEnvelopeVersion(NEGOTIATED);
  connB.useEnvelopeVersion(NEGOTIATED);
  return { connA, connB, files };
}

// Sends `data` from `conn` and returns the path of the message file it wrote.
async function sendAndFind(
  conn: FileSyncConnection,
  files: Map<string, Buffer>,
  data: unknown,
): Promise<string> {
  const before = new Set(files.keys());
  await conn.send(data);
  const written = [...files.keys()].filter((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return (
      !before.has(path) && name.startsWith(`${conn.id}-`) && isMessageName(name)
    );
  });
  expect(written).toHaveLength(1);
  return written[0]!;
}

function setVersionByte(
  files: Map<string, Buffer>,
  path: string,
  version: number,
): void {
  const body = Buffer.from(files.get(path)!);
  body[0] = version;
  files.set(path, body);
}

// Collects what `conn` delivers and the errors it reports, resolving `next(n)`
// once n frames have arrived or an error has.
function deliveries(conn: FileSyncConnection) {
  const received: unknown[] = [];
  const errors: unknown[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const wake = () => {
    for (const waiter of waiters)
      if (errors.length > 0 || received.length >= waiter.count)
        waiter.resolve();
  };
  conn.on("data", (data) => {
    received.push(data);
    wake();
  });
  conn.on("error", (error) => {
    errors.push(error);
    wake();
  });
  return {
    received,
    errors,
    next: (count: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
        wake();
      }),
  };
}

describe("the file-sync message loop with a negotiated envelope version", () => {
  test("sends its first frame at 1 and every later frame at the negotiated version", async () => {
    const { connB, files } = await negotiatedPair({});
    const versions: number[] = [];
    for (const data of [{ n: 0 }, { n: 1 }, new Uint8Array([1, 2, 3])]) {
      const path = await sendAndFind(connB, files, data);
      versions.push(files.get(path)![0]!);
      // Consumes the message as the partner would, so the next send proceeds.
      files.delete(path);
    }
    expect(versions).toEqual([1, NEGOTIATED, NEGOTIATED]);
  });

  describe.each(MODES)("in $mode mode", ({ options }) => {
    test("accepts the partner's first frame at 1 and later frames at the negotiated version", async () => {
      const { connA, connB, files } = await negotiatedPair(options);
      const { received, errors, next } = deliveries(connA);
      for (const [index, data] of [{ n: 0 }, { n: 1 }, { n: 2 }].entries()) {
        await sendAndFind(connB, files, data);
        await runPoller(connA, next(index + 1));
        expect(errors).toEqual([]);
      }
      expect(received).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    });

    test.each([1, 3])(
      "refuses a later partner frame at envelope version %i",
      async (version) => {
        const { connA, connB, files } = await negotiatedPair(options);
        const { errors: early, next } = deliveries(connA);
        await sendAndFind(connB, files, { n: 0 });
        await runPoller(connA, next(1));
        expect(early).toEqual([]);
        setVersionByte(
          files,
          await sendAndFind(connB, files, { n: 1 }),
          version,
        );
        const { errors } = await driveUntilError(connA);
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toContain(
          `envelope version byte ${version}, not the expected ${NEGOTIATED}`,
        );
      },
    );

    test("refuses a partner's first frame at the negotiated version", async () => {
      const { connA, connB, files } = await negotiatedPair(options);
      setVersionByte(
        files,
        await sendAndFind(connB, files, { n: 0 }),
        NEGOTIATED,
      );
      const { errors } = await driveUntilError(connA);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toContain(
        `envelope version byte ${NEGOTIATED}, not the expected 1`,
      );
    });
  });
});

describe("the negotiated envelope version reaches the message loop", () => {
  // A connection over `conn` that records each envelope version it is handed.
  function tracking(
    conn: MessageConnection,
    seen: number[],
  ): MessageConnection {
    return {
      send: (data) => conn.send(data),
      receive: (timeoutMs) => conn.receive(timeoutMs),
      close: () => conn.close(),
      useEnvelopeVersion: (version) => {
        seen.push(version);
      },
    };
  }

  test.each([
    { initiator: [1, 2], responder: [1, 2], negotiated: 2 },
    { initiator: [1, 2], responder: [1], negotiated: 1 },
  ])(
    "runKex hands each role's transport the negotiated envelope version (initiator $initiator, responder $responder)",
    async ({ initiator, responder, negotiated }) => {
      const [a, b] = createMessagePipe();
      const offer = (envelope: number[]) => ({
        kex: supportedVersions().kex,
        protocol: [1],
        envelope,
      });
      const initiatorSeen: number[] = [];
      const responderSeen: number[] = [];
      await Promise.all([
        runKex(
          tracking(a, initiatorSeen),
          "initiator",
          PSK,
          true,
          { history: [] },
          offer(initiator),
        ),
        runKex(
          tracking(b, responderSeen),
          "responder",
          PSK,
          true,
          { history: [] },
          offer(responder),
        ),
      ]);
      expect(initiatorSeen).toEqual([negotiated]);
      expect(responderSeen).toEqual([negotiated]);
    },
  );

  test("each wrapper connection forwards the version to the message loop", async () => {
    const { client } = makeMockClient();
    const conn = new FileSyncConnection(client, { verbose: -1 });
    const loop = (conn as unknown as { messageLoop: FileSyncMessageLoop })
      .messageLoop;
    const forwarded = vi.spyOn(loop, "useEnvelopeVersion");
    const bridged = fromEventConnection(conn);
    const encrypted = await EncryptedMessageConnection.create(
      bridged,
      new Uint8Array(32),
      "initiator",
    );

    conn.useEnvelopeVersion(NEGOTIATED);
    expect(forwarded).toHaveBeenLastCalledWith(NEGOTIATED);
    bridged.useEnvelopeVersion?.(NEGOTIATED);
    expect(forwarded).toHaveBeenCalledTimes(2);
    encrypted.useEnvelopeVersion(NEGOTIATED);
    expect(forwarded).toHaveBeenCalledTimes(3);
    expect(forwarded.mock.calls).toEqual([
      [NEGOTIATED],
      [NEGOTIATED],
      [NEGOTIATED],
    ]);
  });
});
