import { expect, test } from "vitest";

import {
  groupDuplicatesAndRemoveUndefineds,
  removeDuplicatesAndUndefineds,
  RoundSetCounter,
} from "../../src/psi/link";

import type { KeyCandidates } from "../../src/standardization";

// The first-round check counts through RoundSetCounter rather than building the
// round's set, so the counter must reach the size the round's own set has.

function counted(
  rows: ReadonlyArray<KeyCandidates>,
  keepsDuplicates: boolean,
): number {
  const counter = new RoundSetCounter(keepsDuplicates);
  rows.forEach((candidates, row) => counter.add(row, candidates));
  return counter.size;
}

// A small alphabet over many rows, so values recur within and across rows.
function randomRows(seed: number, rowCount: number): Array<KeyCandidates> {
  let state = seed;
  const next = (bound: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % bound;
  };
  const value = () => String.fromCharCode(97 + next(12));
  return Array.from({ length: rowCount }, (): KeyCandidates => {
    const shape = next(4);
    if (shape === 0) return undefined;
    if (shape === 1) return value();
    return new Set(Array.from({ length: 1 + next(3) }, value));
  });
}

test("the counter reaches the size of the set each deduplication builds", () => {
  for (let seed = 1; seed <= 200; ++seed) {
    const rows = randomRows(seed, 1 + (seed % 17));
    expect(counted(rows, false)).toBe(
      removeDuplicatesAndUndefineds(rows)[0].length,
    );
    expect(counted(rows, true)).toBe(
      groupDuplicatesAndRemoveUndefineds(rows)[0].length,
    );
  }
});

test("the size only grows where duplicates are kept", () => {
  const dropping = new RoundSetCounter(false);
  dropping.add(0, "a");
  dropping.add(1, "a");
  expect(dropping.sizeOnlyGrows).toBe(false);
  expect(dropping.size).toBe(0);

  const keeping = new RoundSetCounter(true);
  keeping.add(0, "a");
  keeping.add(1, "a");
  expect(keeping.sizeOnlyGrows).toBe(true);
  expect(keeping.size).toBe(1);
});
