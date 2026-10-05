import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CSV_LINE_BYTE_CEILING,
  MAX_ENCODED_INVITATION_LENGTH,
  MAX_TEXT_LENGTH,
} from "@alcove/core";

import {
  clearPendingInvitation,
  offerPendingInvitation,
  onInvitationExpiry,
  prunePendingInvitation,
  readPendingInvitation,
  resumeFromChosenFile,
  writePendingInvitation,
} from "../../../src/exchange/pendingInvitation.js";
import {
  deepLinkFor,
  generateInvitation,
} from "../../../src/psi/invitation.js";

import type { InvitationLocation } from "../../../src/psi/invitation.js";

const location: InvitationLocation = {
  origin: "https://example.org",
  signaling: { host: "example.org", port: 443, path: "/api/", secure: true },
};

const CSV = "first_name,last_name,dob\nAlice,Smith,1990-01-02\n";

const STORAGE_KEY = "alcove-pending-invitation";

/** A sessionStorage stand-in for the node environment. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("location", { origin: location.origin });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function mint() {
  return generateInvitation({
    inviterName: "County Health Dept",
    file: Readable.from(CSV),
    location,
  });
}

const context = { inviterName: "County Health Dept", fileName: "c.csv" };

describe("the invitation kept for a resume", () => {
  test("reads back as the minted invitation, less the rows", async () => {
    const minted = await mint();
    writePendingInvitation(minted, context);

    const stored = storage.getItem(STORAGE_KEY) ?? "";
    expect(stored).not.toContain("Alice");

    const pending = await readPendingInvitation(new Date());
    expect(pending).toBeDefined();
    const { rawRows, ...rest } = minted;
    expect(rawRows.length).toBe(1);
    expect(pending?.invitation).toEqual(rest);
    expect(pending?.inviterName).toBe(context.inviterName);
    expect(pending?.fileName).toBe(context.fileName);
  });

  async function pendingFor(minted: Awaited<ReturnType<typeof mint>>) {
    writePendingInvitation(minted, context);
    const pending = await readPendingInvitation(new Date());
    if (pending === undefined) throw new Error("no pending invitation");
    return pending;
  }

  test("the same file resumes on its rows", async () => {
    const minted = await mint();
    const pending = await pendingFor(minted);
    expect(pending.rowCount).toBe(1);

    expect(await resumeFromChosenFile(pending, Readable.from(CSV))).toEqual({
      kind: "resumed",
      invitation: minted,
    });
  });

  test.each([
    [
      "columns in another order",
      "dob,last_name,first_name\n1990-01-02,Smith,Alice\n",
    ],
    ["other columns", "first_name,last_name\nAlice,Smith\n"],
    [
      "the same columns and another number of rows",
      `${CSV}Bob,Jones,1985-03-04\n`,
    ],
  ])("a file with %s does not resume", async (_, csv) => {
    const pending = await pendingFor(await mint());
    expect(await resumeFromChosenFile(pending, Readable.from(csv))).toEqual({
      kind: "mismatch",
    });
  });

  test("a file whose parse reports a fault does not resume", async () => {
    const pending = await pendingFor(await mint());
    expect(
      await resumeFromChosenFile(
        pending,
        Readable.from('first_name,last_name,dob\n"Alice,Smith,1990-01-02\n'),
      ),
    ).toEqual({ kind: "unreadable" });
  });

  test("a single-column file, whose parse reports no delimiter, resumes", async () => {
    const pending = await pendingFor(await mint());
    const singleColumn = {
      ...pending,
      invitation: { ...pending.invitation, columns: ["ssn"] },
      rowCount: 2,
    };
    expect(
      await resumeFromChosenFile(
        singleColumn,
        Readable.from("ssn\n123-45-6789\n987-65-4321\n"),
      ),
    ).toMatchObject({ kind: "resumed" });
  });

  test("an invitation that expired after it was offered does not resume and is removed", async () => {
    const pending = await pendingFor(await mint());
    const lapsed = {
      ...pending,
      invitation: {
        ...pending.invitation,
        expires: new Date(Date.now() - 1000).toISOString(),
      },
    };
    expect(await resumeFromChosenFile(lapsed, Readable.from(CSV))).toEqual({
      kind: "expired",
    });
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("an expired invitation is not offered and is removed", async () => {
    const minted = await mint();
    writePendingInvitation(minted, context);
    const later = new Date(Date.parse(minted.expires) + 1000);
    expect(await readPendingInvitation(later)).toBeUndefined();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  test.each([
    ["not JSON", "{"],
    ["a JSON array", "[]"],
    ["a version-1 entry", JSON.stringify({ v: 1 })],
  ])("an entry that is %s is not offered and is removed", async (_, raw) => {
    storage.setItem(STORAGE_KEY, raw);
    expect(await readPendingInvitation(new Date())).toBeUndefined();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  /** The entry the writer stores for a fresh invitation, as plain fields. */
  async function writtenEntry(): Promise<Record<string, unknown>> {
    writePendingInvitation(await mint(), { ...context, csvDelimiter: ";" });
    return JSON.parse(storage.getItem(STORAGE_KEY) ?? "") as Record<
      string,
      unknown
    >;
  }

  test("the entry as written reads back", async () => {
    storage.setItem(STORAGE_KEY, JSON.stringify(await writtenEntry()));
    expect(await readPendingInvitation(new Date())).toBeDefined();
  });

  const oversized = (length: number) => "x".repeat(length + 1);

  test.each<[string, (entry: Record<string, unknown>) => void]>([
    ["is missing a member", (entry) => delete entry.fileName],
    ["holds an extra member", (entry) => (entry.rows = [])],
    [
      "holds an oversized inviter name",
      (entry) => (entry.inviterName = oversized(MAX_TEXT_LENGTH)),
    ],
    [
      "holds an oversized file name",
      (entry) => (entry.fileName = oversized(255)),
    ],
    [
      "holds an oversized column name",
      (entry) => (entry.columns = [oversized(CSV_LINE_BYTE_CEILING)]),
    ],
    [
      "holds more columns than a header line can name",
      (entry) =>
        (entry.columns = Array.from(
          { length: CSV_LINE_BYTE_CEILING / 2 + 1 },
          () => "c",
        )),
    ],
    ["holds no columns", (entry) => (entry.columns = [])],
    [
      "holds an oversized invitation",
      (entry) => {
        entry.encoded = oversized(MAX_ENCODED_INVITATION_LENGTH);
        entry.deepLink = deepLinkFor(location.origin, entry.encoded as string);
      },
    ],
    [
      "holds a deep link for another origin",
      (entry) =>
        (entry.deepLink = deepLinkFor(
          "https://elsewhere.example",
          entry.encoded as string,
        )),
    ],
    [
      "holds an invitation whose decode fails",
      (entry) => {
        entry.encoded = "AAAA";
        entry.deepLink = deepLinkFor(location.origin, "AAAA");
      },
    ],
    ["holds a fractional row count", (entry) => (entry.rowCount = 1.5)],
    ["holds a negative row count", (entry) => (entry.rowCount = -1)],
    [
      "holds a delimiter the app does not offer",
      (entry) => (entry.csvDelimiter = ";;"),
    ],
  ])("an entry that %s is not offered and is removed", async (_, damage) => {
    const entry = await writtenEntry();
    damage(entry);
    storage.setItem(STORAGE_KEY, JSON.stringify(entry));
    expect(await readPendingInvitation(new Date())).toBeUndefined();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  test.each([
    ["200 CJK characters, 592 UTF-8 bytes", "\u6587".repeat(196) + ".csv"],
    ["255 characters past the BMP", "\u{1f600}".repeat(251) + ".csv"],
  ])(
    "a file name of %s, which a file system holds, reads back",
    async (_, fileName) => {
      writePendingInvitation(await mint(), { ...context, fileName });
      expect((await readPendingInvitation(new Date()))?.fileName).toBe(
        fileName,
      );
    },
  );

  test("a resume on a 200-character CJK file name, 592 UTF-8 bytes, keeps the name", async () => {
    const fileName = "\u6587".repeat(196) + ".csv";
    writePendingInvitation(await mint(), { ...context, fileName });
    const pending = await readPendingInvitation(new Date());
    if (pending === undefined) throw new Error("no pending invitation");
    const outcome = await resumeFromChosenFile(pending, Readable.from(CSV));
    if (outcome.kind !== "resumed") throw new Error(outcome.kind);

    writePendingInvitation(outcome.invitation, { ...context, fileName });
    expect((await readPendingInvitation(new Date()))?.fileName).toBe(fileName);
  });

  test("a file name past 255 characters is not offered and is removed", async () => {
    const entry = await writtenEntry();
    entry.fileName = "\u6587".repeat(256);
    storage.setItem(STORAGE_KEY, JSON.stringify(entry));
    expect(await readPendingInvitation(new Date())).toBeUndefined();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("pruning removes an expired entry and keeps a live one", async () => {
    const minted = await mint();
    writePendingInvitation(minted, context);
    await prunePendingInvitation(new Date());
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();

    await prunePendingInvitation(new Date(Date.parse(minted.expires) + 1000));
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a deep link that does not hold the invitation is refused", async () => {
    const minted = await mint();
    writePendingInvitation(
      { ...minted, deepLink: "https://example.org/accept#other" },
      context,
    );
    expect(await readPendingInvitation(new Date())).toBeUndefined();
  });

  test("clearing removes the entry", async () => {
    writePendingInvitation(await mint(), context);
    clearPendingInvitation();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("the claim on a kept invitation", () => {
  /** Keep an invitation as a tab that could take no lock does, then give
   * this tab a lock manager that finds the lock held for its first
   * `refusals` requests; the manager's request function. */
  async function keepThenLockRefusing(refusals: number) {
    vi.stubGlobal("navigator", {});
    writePendingInvitation(await mint(), context);
    const request = vi.fn(
      (
        name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<unknown>,
      ) =>
        callback(
          request.mock.calls.length <= refusals
            ? null
            : { name, mode: "exclusive" },
        ),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    return request;
  }

  afterEach(() => {
    clearPendingInvitation();
  });

  test("is asked for again after it is found held, and the invitation is offered when the second ask is granted", async () => {
    const request = await keepThenLockRefusing(1);
    expect((await offerPendingInvitation(new Date()))?.kind).toBe("offer");
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("found held on both asks, says the invitation is open elsewhere", async () => {
    const request = await keepThenLockRefusing(2);
    expect((await offerPendingInvitation(new Date()))?.kind).toBe(
      "open-elsewhere",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("is not asked for again once granted", async () => {
    const request = await keepThenLockRefusing(0);
    expect((await offerPendingInvitation(new Date()))?.kind).toBe("offer");
    expect((await offerPendingInvitation(new Date()))?.kind).toBe("offer");
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("the expiry wait", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  afterEach(() => {
    vi.useRealTimers();
  });

  test("fires at an expiry past the longest timer, and not before", () => {
    vi.useFakeTimers();
    const expires = new Date(Date.now() + 30 * DAY_MS).toISOString();
    const onExpired = vi.fn();
    onInvitationExpiry(expires, onExpired);

    vi.advanceTimersByTime(30 * DAY_MS - 1000);
    expect(onExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onExpired).toHaveBeenCalledOnce();
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(expires));
  });

  test("fires when the page is shown after its expiry passed while hidden", () => {
    vi.useFakeTimers();
    const pageDocument = new EventTarget();
    vi.stubGlobal("document", pageDocument);
    const expires = new Date(Date.now() + 30 * DAY_MS).toISOString();
    const onExpired = vi.fn();
    onInvitationExpiry(expires, onExpired);

    // The clock moves past the expiry with no timer firing, as it does for a
    // suspended page.
    vi.setSystemTime(Date.parse(expires) + 1000);
    expect(onExpired).not.toHaveBeenCalled();
    pageDocument.dispatchEvent(new Event("visibilitychange"));
    expect(onExpired).toHaveBeenCalledOnce();
  });

  test("does not fire once stopped", () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const stop = onInvitationExpiry(
      new Date(Date.now() + 1000).toISOString(),
      onExpired,
    );
    stop();
    vi.advanceTimersByTime(2000);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
