import { describe, expect, test } from "vitest";

import {
  MANAGED_STORE_READS_INITIAL,
  managedStoreReadsReducer,
  managedUnrecordedRunFlagged,
} from "@recurring/managedSurfaceReadsModel";

import type {
  ManagedStoreReadAction,
  ManagedStoreReads,
} from "@recurring/managedSurfaceReadsModel";

function fold(
  actions: ReadonlyArray<ManagedStoreReadAction>,
  from: ManagedStoreReads = MANAGED_STORE_READS_INITIAL,
): ManagedStoreReads {
  return actions.reduce(managedStoreReadsReducer, from);
}

const answered = fold([
  { type: "accounting-read", read: { kind: "none" } },
  { type: "unfiled-disclosures-read", read: { kind: "unreadable" } },
  { type: "parked-results-read", read: { kind: "unavailable" } },
]);

describe("the store reads", () => {
  test("start with every read under way and none asked for again", () => {
    expect(MANAGED_STORE_READS_INITIAL).toEqual({
      accounting: { reads: 0, read: undefined },
      unfiled: undefined,
      parkedResults: { reads: 0, read: undefined },
      flaggedUnrecordedId: undefined,
    });
  });

  test("each read lands on its own section", () => {
    expect(answered).toEqual({
      accounting: { reads: 0, read: { kind: "none" } },
      unfiled: { kind: "unreadable" },
      parkedResults: { reads: 0, read: { kind: "unavailable" } },
      flaggedUnrecordedId: undefined,
    });
  });

  test("a read landing again replaces the one on screen", () => {
    const again = fold(
      [{ type: "accounting-read", read: { kind: "unavailable" } }],
      answered,
    );
    expect(again.accounting.read).toEqual({ kind: "unavailable" });
  });
});

describe("asking for a read again", () => {
  test("the accounting drops its verdict and the shortfall's, and counts the read", () => {
    const requested = fold([{ type: "accounting-read-requested" }], answered);
    expect(requested.accounting).toEqual({ reads: 1, read: undefined });
    expect(requested.unfiled).toBeUndefined();
    expect(requested.parkedResults).toBe(answered.parkedResults);
  });

  test("the parked results drop their verdict and count the read", () => {
    const requested = fold(
      [{ type: "parked-results-read-requested" }],
      answered,
    );
    expect(requested.parkedResults).toEqual({ reads: 1, read: undefined });
    expect(requested.accounting).toBe(answered.accounting);
    expect(requested.unfiled).toBe(answered.unfiled);
  });

  test("each request counts once more", () => {
    const twice = fold([
      { type: "accounting-read-requested" },
      { type: "accounting-read-requested" },
      { type: "parked-results-read-requested" },
    ]);
    expect(twice.accounting.reads).toBe(2);
    expect(twice.parkedResults.reads).toBe(1);
  });
});

describe("the unrecorded-run flag", () => {
  test("is shown for the exchange it was found on", () => {
    const flagged = fold([{ type: "unrecorded-run-flagged", id: "abc" }]);
    expect(managedUnrecordedRunFlagged(flagged, "abc")).toBe(true);
    expect(managedUnrecordedRunFlagged(flagged, "other")).toBe(false);
  });

  test("is not shown before a read finds it", () => {
    expect(
      managedUnrecordedRunFlagged(MANAGED_STORE_READS_INITIAL, "abc"),
    ).toBe(false);
  });

  test("stays shown across a re-read of the accounting", () => {
    const reread = fold([
      { type: "unrecorded-run-flagged", id: "abc" },
      { type: "accounting-read-requested" },
      { type: "unfiled-disclosures-read", read: { kind: "none" } },
    ]);
    expect(managedUnrecordedRunFlagged(reread, "abc")).toBe(true);
  });

  test("found again returns the same state", () => {
    const flagged = fold([{ type: "unrecorded-run-flagged", id: "abc" }]);
    expect(
      managedStoreReadsReducer(flagged, {
        type: "unrecorded-run-flagged",
        id: "abc",
      }),
    ).toBe(flagged);
  });
});
