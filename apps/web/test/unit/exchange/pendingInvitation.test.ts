import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  clearPendingInvitation,
  readPendingInvitation,
  resumedInvitation,
  writePendingInvitation,
} from "../../../src/exchange/pendingInvitation.js";
import { generateInvitation } from "../../../src/psi/invitation.js";

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

  test("resumes only on the columns the invitation was created from", async () => {
    const minted = await mint();
    writePendingInvitation(minted, context);
    const pending = await readPendingInvitation(new Date());
    if (pending === undefined) throw new Error("no pending invitation");

    expect(
      resumedInvitation(pending, {
        rawRows: minted.rawRows,
        columns: minted.columns,
      }),
    ).toEqual(minted);
    expect(
      resumedInvitation(pending, {
        rawRows: minted.rawRows,
        columns: [...minted.columns].reverse(),
      }),
    ).toBeUndefined();
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
    ["another version", JSON.stringify({ v: 2 })],
    ["a damaged invitation", JSON.stringify({ v: 1, encoded: "x" })],
  ])("an entry that is %s is not offered and is removed", async (_, raw) => {
    storage.setItem(STORAGE_KEY, raw);
    expect(await readPendingInvitation(new Date())).toBeUndefined();
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
