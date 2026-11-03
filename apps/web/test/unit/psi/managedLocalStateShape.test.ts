import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MANAGED_LOCAL_STATE_VERSION,
  parseManagedLocalState,
  parseManagedLocalStateEntries,
  partitionReadableManagedLocalState,
  storableManagedLocalState,
} from "@psi/managed/managedLocalStateShape";

import { getLogger } from "@alcove/core";

import type { MockInstance } from "vitest";

const markers = {
  backup: { backedUpAt: "2026-09-01T00:00:00.000Z" },
  imported: { importedAt: "2026-08-31T00:00:00.000Z" },
};

let warn: MockInstance;

beforeEach(() => {
  warn = vi
    .spyOn(getLogger("managedLocalState"), "warn")
    .mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function warned(): string {
  return warn.mock.calls.flat().join(" ");
}

describe("an entry at the current version", () => {
  test("is what every write stores, and reads back without its version", () => {
    const stored = storableManagedLocalState(markers);

    expect(stored).toEqual({
      version: MANAGED_LOCAL_STATE_VERSION,
      ...markers,
    });
    expect(parseManagedLocalState(stored)).toEqual(markers);
    expect(warn).not.toHaveBeenCalled();
  });

  test("still refuses an unknown member or a malformed instant", () => {
    for (const raw of [
      { version: MANAGED_LOCAL_STATE_VERSION, ...markers, smuggled: true },
      {
        version: MANAGED_LOCAL_STATE_VERSION,
        imported: { importedAt: "yesterday" },
      },
    ])
      expect(() => parseManagedLocalState(raw)).toThrow();
  });

  test("is refused at write when the state would not read back", () => {
    expect(() =>
      storableManagedLocalState({ backup: { backedUpAt: "yesterday" } }),
    ).toThrow();
  });
});

describe("an unversioned entry", () => {
  test("is read as the current version", () => {
    expect(parseManagedLocalState(markers)).toEqual(markers);
    expect(warn).not.toHaveBeenCalled();
  });

  test("is held to the current schema, so a handed-off state is still refused", () => {
    expect(() =>
      parseManagedLocalState({
        ...markers,
        spent: { spentAt: "2026-09-02T00:00:00.000Z", handoff: "command-line" },
      }),
    ).toThrow();
  });
});

describe("an entry a newer build wrote", () => {
  const newer = {
    version: MANAGED_LOCAL_STATE_VERSION + 1,
    ...markers,
    retake: { at: "2026-09-02T00:00:00.000Z" },
  };

  test("is discarded, read as absent, with the cause named", () => {
    expect(parseManagedLocalState(newer)).toBeUndefined();
    expect(warned()).toContain("a newer version of this app saved it");
  });

  test("is left out of the attended list read rather than failing it", () => {
    const states = parseManagedLocalStateEntries(
      ["newer", "current"],
      [newer, storableManagedLocalState(markers)],
    );

    expect([...states.keys()]).toEqual(["current"]);
  });

  test("is neither a state nor unreadable to the unattended read", () => {
    const read = partitionReadableManagedLocalState(["newer"], [newer]);

    expect(read.states.size).toBe(0);
    expect(read.unreadableIds).toEqual([]);
  });

  test("is named by its key in the warning from a key-holding read", () => {
    parseManagedLocalStateEntries(["exchange-a"], [newer]);
    expect(warned()).toContain("exchange-a");

    warn.mockClear();
    partitionReadableManagedLocalState(["exchange-b"], [newer]);
    expect(warned()).toContain("exchange-b");
    expect(warned()).toContain("a newer version of this app saved it");

    warn.mockClear();
    parseManagedLocalState(newer, "exchange-c");
    expect(warned()).toContain("exchange-c");
  });
});

describe("an entry at a version that does not order after the current one", () => {
  test("is discarded with its own cause", () => {
    for (const version of [0, "1", "alcove-managed-local-state/v1", null]) {
      warn.mockClear();
      expect(parseManagedLocalState({ version, ...markers })).toBeUndefined();
      expect(warned()).toContain(
        "this version of the app does not read its format version",
      );
    }
  });
});

describe("a value that is not an entry", () => {
  test("is refused by the strict reads and skipped by the unattended one", () => {
    for (const raw of [null, "not state", [markers]])
      expect(() => parseManagedLocalState(raw)).toThrow();

    const read = partitionReadableManagedLocalState(
      ["damaged", "current"],
      ["not state", storableManagedLocalState(markers)],
    );

    expect(read.unreadableIds).toEqual(["damaged"]);
    expect([...read.states.keys()]).toEqual(["current"]);
  });

  test("nothing stored reads as absent", () => {
    expect(parseManagedLocalState(undefined)).toBeUndefined();
  });
});
