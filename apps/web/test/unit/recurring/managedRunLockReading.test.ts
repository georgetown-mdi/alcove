import { describe, expect, test } from "vitest";

import {
  MANAGED_RUN_LOCK_READING_INITIAL,
  managedRunLockReadingReducer,
  managedRunLockReadsHeld,
} from "@recurring/managedRunLockReading";

import type {
  ManagedRunLockReading,
  ManagedRunLockReadingEvent,
} from "@recurring/managedRunLockReading";

function fold(
  events: ReadonlyArray<ManagedRunLockReadingEvent>,
  from: ManagedRunLockReading = MANAGED_RUN_LOCK_READING_INITIAL,
): ManagedRunLockReading {
  return events.reduce(managedRunLockReadingReducer, from);
}

describe("the run lock's reading", () => {
  test("starts free", () => {
    expect(managedRunLockReadsHeld(MANAGED_RUN_LOCK_READING_INITIAL)).toBe(
      false,
    );
  });

  test("follows the poll's readings", () => {
    const held = fold([{ type: "read", held: true, refusalsBefore: 0 }]);
    expect(managedRunLockReadsHeld(held)).toBe(true);
    expect(
      managedRunLockReadsHeld(
        fold([{ type: "read", held: false, refusalsBefore: 0 }], held),
      ),
    ).toBe(false);
  });
});

describe("an export the lock refused", () => {
  const refused = fold([
    { type: "read", held: false, refusalsBefore: 0 },
    { type: "refused", refusal: 1 },
  ]);

  test("reads as held while no poll reading has answered it", () => {
    expect(managedRunLockReadsHeld(refused)).toBe(true);
  });

  test("clears on the next reading begun after it, once that reading finds the lock free", () => {
    // The short hold the poll never saw: the reason goes on the next tick rather
    // than standing until the poll's reading changes, which it never does.
    const next = fold(
      [{ type: "read", held: false, refusalsBefore: 1 }],
      refused,
    );
    expect(managedRunLockReadsHeld(next)).toBe(false);
  });

  test("stays held where the next reading finds the run still holding the lock", () => {
    const next = fold(
      [{ type: "read", held: true, refusalsBefore: 1 }],
      refused,
    );
    expect(managedRunLockReadsHeld(next)).toBe(true);
    expect(next.refusal).toBeUndefined();
  });

  test("is not cleared by a reading begun before it, which may predate the hold", () => {
    const stale = fold(
      [{ type: "read", held: false, refusalsBefore: 0 }],
      refused,
    );
    expect(managedRunLockReadsHeld(stale)).toBe(true);
  });

  test("a second refusal stands until a reading begun after it", () => {
    const twice = fold([{ type: "refused", refusal: 2 }], refused);
    expect(
      managedRunLockReadsHeld(
        fold([{ type: "read", held: false, refusalsBefore: 1 }], twice),
      ),
    ).toBe(true);
    expect(
      managedRunLockReadsHeld(
        fold([{ type: "read", held: false, refusalsBefore: 2 }], twice),
      ),
    ).toBe(false);
  });
});
