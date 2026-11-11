// The protocol and envelope versions a run with no key exchange selects from
// the two file-sync rendezvous hellos (docs/spec/FILE_SYNC_MODES.md, Selecting the
// versions at the rendezvous).

import { describe, expect, test } from "vitest";

import type { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import {
  HELLO_VERSIONS_WHEN_ABSENT,
  HelloEnvelopeSchema,
  type HelloVersions,
} from "../../src/connection/controlEnvelope";
import {
  HELLO_MAX_BYTES,
  helloEnvelope,
  selectRendezvousVersions,
} from "../../src/connection/fileSyncRendezvous";
import { serializeEnvelope } from "../../src/connection/controlEnvelope";
import { PartnerProtocolRefusalError, UsageError } from "../../src/errors";
import { ENVELOPE_VERSION, PROTOCOL_VERSION } from "../../src/versionHello";
import {
  LOCK_HELLO_BODY,
  helloBodyFor,
  helloName,
  makeConnectedConn,
  makeRendezvousPair,
} from "../utils/fileSyncConnectionFixture";
import { makeMockClient } from "../utils/support";

const ID_LOW = "00000000-0000-4000-8000-000000000001";
const ID_HIGH = "ffffffff-ffff-4fff-bfff-ffffffffffff";

const OLDER: HelloVersions = { protocol: [1], envelope: [1] };
const NEWER: HelloVersions = { protocol: [1, 2], envelope: [1] };
const DISJOINT: HelloVersions = { protocol: [2, 3], envelope: [1] };

const LOCKLESS = { locklessRendezvous: true };

function bodyOf(files: Map<string, Buffer>, name: string): unknown {
  const body = files.get(`/test/${name}`);
  if (body === undefined) throw new Error(`no file ${name}`);
  return JSON.parse(body.toString());
}

function helloNamesIn(files: Map<string, Buffer>): string[] {
  return [...files.keys()].filter((path) => path.includes("-hello-"));
}

async function bothRefuse(
  connA: FileSyncConnection,
  connB: FileSyncConnection,
  offeredA: HelloVersions,
  offeredB: HelloVersions,
): Promise<[PartnerProtocolRefusalError, PartnerProtocolRefusalError]> {
  const results = await Promise.allSettled([
    connA.synchronize({ selectVersions: true, offeredVersions: offeredA }),
    connB.synchronize({ selectVersions: true, offeredVersions: offeredB }),
  ]);
  return results.map((result) => {
    expect(result.status).toBe("rejected");
    const reason = (result as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(PartnerProtocolRefusalError);
    return reason as PartnerProtocolRefusalError;
  }) as [PartnerProtocolRefusalError, PartnerProtocolRefusalError];
}

describe("a pair sharing a version selects the highest one", () => {
  test.each([
    ["lock", {}],
    ["lockless", LOCKLESS],
  ])("%s rendezvous: [1, 2] against [1] selects 1", async (_mode, opts) => {
    const { connA, connB, files } = makeRendezvousPair(
      ID_LOW,
      opts,
      ID_HIGH,
      opts,
    );
    await Promise.all([
      connA.synchronize({ selectVersions: true, offeredVersions: NEWER }),
      connB.synchronize({ selectVersions: true, offeredVersions: OLDER }),
    ]);
    expect(connA.selectedVersions).toEqual({ protocol: 1, envelope: 1 });
    expect(connB.selectedVersions).toEqual({ protocol: 1, envelope: 1 });
    expect(connA.peerId).toBe(ID_HIGH);
    if (opts === LOCKLESS)
      for (const name of helloNamesIn(files).filter(
        (n) => !n.endsWith("-ack.json"),
      ))
        expect(
          (bodyOf(files, name.slice("/test/".length)) as { versions: unknown })
            .versions,
        ).toBeDefined();
  });

  test("the envelope layer selects on its own: [1, 2] against [1] selects 1", async () => {
    const { connA, connB } = makeRendezvousPair(
      ID_LOW,
      LOCKLESS,
      ID_HIGH,
      LOCKLESS,
    );
    await Promise.all([
      connA.synchronize({
        selectVersions: true,
        offeredVersions: { protocol: [1], envelope: [1, 2] },
      }),
      connB.synchronize({ selectVersions: true, offeredVersions: OLDER }),
    ]);
    expect(connA.selectedVersions).toEqual({ protocol: 1, envelope: 1 });
    expect(connB.selectedVersions).toEqual({ protocol: 1, envelope: 1 });
  });

  test("two parties offering [1, 2] select 2", async () => {
    const { connA, connB } = makeRendezvousPair(
      ID_LOW,
      LOCKLESS,
      ID_HIGH,
      LOCKLESS,
    );
    await Promise.all([
      connA.synchronize({ selectVersions: true, offeredVersions: NEWER }),
      connB.synchronize({ selectVersions: true, offeredVersions: NEWER }),
    ]);
    expect(connA.selectedVersions?.protocol).toBe(2);
    expect(connB.selectedVersions?.protocol).toBe(2);
  });

  test("this build's own lists pair with themselves at this build's versions", async () => {
    const { connA, connB } = makeRendezvousPair(ID_LOW, {}, ID_HIGH, {});
    await Promise.all([
      connA.synchronize({ selectVersions: true }),
      connB.synchronize({ selectVersions: true }),
    ]);
    const expected = { protocol: PROTOCOL_VERSION, envelope: ENVELOPE_VERSION };
    expect(connA.selectedVersions).toEqual(expected);
    expect(connB.selectedVersions).toEqual(expected);
  });

  test("a peer hello with no versions member is read as protocol 1 and envelope 1", async () => {
    expect(HELLO_VERSIONS_WHEN_ABSENT).toEqual({
      protocol: [1],
      envelope: [1],
    });
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { timeToLiveMs: 30_000 });
    conn.id = ID_HIGH;
    files.set(`${conn.path}/${helloName(ID_LOW)}`, LOCK_HELLO_BODY);

    await conn.synchronize({ selectVersions: true, offeredVersions: NEWER });

    expect(conn.selectedVersions).toEqual({ protocol: 1, envelope: 1 });
    expect(conn.peerId).toBe(ID_LOW);
  });
});

describe("a pair sharing no version stops at the rendezvous on both sides", () => {
  test.each([
    ["lock, concurrent", {}],
    ["lockless", LOCKLESS],
  ])("%s", async (_mode, opts) => {
    const { connA, connB, files } = makeRendezvousPair(
      ID_LOW,
      opts,
      ID_HIGH,
      opts,
    );
    const [refusalA, refusalB] = await bothRefuse(
      connA,
      connB,
      OLDER,
      DISJOINT,
    );

    expect(refusalA.message).toContain(
      "this party supports protocol versions 1 and the partner supports 2, 3",
    );
    expect(refusalB.message).toContain(
      "this party supports protocol versions 2, 3 and the partner supports 1",
    );
    expect(refusalA.olderVersion).toBe("this-party");
    expect(refusalB.olderVersion).toBe("partner");
    expect(refusalA).not.toBeInstanceOf(UsageError);
    // Both hellos stay as the directory's terminal state, and no message,
    // ack of a message, or lock was written.
    const names = [...files.keys()];
    expect(
      helloNamesIn(files).filter((n) => /-hello-\d+\.json$/.test(n)),
    ).toHaveLength(2);
    expect(names.filter((n) => n.endsWith("-lock.json"))).toEqual([]);
    expect(
      names.filter((n) => /-\d+\.json$/.test(n) && !n.includes("-hello-")),
    ).toEqual([]);
  });

  test("lock, sequential: the joiner refuses on the hello it finds and the starter on the joiner's", async () => {
    const { connA, connB, files } = makeRendezvousPair(ID_LOW, {}, ID_HIGH, {});
    const starter = connA.synchronize({
      selectVersions: true,
      offeredVersions: OLDER,
    });
    const starterOutcome = starter.then(
      () => undefined,
      (err: unknown) => err,
    );
    while (helloNamesIn(files).length === 0)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const joinerOutcome = await connB
      .synchronize({ selectVersions: true, offeredVersions: DISJOINT })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(joinerOutcome).toBeInstanceOf(PartnerProtocolRefusalError);
    expect(await starterOutcome).toBeInstanceOf(PartnerProtocolRefusalError);
    expect(helloNamesIn(files)).toHaveLength(2);
  });

  test("an envelope layer with nothing in common names the envelope lists", async () => {
    const { connA, connB } = makeRendezvousPair(
      ID_LOW,
      LOCKLESS,
      ID_HIGH,
      LOCKLESS,
    );
    const [refusalA] = await bothRefuse(
      connA,
      connB,
      { protocol: [1], envelope: [1] },
      { protocol: [1], envelope: [2] },
    );
    expect(refusalA.message).toContain(
      "this party supports message envelope versions 1 and the partner supports 2",
    );
  });
});

describe("a run with a key exchange", () => {
  test("writes no versions member and ignores the peer's lists", async () => {
    const { connA, connB, files } = makeRendezvousPair(
      ID_LOW,
      LOCKLESS,
      ID_HIGH,
      LOCKLESS,
    );
    await Promise.all([
      connA.synchronize(),
      connB.synchronize({ selectVersions: true, offeredVersions: OLDER }),
    ]);
    expect(connA.selectedVersions).toBeUndefined();
    expect(connB.selectedVersions).toEqual({ protocol: 1, envelope: 1 });
    expect(
      bodyOf(
        files,
        helloName(
          ID_LOW,
          helloBodyFor({ locklessRendezvous: true, retainFiles: false }),
        ),
      ),
    ).toEqual({ locklessRendezvous: true, retainFiles: false });
  });

  test("completes against a peer hello offering versions this build does not hold", async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { timeToLiveMs: 30_000 });
    conn.id = ID_HIGH;
    const body = serializeEnvelope(
      helloEnvelope(
        { locklessRendezvous: false, retainFiles: false },
        DISJOINT,
      ),
    );
    files.set(`${conn.path}/${helloName(ID_LOW, body)}`, body);

    await conn.synchronize();

    expect(conn.peerId).toBe(ID_LOW);
    expect(conn.selectedVersions).toBeUndefined();
  });
});

describe("the hello's versions member", () => {
  test("a peer hello whose versions break the list rules is refused as malformed", async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { timeToLiveMs: 30_000 });
    conn.id = ID_HIGH;
    const body = Buffer.from(
      JSON.stringify({
        locklessRendezvous: false,
        retainFiles: false,
        versions: { protocol: [0], envelope: [1] },
      }),
    );
    files.set(`${conn.path}/${helloName(ID_LOW, body)}`, body);

    await expect(conn.synchronize({ selectVersions: true })).rejects.toThrow(
      /malformed payload/,
    );
  });

  test("members a later build adds are ignored", () => {
    const parsed = HelloEnvelopeSchema.parse({
      locklessRendezvous: true,
      retainFiles: false,
      later: 1,
      versions: { protocol: [1, 2], envelope: [1], later: [3] },
    });
    expect(parsed).toEqual({
      locklessRendezvous: true,
      retainFiles: false,
      versions: { protocol: [1, 2], envelope: [1] },
    });
    expect(selectRendezvousVersions(OLDER, parsed)).toEqual({
      ok: true,
      selected: { protocol: 1, envelope: 1 },
    });
  });

  test("the largest lists the rules admit stay inside the hello size bound", () => {
    const longest = Array.from({ length: 32 }, () => 0x7fffffff);
    const body = serializeEnvelope(
      helloEnvelope(
        { locklessRendezvous: false, retainFiles: false },
        { protocol: longest, envelope: longest },
      ),
    );
    expect(body.length).toBeLessThanOrEqual(HELLO_MAX_BYTES);
    expect(
      HelloEnvelopeSchema.safeParse(JSON.parse(body.toString())).success,
    ).toBe(true);
  });
});
