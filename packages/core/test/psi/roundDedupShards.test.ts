import { expect, test } from "vitest";

import {
  groupDuplicatesAndRemoveUndefineds,
  removeDuplicatesAndUndefineds,
  RoundSetCounter,
} from "../../src/psi/link";
import { MAX_MAP_SHARD_ENTRIES, ShardedMap } from "../../src/psi/shardedMap";

import type { KeyCandidates } from "../../src/standardization";

// The round's deduplication stores its values in shards of at most
// MAX_MAP_SHARD_ENTRIES, the entries one V8 Map holds. The shard bound is
// lowered here so a handful of values spans several shards; the run past the
// real bound is test/stress/roundDedupPastMapLimit.stress.test.ts.

const SHARD = 2;

test("a shard holds as many entries as one V8 Map", () => {
  expect(MAX_MAP_SHARD_ENTRIES).toBe(2 ** 24);
});

test("the sharded map keeps insertion order and updates a key in its own shard", () => {
  const map = new ShardedMap<string, number>(SHARD);
  for (const [i, key] of ["a", "b", "c", "d", "e"].entries()) map.set(key, i);
  map.set("a", 10);
  map.set("d", 30);
  expect(map.size).toBe(5);
  expect(map.get("a")).toBe(10);
  expect(map.get("e")).toBe(4);
  expect(map.get("f")).toBeUndefined();
  const entries: Array<[string, number]> = [];
  map.forEach((value, key) => entries.push([key, value]));
  expect(entries).toStrictEqual([
    ["a", 10],
    ["b", 1],
    ["c", 2],
    ["d", 30],
    ["e", 4],
  ]);
});

test("dropping deduplication keeps row-major order across shards", () => {
  const rows: Array<KeyCandidates> = [
    new Set(["b", "a"]),
    "c",
    undefined,
    new Set(["e", "d"]),
    "f",
  ];
  expect(removeDuplicatesAndUndefineds(rows, undefined, SHARD)).toStrictEqual([
    ["b", "a", "c", "e", "d", "f"],
    [0, 0, 1, 3, 3, 4],
  ]);
});

test("dropping deduplication drops a value recurring across a shard boundary", () => {
  // "a" sits in the first shard and recurs after the third has opened.
  const rows: Array<KeyCandidates> = ["a", "b", "c", undefined, "d", "e", "a"];
  expect(
    removeDuplicatesAndUndefineds(rows, [9, 8, 7, 6, 5, 4, 3], SHARD),
  ).toStrictEqual([
    ["b", "c", "d", "e"],
    [8, 7, 5, 4],
  ]);
});

test("grouping deduplication groups rows across a shard boundary, in order", () => {
  const rows: Array<KeyCandidates> = [
    "a",
    "b",
    undefined,
    "c",
    new Set(["d", "a"]),
    "e",
    "c",
    undefined,
  ];
  const [values, candidates] = groupDuplicatesAndRemoveUndefineds(
    rows,
    undefined,
    SHARD,
  );
  expect(values).toStrictEqual(["a", "b", "c", "d", "e"]);
  expect(candidates).toStrictEqual({
    rows: [0, 4, 1, 3, 6, 4, 5],
    groupStarts: [0, 2, 3, 5, 6, 7],
  });
});

// A small alphabet over many rows, so values recur within and across rows and
// the lowered shard bound splits the values at every point.
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

// Both candidate lists written the plain way: one Map, one list per value.
function referenceLists(
  rows: ReadonlyArray<KeyCandidates>,
  permutation: ReadonlyArray<number>,
): {
  dropped: [Array<string>, Array<number>];
  grouped: [Array<string>, { rows: Array<number>; groupStarts: Array<number> }];
} {
  const groups = new Map<string, Array<number>>();
  rows.forEach((candidates, i) => {
    if (candidates === undefined) return;
    const values = typeof candidates === "string" ? [candidates] : candidates;
    for (const value of values) {
      const group = groups.get(value) ?? [];
      groups.set(value, group);
      if (group[group.length - 1] !== permutation[i])
        group.push(permutation[i]);
    }
  });
  const single = [...groups].filter(([, group]) => group.length === 1);
  const groupStarts = [0];
  for (const group of groups.values())
    groupStarts.push(groupStarts[groupStarts.length - 1] + group.length);
  return {
    dropped: [single.map(([value]) => value), single.map(([, [row]]) => row)],
    grouped: [
      [...groups.keys()],
      { rows: [...groups.values()].flat(), groupStarts },
    ],
  };
}

test("every shard bound builds the lists one plain Map builds", () => {
  for (let seed = 1; seed <= 200; ++seed) {
    const rows = randomRows(seed, 1 + (seed % 23));
    const permutation = rows.map((_unused, i) => 100 + 2 * i);
    const { dropped, grouped } = referenceLists(rows, permutation);
    for (const shard of [1, 2, 3, 5, MAX_MAP_SHARD_ENTRIES]) {
      expect(
        removeDuplicatesAndUndefineds(rows, permutation, shard),
      ).toStrictEqual(dropped);
      expect(
        groupDuplicatesAndRemoveUndefineds(rows, permutation, shard),
      ).toStrictEqual(grouped);
      for (const keepsDuplicates of [false, true]) {
        const counter = new RoundSetCounter(keepsDuplicates, shard);
        rows.forEach((candidates, row) => counter.add(row, candidates));
        expect(counter.size).toBe(
          keepsDuplicates ? grouped[0].length : dropped[0].length,
        );
      }
    }
  }
});
