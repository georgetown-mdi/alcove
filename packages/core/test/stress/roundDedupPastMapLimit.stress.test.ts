import { afterAll, expect, test } from "vitest";

import {
  groupDuplicatesAndRemoveUndefineds,
  removeDuplicatesAndUndefineds,
  RoundSetCounter,
} from "../../src/psi/link";
import { MAX_MAP_SHARD_ENTRIES } from "../../src/psi/shardedMap";

// A round's deduplication past the entries one V8 Map holds: 2^24 + 1
// distinct values, so the last opens a second shard, and a final row repeating
// the first value, so a value recurs across the shard boundary. Each case logs
// its time and the file its peak RSS. Several GB of heap and tens of seconds,
// which is why it is the opt-in tier.

const DISTINCT = MAX_MAP_SHARD_ENTRIES + 1;
const rows: Array<string> = Array.from({ length: DISTINCT }, (_unused, i) =>
  i.toString(36),
);
rows.push(rows[0]);

function timed<T>(label: string, run: () => T): T {
  const startedAt = performance.now();
  const result = run();
  console.log(
    `${label} over ${DISTINCT} distinct values: ` +
      `${Math.round(performance.now() - startedAt)} ms`,
  );
  return result;
}

afterAll(() => {
  const peakMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(`round deduplication stress: peak RSS ${peakMiB} MiB`);
});

test("a raw Map throws on the entry past one shard", () => {
  const map = new Map<number, number>();
  for (let i = 0; i < MAX_MAP_SHARD_ENTRIES; i++) map.set(i, i);
  expect(() => map.set(MAX_MAP_SHARD_ENTRIES, 0)).toThrow(RangeError);
});

test("dropping deduplication completes past one shard, in row order", () => {
  const [values, originalIndices] = timed("dropping deduplication", () =>
    removeDuplicatesAndUndefineds(rows),
  );
  expect(values.length).toBe(DISTINCT - 1);
  expect(originalIndices.length).toBe(DISTINCT - 1);
  let inOrder = true;
  for (let k = 0; k < values.length; ++k)
    if (values[k] !== rows[k + 1] || originalIndices[k] !== k + 1)
      inOrder = false;
  expect(inOrder).toBe(true);
});

test("grouping deduplication completes past one shard, in row order", () => {
  const [values, candidates] = timed("grouping deduplication", () =>
    groupDuplicatesAndRemoveUndefineds(rows),
  );
  expect(values.length).toBe(DISTINCT);
  expect(values[DISTINCT - 1]).toBe(rows[DISTINCT - 1]);
  expect(candidates.rows.slice(0, 3)).toStrictEqual([0, DISTINCT, 1]);
  expect(candidates.groupStarts?.slice(0, 3)).toStrictEqual([0, 2, 3]);
  expect(candidates.groupStarts?.at(-1)).toBe(DISTINCT + 1);
});

test("the counter completes past one shard", () => {
  for (const keepsDuplicates of [false, true]) {
    const size = timed(
      `counting (keepsDuplicates ${String(keepsDuplicates)})`,
      () => {
        const counter = new RoundSetCounter(keepsDuplicates);
        rows.forEach((value, row) => counter.add(row, value));
        return counter.size;
      },
    );
    expect(size).toBe(keepsDuplicates ? DISTINCT : DISTINCT - 1);
  }
});
