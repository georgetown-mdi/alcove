// Retain mode in a reused directory: the start-up scan ignores what an earlier
// exchange left there and deletes none of it, every later check skips the
// ignored files, a partner hello nobody answered is ignored only past the
// window, and a reused hello name stops the run.

import logLibrary from "loglevel";
import { describe, expect, test } from "vitest";

import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import {
  answeredHelloStems,
  classifyRetainLeftovers,
} from "../../src/connection/fileSyncLeftovers";
import {
  ackMarkerName,
  sizedControlName,
} from "../../src/connection/fileSyncNames";
import {
  safeParseFileSyncOptions,
  type FileSyncOptions,
} from "../../src/config/connection";
import { serializeEnvelope } from "../../src/connection/controlEnvelope";
import { helloEnvelope } from "../../src/connection/fileSyncRendezvous";
import { UsageError, isPeerWaitTimeout } from "../../src/errors";
import { failureCauseOf } from "../../src/failureCause";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";
import { withCapturedLogs } from "../../src/testing";
import { makeMockClient } from "../utils/support";

const DIR = "/x";
const RETAIN: FileSyncOptions = {
  retainFiles: true,
  locklessRendezvous: true,
  timestampInFilename: true,
};
const HELLO_BODY = serializeEnvelope(
  helloEnvelope({ locklessRendezvous: true, retainFiles: true }),
);
const hello = (id: string): string =>
  sizedControlName(id, "hello", HELLO_BODY.length);
const stem = (name: string): string => name.slice(0, -".json".length);
const at = (name: string, modifyTime: number, size = 0) => ({
  name,
  modifyTime,
  size,
});

async function openParty(
  files: Map<string, Buffer>,
  options: FileSyncOptions,
  modifyTimes?: Map<string, number>,
  verbose = -1,
): Promise<FileSyncConnection> {
  const checked = safeParseFileSyncOptions({ ...RETAIN, ...options });
  if (!checked.success) throw checked.error;
  const { client } = makeMockClient({ files, modifyTimes });
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    verbose,
  });
  await conn.open({
    channel: "filedrop",
    path: DIR,
    options: { ...RETAIN, ...options },
  });
  return conn;
}

const nextData = (conn: FileSyncConnection): Promise<unknown> =>
  new Promise((resolve) => conn.once("data", resolve));

// Rendezvous, then one message each way, then both parties close.
async function exchange(
  a: FileSyncConnection,
  b: FileSyncConnection,
  run: number,
): Promise<void> {
  await Promise.all([a.synchronize(), b.synchronize()]);
  const bGot = nextData(b);
  const aGot = nextData(a);
  a.start();
  b.start();
  await a.send({ from: "a", run });
  expect(await bGot).toEqual({ from: "a", run });
  await b.send({ from: "b", run });
  expect(await aGot).toEqual({ from: "b", run });
  await Promise.all([a.close(), b.close()]);
}

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (err: unknown) => err,
  );

describe("answeredHelloStems", () => {
  test("finds the hello an ack answers when either id holds dashes", () => {
    const answered = answeredHelloStems([
      ackMarkerName("site-b-1", stem(hello("site-a-1"))),
      "notes.txt",
      ackMarkerName("x", "x-20260101T000000-000-12"),
    ]);
    expect(answered.has(stem(hello("site-a-1")))).toBe(true);
    expect(answered.has(stem(hello("a-1")))).toBe(true);
    expect(answered.has("x-20260101T000000-000-12")).toBe(false);
  });

  test("an ack with no writer before the hello answers nothing", () => {
    expect(answeredHelloStems([`-${stem(hello("a"))}-ack.json`]).size).toBe(0);
  });
});

describe("classifyRetainLeftovers", () => {
  const NOW = 10_000_000;
  const classify = (
    inbound: ReturnType<typeof at>[],
    extra: {
      outbound?: ReturnType<typeof at>[];
      windowMs?: number;
      isOwnId?: (id: string) => boolean;
    } = {},
  ) =>
    classifyRetainLeftovers({
      inbound,
      outbound: extra.outbound ?? [],
      listed: [...inbound, ...(extra.outbound ?? [])].map((f) => f.name),
      ownHelloName: hello("me"),
      isOwnId: extra.isOwnId ?? ((id) => id === "me"),
      windowMs: "windowMs" in extra ? extra.windowMs : 60_000,
      now: NOW,
    });
  const ignoredNames = (result: ReturnType<typeof classify>) =>
    result.ignored.map((entry) => entry.file.name);

  test("ignores messages, acks, abort markers and answered hellos", () => {
    const files = [
      at("p1-20260101T000000-000-12.json", NOW),
      at("p1-42.json", NOW),
      at(ackMarkerName("p1", "q1-20260101T000000-000-12"), NOW),
      at("p1-abort-50.json", NOW),
      at(hello("p1"), NOW),
      at(ackMarkerName("q1", stem(hello("p1"))), NOW),
    ];
    expect(ignoredNames(classify(files))).toEqual(files.map((f) => f.name));
  });

  test("keeps a lock, a joining sentinel and names with no writer", () => {
    const files = [
      at("p1-q1-lock.json", 0),
      at(sizedControlName("p1", "joining", 9), 0),
      at("-abort-50.json", 0),
      at(sizedControlName("", "hello", 9), 0),
      at("-42.json", 0),
      at("-20260101T000000-000-12.json", 0),
      at("-ack.json", 0),
      at("-p1-ack.json", 0),
    ];
    expect(ignoredNames(classify(files))).toEqual([]);
  });

  test("reads a writer id that itself starts with a dash", () => {
    const files = [
      at("-p1-20260101T000000-000-12.json", NOW),
      at(ackMarkerName("-q1", "p1-42"), NOW),
    ];
    expect(ignoredNames(classify(files))).toEqual(files.map((f) => f.name));
  });

  test("ignores an unanswered partner hello only once older than the window", () => {
    const young = at(hello("young"), NOW - 60_000);
    const old = at(hello("old"), NOW - 60_001);
    const result = classify([young, old]);
    expect(ignoredNames(result)).toEqual([old.name]);
    expect(result.unansweredHellos).toEqual([old]);
  });

  test("an infinite window keeps every unanswered partner hello", () => {
    const result = classify([at(hello("old"), 0)], { windowMs: undefined });
    expect(ignoredNames(result)).toEqual([]);
  });

  test("keeps an unanswered hello under an id this party writes", () => {
    const own = at(hello("me-20260101"), 0);
    const result = classify([own], { isOwnId: (id) => id.startsWith("me") });
    expect(ignoredNames(result)).toEqual([]);
  });

  test("ignores an own hello in the outbound folder that an inbound ack answers", () => {
    const outHello = at(hello("me-1"), NOW);
    const result = classify(
      [at(ackMarkerName("p1", stem(hello("me-1"))), NOW)],
      { outbound: [outHello, at(hello("me-2"), 0)] },
    );
    expect(result.ignored.filter((e) => e.outbound)).toEqual([
      { file: outHello, outbound: true },
    ]);
  });

  test("names an ack answering this run's own hello name", () => {
    const ack = ackMarkerName("p1", stem(hello("me")));
    expect(classify([at(ack, NOW)]).ownNameAnswered).toBe(ack);
    expect(classify([at(hello("me"), NOW)]).ownNameAnswered).toBeUndefined();
  });
});

describe("a retain exchange in a folder an earlier exchange used", () => {
  test("runs again, reads none of the earlier files and deletes none", async () => {
    const files = new Map<string, Buffer>();
    await exchange(await openParty(files, {}), await openParty(files, {}), 1);
    const afterFirst = new Map(files);
    // Each hello the first exchange wrote has an ack named after it, written
    // by the other party: the rule the second run reads "answered" by.
    const names = [...afterFirst.keys()].map((p) => p.slice(DIR.length + 1));
    const hellos = names.filter((n) => /-hello-\d+\.json$/.test(n));
    expect(hellos).toHaveLength(2);
    for (const name of hellos)
      expect(answeredHelloStems(names).has(stem(name))).toBe(true);

    await exchange(await openParty(files, {}), await openParty(files, {}), 2);
    for (const [path, body] of afterFirst)
      expect(files.get(path)?.equals(body)).toBe(true);
  });

  test("the message loop skips an earlier message under the partner's id", async () => {
    // The partner's earlier hello and its acks are gone, but its messages,
    // under the same id and counters, remain: the poll must skip them. They
    // are dated a day back, as an earlier run's are, since the name holds the
    // second it was sent.
    const files = new Map<string, Buffer>();
    await exchange(
      await openParty(files, {}),
      await openParty(files, { peerId: "partner" }),
      1,
    );
    for (const [path, body] of [...files]) {
      files.delete(path);
      if (path.includes("partner-hello-")) continue;
      files.set(path.replace(/\d{8}T\d{6}/, "20200101T000000"), body);
    }
    files.set(`${DIR}/p1-abort-50.json`, Buffer.alloc(50));
    await exchange(
      await openParty(files, {}),
      await openParty(files, { peerId: "partner" }),
      2,
    );
  });

  test("runs again under a peer_id holding fields", async () => {
    const files = new Map<string, Buffer>();
    const a = { peerId: "a-%Y%m%d%H%M%S-%K" };
    const b = { peerId: "b-%Y%m%d%H%M%S-%K" };
    await exchange(await openParty(files, a), await openParty(files, b), 1);
    await exchange(await openParty(files, a), await openParty(files, b), 2);
  });

  test("logs the count and the youngest file's age, not every file", async () => {
    const files = new Map<string, Buffer>();
    const modifyTimes = new Map<string, number>();
    const now = Date.now();
    for (const [name, ageMs] of [
      ["p1-20260101T000000-000-12.json", 3 * 3_600_000],
      ["p1-20260101T000000-001-12.json", 2 * 3_600_000 + 90_000],
    ] as const) {
      files.set(`${DIR}/${name}`, Buffer.alloc(12));
      modifyTimes.set(`${DIR}/${name}`, now - ageMs);
    }
    const prevLevel = logLibrary.getLevel();
    logLibrary.setLevel("trace");
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = await openParty(
          files,
          { peerTimeoutMs: 50 },
          modifyTimes,
          1,
        );
        await rejectionOf(conn.synchronize());
        await conn.close();
      },
      (level) => level === "INFO",
    ).finally(() => logLibrary.setLevel(prevLevel));
    const line = logs.find((entry) => entry.message.includes("ignoring"));
    expect(line?.message).toContain(
      "ignoring 2 file(s) an earlier exchange left in /x; the youngest is " +
        "121 minutes old",
    );
    expect(line?.message).not.toContain("000-12");
  });

  test("a bare message or ack, which no writer names, is still refused", async () => {
    for (const bare of ["-20260101T000000-000-12.json", "-ack.json"]) {
      const files = new Map<string, Buffer>([
        [`${DIR}/${bare}`, Buffer.alloc(bare === "-ack.json" ? 0 : 12)],
      ]);
      const conn = await openParty(files, {});
      const err = await rejectionOf(conn.synchronize());
      await conn.close();
      expect(err).toBeInstanceOf(UsageError);
      expect(sanitizeErrorForDisplay(err)).toContain(bare);
      expect(files.has(`${DIR}/${bare}`)).toBe(true);
    }
  });

  test("delete mode keeps refusing an earlier exchange's message", async () => {
    const files = new Map<string, Buffer>([
      [`${DIR}/p1-42.json`, Buffer.alloc(42)],
    ]);
    const { client } = makeMockClient({ files });
    const conn = new FileSyncConnection(client, { verbose: -1 });
    await conn.open({ channel: "filedrop", path: DIR, options: {} });
    expect(await rejectionOf(conn.synchronize())).toBeInstanceOf(UsageError);
  });
});

describe("a partner hello nobody answered", () => {
  async function arrivalWith(
    helloAgeMs: number,
    options: FileSyncOptions,
  ): Promise<{ err: unknown; files: Map<string, Buffer> }> {
    const files = new Map<string, Buffer>([
      [`${DIR}/${hello("p1")}`, HELLO_BODY],
    ]);
    const modifyTimes = new Map([
      [`${DIR}/${hello("p1")}`, Date.now() - helloAgeMs],
    ]);
    const conn = await openParty(files, options, modifyTimes);
    const err = await rejectionOf(conn.synchronize());
    await conn.close();
    return { err, files };
  }

  test("is ignored past this side's peer timeout, and the timeout names it", async () => {
    const { err, files } = await arrivalWith(3 * 3_600_000, {
      peerTimeoutMs: 100,
    });
    expect(isPeerWaitTimeout(err)).toBe(true);
    expect(failureCauseOf(err)?.kind).toBe("partner-never-arrived");
    const rendered = sanitizeErrorForDisplay(err);
    expect(rendered).toContain(
      "At start-up this run ignored a partner hello nobody had answered for " +
        "3 hours, longer than 0.1 seconds (unanswered_hello_window_ms). " +
        "If that was your partner's run, raise unanswered_hello_window_ms or " +
        "give both sides the same peer timeout. The ignored file: " +
        hello("p1"),
    );
    expect(files.has(`${DIR}/${hello("p1")}`)).toBe(true);
  });

  test("is met as a live partner while younger than the window", async () => {
    const { err } = await arrivalWith(30_000, {
      peerTimeoutMs: 200,
      unansweredHelloWindowMs: 60_000,
    });
    // Taken for a live partner: this run acks it and waits for its answer.
    expect(sanitizeErrorForDisplay(err)).not.toContain("ignored");
  });

  test("an infinite window never ignores it", async () => {
    const { err } = await arrivalWith(30 * 86_400_000, {
      peerTimeoutMs: 200,
      unansweredHelloWindowMs: "infinite",
    });
    expect(sanitizeErrorForDisplay(err)).not.toContain("ignored");
  });
});

describe("a rerun after a bilateral-mode mismatch", () => {
  // One party in retain mode, the other not: both refuse at rendezvous and
  // leave their hellos. Then both rerun in retain mode, either at once or once
  // the leftover hellos are older than the window.
  async function rerunAfterMismatch(
    helloAgeMs: number,
  ): Promise<{ first: unknown[]; acks: string[]; rerun: unknown[] }> {
    const files = new Map<string, Buffer>();
    const modifyTimes = new Map<string, number>();
    const a = await openParty(files, {}, modifyTimes);
    const b = await openParty(files, { retainFiles: false }, modifyTimes);
    const first = await Promise.all([
      rejectionOf(a.synchronize()),
      rejectionOf(b.synchronize()),
    ]);
    await Promise.all([a.close(), b.close()]);
    const acks = [...files.keys()].filter((name) => name.endsWith("-ack.json"));
    for (const name of files.keys())
      modifyTimes.set(name, Date.now() - helloAgeMs);
    const c = await openParty(files, { peerTimeoutMs: 2_000 }, modifyTimes);
    const d = await openParty(files, { peerTimeoutMs: 2_000 }, modifyTimes);
    const rerun = await Promise.all([
      rejectionOf(c.synchronize()),
      rejectionOf(d.synchronize()),
    ]);
    await Promise.all([c.close(), d.close()]);
    return { first, acks, rerun };
  }

  test("leaves two unanswered hellos, which refuse a rerun inside the window", async () => {
    const { first, acks, rerun } = await rerunAfterMismatch(0);
    for (const err of first) expect(err).toBeInstanceOf(UsageError);
    expect(acks).toEqual([]);
    for (const err of rerun) {
      expect(err).toBeInstanceOf(UsageError);
      expect(sanitizeErrorForDisplay(err)).toContain(
        "several partner hello files are present",
      );
    }
  });

  test("a rerun once both hellos are older than the window ignores them", async () => {
    const { rerun } = await rerunAfterMismatch(3_600_000);
    expect(rerun).toEqual([undefined, undefined]);
  });
});

describe("a reused hello name", () => {
  const reused = `${DIR}/${hello("partner")}`;

  // A run into a folder holding an answered partner hello, which the entry
  // scan ignores; `midRun` then changes it while the run waits.
  async function runWhile(
    midRun: (files: Map<string, Buffer>, times: Map<string, number>) => void,
    peerTimeoutMs: number,
  ): Promise<unknown> {
    const files = new Map<string, Buffer>([
      [reused, HELLO_BODY],
      [
        `${DIR}/${ackMarkerName("earlier", stem(hello("partner")))}`,
        Buffer.alloc(0),
      ],
    ]);
    const modifyTimes = new Map([[reused, Date.now() - 86_400_000]]);
    const conn = await openParty(files, { peerTimeoutMs }, modifyTimes);
    const run = rejectionOf(conn.synchronize());
    await new Promise((resolve) => setTimeout(resolve, 30));
    midRun(files, modifyTimes);
    const err = await run;
    await conn.close();
    return err;
  }

  test("a re-stamped hello whose body is unchanged stays ignored", async () => {
    const err = await runWhile((_files, times) => {
      times.set(reused, Date.now());
    }, 300);
    expect(isPeerWaitTimeout(err)).toBe(true);
  });

  test("a partner hello written again under an ignored name stops the run", async () => {
    const rewritten = Buffer.from(HELLO_BODY);
    rewritten[rewritten.length - 2] ^= 1;
    const err = await runWhile((files, times) => {
      files.set(reused, rewritten);
      times.set(reused, Date.now());
    }, 2_000);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toBe(
      `partner hello ${hello("partner")} was written again under a name an ` +
        "earlier exchange in this folder used, so this run cannot tell it " +
        "from that exchange's files. Your partner needs fields in its " +
        "peer_id, for example %Y%m%d%H%M%S, so each run writes new names.",
    );
  });

  test("a run whose own hello name an earlier exchange answered is refused", async () => {
    const files = new Map<string, Buffer>([
      [
        `${DIR}/${ackMarkerName("partner", stem(hello("site")))}`,
        Buffer.alloc(0),
      ],
    ]);
    const conn = await openParty(files, { peerId: "site" });
    const err = await rejectionOf(conn.synchronize());
    await conn.close();
    expect(err).toBeInstanceOf(UsageError);
    expect(sanitizeErrorForDisplay(err)).toContain(
      "Add fields to peer_id, for example %Y%m%d%H%M%S, so each run writes " +
        "new names.",
    );
    expect(sanitizeErrorForDisplay(err)).toContain(
      ackMarkerName("partner", stem(hello("site"))),
    );
  });
});
