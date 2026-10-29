// A per-run peer id from fields in `peer_id`: the id each run writes under,
// the file names two runs of one configuration write, the leftover-hello check
// at entry, and the partner-facing id refusals on the filled-in ids.

import { describe, expect, test } from "vitest";

import {
  FileSyncConnection,
  type FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import {
  MAX_PEER_ID_BYTES,
  safeParseFileSyncOptions,
  type FileSyncOptions,
} from "../../src/config/connection";
import type { PeerIdFieldSource } from "../../src/config/peerIdTemplate";
import {
  peerIdLengthRefusal,
  peerIdPrefixRefusal,
} from "../../src/connection/fileSyncRendezvous";
import { UsageError, isPeerWaitTimeout } from "../../src/errors";
import { failureCauseOf } from "../../src/failureCause";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";
import { helloName, joiningName } from "../utils/fileSyncConnectionFixture";
import { makeMockClient } from "../utils/support";

const DIR = "/test";
const TEMPLATE = "site_%Y%m%d-%H%M%S-%K";
const FIELD_BYTES = "_20261028-020000-0123456789abcdef".length;

const baseName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

const pinned = (nowMs: number, randomHex: string): PeerIdFieldSource => ({
  nowMs: () => nowMs,
  randomHex: () => randomHex,
});

const T0 = Date.UTC(2026, 9, 28, 2, 0, 0);

// The options of one party's configuration, checked as a load would check them.
function configured(
  peerId: string,
  extra: Partial<FileSyncOptions> = {},
): FileSyncOptions {
  const options: FileSyncOptions = {
    timestampInFilename: true,
    peerId,
    ...extra,
  };
  const checked = safeParseFileSyncOptions(options);
  if (!checked.success) throw checked.error;
  return options;
}

// One party opened on the shared in-memory directory from its configuration,
// recording the final name of every file it writes.
async function openParty(
  files: Map<string, Buffer>,
  options: FileSyncOptions,
  source?: PeerIdFieldSource,
  timeToLiveMs = 10_000,
): Promise<{ conn: FileSyncConnection; written: Set<string> }> {
  const { client } = makeMockClient({ files });
  const written = new Set<string>();
  const recording: FileTransportClient = {
    ...client,
    put: async (src, dest, putOptions) => {
      if (!baseName(dest).startsWith("temp-")) written.add(baseName(dest));
      return client.put(src, dest, putOptions);
    },
    rename: async (from, to) => {
      written.add(baseName(to));
      return client.rename(from, to);
    },
  };
  const conn = new FileSyncConnection(recording, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + timeToLiveMs),
    verbose: -1,
    ...(source !== undefined ? { peerIdFieldSource: source } : {}),
  });
  await conn.open({ channel: "filedrop", path: DIR, options });
  return { conn, written };
}

const nextData = (conn: FileSyncConnection): Promise<unknown> =>
  new Promise((resolve) => conn.once("data", resolve));

// One message each way, then both parties close.
async function exchangeOnce(
  a: FileSyncConnection,
  b: FileSyncConnection,
): Promise<void> {
  const bGot = nextData(b);
  const aGot = nextData(a);
  a.start();
  b.start();
  await a.send({ from: "a" });
  expect(await bGot).toEqual({ from: "a" });
  await b.send({ from: "b" });
  expect(await aGot).toEqual({ from: "b" });
  await Promise.all([a.close(), b.close()]);
}

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (err: unknown) => err,
  );

describe("the id a run writes under", () => {
  test("a peer_id with no '%' is used as written", async () => {
    const { conn } = await openParty(
      new Map(),
      configured("site"),
      pinned(T0, "0123456789abcdef"),
    );
    expect(conn.id).toBe("site");
  });

  test("two runs from one configuration get different ids with the same leading text (pinned clock and random source)", async () => {
    const options = configured(TEMPLATE);
    const ids = await Promise.all(
      [
        pinned(T0, "0123456789abcdef"),
        pinned(T0, "fedcba9876543210"),
        pinned(T0 + 1000, "0123456789abcdef"),
      ].map(
        async (source) => (await openParty(new Map(), options, source)).conn.id,
      ),
    );
    expect(ids).toEqual([
      "site_20261028-020000-0123456789abcdef",
      "site_20261028-020000-fedcba9876543210",
      "site_20261028-020001-0123456789abcdef",
    ]);
  });

  test("two runs from one configuration get different ids with the same leading text (system clock and random source)", async () => {
    const options = configured(TEMPLATE);
    const first = (await openParty(new Map(), options)).conn;
    const second = (await openParty(new Map(), options)).conn;
    expect(first.id).not.toBe(second.id);
    for (const conn of [first, second]) {
      expect(conn.id).toMatch(/^site_\d{8}-\d{6}-[0-9a-f]{16}$/);
      expect(conn.options.peerId).toBe(TEMPLATE);
    }
  });

  test("open() refuses a peer_id whose fields do not parse", async () => {
    await expect(
      openParty(new Map(), { timestampInFilename: true, peerId: "site_%q" }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("the longest peer_id at its longest expansion fits the byte cap and the two-id name budget", async () => {
    const peerId = `${"p".repeat(MAX_PEER_ID_BYTES - FIELD_BYTES)}_%Y%m%d-%H%M%S-%K`;
    const { conn } = await openParty(
      new Map(),
      configured(peerId),
      pinned(T0, "ffffffffffffffff"),
    );
    expect(Buffer.byteLength(conn.id)).toBe(MAX_PEER_ID_BYTES);
    expect(peerIdLengthRefusal(conn.id, "x")).toBeUndefined();
    expect(peerIdLengthRefusal("x", conn.id)).toBeUndefined();
    expect(peerIdLengthRefusal(conn.id, "xy")).toBeDefined();
    expect(peerIdLengthRefusal("xy", conn.id)).toBeDefined();
  });
});

describe("two runs from one configuration", () => {
  for (const mode of [
    { name: "lock rendezvous", extra: {} },
    { name: "lockless rendezvous", extra: { locklessRendezvous: true } },
  ])
    test(`write no file name in common (${mode.name})`, async () => {
      const files = new Map<string, Buffer>();
      const own = configured(TEMPLATE, mode.extra);
      const partner = configured("partner", mode.extra);
      const runs: Array<Set<string>> = [];
      for (const source of [
        pinned(T0, "0123456789abcdef"),
        pinned(T0 + 60_000, "fedcba9876543210"),
      ]) {
        const a = await openParty(files, own, source);
        const b = await openParty(files, partner);
        await Promise.all([a.conn.synchronize(), b.conn.synchronize()]);
        expect(a.conn.peerId).toBe("partner");
        expect(b.conn.peerId).toBe(a.conn.id);
        await exchangeOnce(a.conn, b.conn);
        expect([...files.keys()]).toEqual([]);
        runs.push(a.written);
      }
      const [first, second] = runs;
      expect(first.size).toBeGreaterThanOrEqual(2);
      expect([...first].filter((name) => second.has(name))).toEqual([]);
      // A lock file starts with whichever id sorts first, the partner's
      // included (docs/spec/FILE_SYNC.md); every other name starts with the
      // text before the first field.
      for (const name of [...first, ...second].filter(
        (written) => !written.endsWith("-lock.json"),
      ))
        expect(name.startsWith("site_")).toBe(true);
    });
});

describe("the leftover-hello check at entry under a peer_id with fields", () => {
  const own = configured(TEMPLATE);
  const today = pinned(T0, "0123456789abcdef");
  const earlierRun = "site_20261027-020000-89abcdef01234567";

  for (const leftover of [
    { kind: "hello", name: helloName(earlierRun) },
    { kind: "joining file", name: joiningName(earlierRun) },
  ])
    test(`refuses an earlier run's ${leftover.kind} as this party's own`, async () => {
      const files = new Map<string, Buffer>([
        [`${DIR}/${leftover.name}`, Buffer.from("{}")],
      ]);
      const { conn, written } = await openParty(files, own, today);
      const err = await rejectionOf(conn.synchronize());
      expect(err).toBeInstanceOf(UsageError);
      const rendered = sanitizeErrorForDisplay(err);
      expect(rendered).toContain("unexpected protocol file");
      expect(rendered).toContain(leftover.name);
      expect(rendered).toContain("--sweep-exchange-files");
      expect(written).toEqual(new Set());
      expect(files.has(`${DIR}/${leftover.name}`)).toBe(true);
    });

  for (const partnerId of ["partner", "site", "site-2", "site_x"])
    test(`takes a hello from partner '${partnerId}' as the partner's`, async () => {
      const files = new Map<string, Buffer>();
      const b = await openParty(files, configured(partnerId));
      const syncB = b.conn.synchronize();
      await expect
        .poll(() => files.has(`${DIR}/${helloName(partnerId)}`))
        .toBe(true);
      const a = await openParty(files, own, today);
      await Promise.all([a.conn.synchronize(), syncB]);
      expect(a.conn.peerId).toBe(partnerId);
      expect(b.conn.peerId).toBe(a.conn.id);
      await Promise.all([a.conn.close(), b.conn.close()]);
    });
});

describe("a partner id that fits this party's peer_id", () => {
  const SHARED_CAUSE =
    "The likely cause is that both parties set the same peer_id: set a " +
    "different peer_id on one side, changing its text rather than only its " +
    "% fields.";
  const NEVER_ARRIVED =
    "Your partner did not arrive in the shared folder in the time this run " +
    "waited.";

  for (const shape of [
    { name: "the same peer_id", own: "site", partnerId: "site" },
    {
      name: "the same peer_id with fields",
      own: TEMPLATE,
      partnerId: "site_20261028-020000-89abcdef01234567",
    },
  ])
    test(`the start-up refusal of its hello names the shared peer_id before any removal (${shape.name})`, async () => {
      const partnerHello = helloName(shape.partnerId);
      const files = new Map<string, Buffer>([
        [`${DIR}/${partnerHello}`, Buffer.from("{}")],
      ]);
      const { conn } = await openParty(
        files,
        configured(shape.own),
        pinned(T0, "0123456789abcdef"),
      );
      const err = await rejectionOf(conn.synchronize());
      expect(err).toBeInstanceOf(UsageError);
      const message = (err as Error).message;
      expect(message).toBe(
        "the exchange directory holds a hello file whose id fits this " +
          "party's own peer_id, so this run takes it for its own leftover. " +
          `${SHARED_CAUSE} If instead the listed files are left over from ` +
          "an earlier run of this party, remove them after confirming no " +
          "other session is using this path, or re-run with " +
          "--sweep-exchange-files to clear every protocol file.",
      );
      expect(message.indexOf(SHARED_CAUSE)).toBeLessThan(
        message.indexOf("remove them"),
      );
      expect(sanitizeErrorForDisplay(err)).toContain(partnerHello);
      expect(files.has(`${DIR}/${partnerHello}`)).toBe(true);
    });

  test("the start-up refusal of unrelated leftover files is unchanged", async () => {
    const lockName = "partner-site-lock.json";
    const files = new Map<string, Buffer>([
      [`${DIR}/${lockName}`, Buffer.from("{}")],
    ]);
    const { conn } = await openParty(files, configured("site"));
    const err = await rejectionOf(conn.synchronize());
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toBe(
      "the exchange directory must be empty except for a single peer " +
        "hello, but holds unexpected protocol files. Remove them after " +
        "confirming no other session is using this path, or re-run with " +
        "--sweep-exchange-files to clear every protocol file.",
    );
    expect(sanitizeErrorForDisplay(err)).toContain(lockName);
  });

  for (const mode of [
    { name: "lock rendezvous", extra: {} },
    { name: "lockless rendezvous", extra: { locklessRendezvous: true } },
  ])
    test(`the peer timeout after skipping its hello names the shared peer_id (${mode.name})`, async () => {
      const files = new Map<string, Buffer>();
      const options = configured(TEMPLATE, mode.extra);
      const a = await openParty(
        files,
        options,
        pinned(T0, "0123456789abcdef"),
        300,
      );
      const b = await openParty(
        files,
        options,
        pinned(T0, "fedcba9876543210"),
        300,
      );
      // Both enter before either hello exists, so each skips the other's
      // hello in the wait and reaches its peer timeout.
      const [errA, errB] = await Promise.all([
        rejectionOf(a.conn.synchronize()),
        rejectionOf(b.conn.synchronize()),
      ]);
      for (const [err, other] of [
        [errA, b.conn.id],
        [errB, a.conn.id],
      ] as const) {
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(UsageError);
        expect(isPeerWaitTimeout(err)).toBe(true);
        expect(failureCauseOf(err)?.kind).toBe("partner-never-arrived");
        const message = (err as Error).message;
        expect(message.startsWith(`${NEVER_ARRIVED} This run ignored a`)).toBe(
          true,
        );
        expect(message).toContain(SHARED_CAUSE);
        expect(message).toMatch(
          new RegExp(`The ignored file: ${other}-hello-\\d+\\.json$`),
        );
      }
    });

  test("a peer timeout with only this run's own hello in the folder is unchanged", async () => {
    const files = new Map<string, Buffer>();
    const { conn } = await openParty(files, configured("site"), undefined, 80);
    const err = await rejectionOf(conn.synchronize());
    expect(isPeerWaitTimeout(err)).toBe(true);
    expect((err as Error).message).toBe(NEVER_ARRIVED);
  });
});

describe("the partner-facing id refusals on the filled-in ids", () => {
  test("an id that is the partner's id followed by '-' once filled in is refused by both parties", async () => {
    const files = new Map<string, Buffer>();
    const a = await openParty(
      files,
      configured("site-%Y%m%d"),
      pinned(T0, "0123456789abcdef"),
    );
    const b = await openParty(files, configured("site"));
    expect(a.conn.id).toBe("site-20261028");
    expect(peerIdPrefixRefusal(a.conn.id, b.conn.id)).toBeDefined();
    expect(peerIdPrefixRefusal(b.conn.id, a.conn.id)).toBeDefined();

    const [errA, errB] = await Promise.all([
      rejectionOf(a.conn.synchronize()),
      rejectionOf(b.conn.synchronize()),
    ]);
    for (const err of [errA, errB]) {
      expect(err).toBeInstanceOf(UsageError);
      expect(sanitizeErrorForDisplay(err)).toContain("are too alike");
    }
  });
});
