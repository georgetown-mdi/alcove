import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  SAMPLE_INVITATIONS_STORAGE_KEY,
  createdFromSampleInThisBrowser,
  recordSampleInvitation,
} from "@exchange/sampleInvitationRecord";

/** A localStorage stand-in for the node environment. */
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

const NOW = new Date("2026-10-21T12:00:00.000Z");
const IN_AN_HOUR = "2026-10-21T13:00:00.000Z";
const SAMPLE_INVITATION = "sample-invitation-code";
const REAL_INVITATION = "real-invitation-code";

let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the record of sample invitations this browser created", () => {
  test("a sample invitation this browser created is offered the sample", async () => {
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    expect(await createdFromSampleInThisBrowser(SAMPLE_INVITATION, NOW)).toBe(
      true,
    );
  });

  test("the same invitation in a browser with no record is not", async () => {
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    vi.stubGlobal("localStorage", memoryStorage());
    expect(await createdFromSampleInThisBrowser(SAMPLE_INVITATION, NOW)).toBe(
      false,
    );
  });

  test("a real invitation never is", async () => {
    expect(await createdFromSampleInThisBrowser(REAL_INVITATION, NOW)).toBe(
      false,
    );
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    expect(await createdFromSampleInThisBrowser(REAL_INVITATION, NOW)).toBe(
      false,
    );
  });

  test("keeps a digest and the expiry, never the invitation", async () => {
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    const raw = storage.getItem(SAMPLE_INVITATIONS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain(SAMPLE_INVITATION);
    expect(JSON.parse(raw)).toStrictEqual({
      v: 1,
      entries: [
        {
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          expires: IN_AN_HOUR,
        },
      ],
    });
  });

  test("an expired invitation is not offered, and its entry is dropped", async () => {
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    const later = new Date("2026-10-21T14:00:00.000Z");
    expect(await createdFromSampleInThisBrowser(SAMPLE_INVITATION, later)).toBe(
      false,
    );
    await recordSampleInvitation(
      "another-sample",
      "2026-10-21T15:00:00.000Z",
      later,
    );
    const raw = storage.getItem(SAMPLE_INVITATIONS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain(IN_AN_HOUR);
  });

  test("an accept-path lookup drops expired entries from storage", async () => {
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    await recordSampleInvitation(
      "another-sample",
      "2026-10-21T15:00:00.000Z",
      NOW,
    );
    const later = new Date("2026-10-21T14:00:00.000Z");
    expect(await createdFromSampleInThisBrowser(REAL_INVITATION, later)).toBe(
      false,
    );
    const raw = storage.getItem(SAMPLE_INVITATIONS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain(IN_AN_HOUR);
    expect(raw).toContain("2026-10-21T15:00:00.000Z");

    const muchLater = new Date("2026-10-21T16:00:00.000Z");
    expect(
      await createdFromSampleInThisBrowser("another-sample", muchLater),
    ).toBe(false);
    expect(storage.getItem(SAMPLE_INVITATIONS_STORAGE_KEY)).toBeNull();
  });

  test("a failed write-back does not change a lookup's answer", async () => {
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    await recordSampleInvitation(
      "another-sample",
      "2026-10-21T15:00:00.000Z",
      NOW,
    );
    storage.setItem = () => {
      throw new Error("quota exceeded");
    };
    const later = new Date("2026-10-21T14:00:00.000Z");
    expect(await createdFromSampleInThisBrowser("another-sample", later)).toBe(
      true,
    );
  });

  test("keeps the eight most recent, dropping the oldest", async () => {
    for (let index = 0; index < 9; index += 1)
      await recordSampleInvitation(`sample-${index}`, IN_AN_HOUR, NOW);
    expect(await createdFromSampleInThisBrowser("sample-0", NOW)).toBe(false);
    expect(await createdFromSampleInThisBrowser("sample-1", NOW)).toBe(true);
    expect(await createdFromSampleInThisBrowser("sample-8", NOW)).toBe(true);
  });

  test("a value that does not read is treated as empty", async () => {
    storage.setItem(SAMPLE_INVITATIONS_STORAGE_KEY, "{not json");
    expect(await createdFromSampleInThisBrowser(SAMPLE_INVITATION, NOW)).toBe(
      false,
    );
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    expect(await createdFromSampleInThisBrowser(SAMPLE_INVITATION, NOW)).toBe(
      true,
    );
  });

  test("stores at most the eight most recent entries, whatever a lookup reads", async () => {
    const hexDigest = async (text: string): Promise<string> => {
      const bytes = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text),
      );
      return Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    };
    for (let index = 0; index < 9; index += 1)
      await recordSampleInvitation(`stored-${index}`, IN_AN_HOUR, NOW);
    const stored = JSON.parse(
      storage.getItem(SAMPLE_INVITATIONS_STORAGE_KEY) ?? "",
    ) as { entries: Array<{ digest: string }> };
    const expected = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((index) => hexDigest(`stored-${index}`)),
    );
    expect(stored.entries).toHaveLength(8);
    expect(stored.entries.map((entry) => entry.digest)).toStrictEqual(expected);
    expect(stored.entries.map((entry) => entry.digest)).not.toContain(
      await hexDigest("stored-0"),
    );
  });

  test("stores a repeated invitation once", async () => {
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    await recordSampleInvitation("another-sample", IN_AN_HOUR, NOW);
    await recordSampleInvitation(SAMPLE_INVITATION, IN_AN_HOUR, NOW);
    const stored = JSON.parse(
      storage.getItem(SAMPLE_INVITATIONS_STORAGE_KEY) ?? "",
    ) as { entries: Array<{ digest: string }> };
    const digests = stored.entries.map((entry) => entry.digest);
    expect(digests).toHaveLength(2);
    expect(new Set(digests).size).toBe(2);
  });
});
