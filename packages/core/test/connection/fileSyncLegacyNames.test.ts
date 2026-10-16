// A partner on an earlier version writes its hello as `<id>-hello.json`, with
// no byte count. This version cannot exchange with it, so it refuses such a
// hello naming the earlier version, at entry and during rendezvous, rather
// than waiting out the peer timeout for a hello it never recognizes.

import { describe, expect, test } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import { UsageError } from "../../src/errors";
import { LOCK_HELLO_BODY, helloName } from "../utils/fileSyncConnectionFixture";
import { makeMockClient, type MockClientOptions } from "../utils/support";

const SELF = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const PEER = "00000000-0000-4000-8000-000000000001";
const LEGACY_PEER_HELLO = `${PEER}-hello.json`;

function makeConn(
  clientOptions: MockClientOptions,
  options: { locklessRendezvous?: boolean; sweepExchangeFiles?: boolean } = {},
  timeToLiveMs = 5_000,
): { conn: FileSyncConnection; files: Map<string, Buffer> } {
  const { client, files } = makeMockClient(clientOptions);
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + timeToLiveMs),
    verbose: -1,
    ...options,
  });
  conn.id = SELF;
  conn.connected = true;
  conn.path = "/test";
  return { conn, files };
}

const refusesNamingTheEarlierVersion = async (
  run: Promise<void>,
): Promise<void> => {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(LEGACY_PEER_HELLO);
  expect((err as Error).message).toContain("earlier Alcove version");
};

describe("a partner hello with no byte count in its name", () => {
  test("present at entry is refused before this party writes its hello", async () => {
    const files = new Map([[`/test/${LEGACY_PEER_HELLO}`, LOCK_HELLO_BODY]]);
    const { conn } = makeConn({ files });
    await refusesNamingTheEarlierVersion(conn.synchronize());
    expect([...files.keys()]).toEqual([`/test/${LEGACY_PEER_HELLO}`]);
  });

  for (const locklessRendezvous of [false, true]) {
    test(
      `appearing during ${locklessRendezvous ? "lockless" : "lock"} ` +
        "rendezvous is refused, and this party's own hello is removed",
      async () => {
        const files = new Map([
          [`/test/${LEGACY_PEER_HELLO}`, LOCK_HELLO_BODY],
        ]);
        const { conn } = makeConn(
          { files, hideAtEntry: [LEGACY_PEER_HELLO] },
          { locklessRendezvous },
        );
        await refusesNamingTheEarlierVersion(conn.synchronize());
        expect(files.has(`/test/${helloName(SELF)}`)).toBe(false);
        expect(
          [...files.keys()].some((p) => /-hello-[0-9]+\.json$/.test(p)),
        ).toBe(false);
      },
    );
  }

  test("left over in the folder is swept by --sweep-exchange-files", async () => {
    const files = new Map([[`/test/${LEGACY_PEER_HELLO}`, LOCK_HELLO_BODY]]);
    const { conn } = makeConn({ files }, { sweepExchangeFiles: true }, 200);
    // Nothing answers, so the run ends at the peer timeout once the sweep has
    // cleared the leftover.
    const err = await conn.synchronize().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).not.toContain("earlier Alcove version");
    expect(files.has(`/test/${LEGACY_PEER_HELLO}`)).toBe(false);
  });

  test("written under this party's own id is not a partner hello", async () => {
    const files = new Map([[`/test/${SELF}-hello.json`, LOCK_HELLO_BODY]]);
    const { conn } = makeConn({ files });
    const err = await conn.synchronize().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).not.toContain("earlier Alcove version");
    expect((err as Error).message).toContain("unexpected protocol files");
  });
});
