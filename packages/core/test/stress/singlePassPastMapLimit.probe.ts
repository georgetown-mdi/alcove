// One single-pass structure driven past the entries one V8 Map holds, run in
// its own process so its peak resident set is its own:
// `singlePassPastMapLimit.stress.test.ts` spawns it once per case and reads
// the one JSON line it prints.
//
// Usage: node --max-old-space-size=<MiB> --import tsx singlePassPastMapLimit.probe.ts <case> <entries>

import { performance } from "node:perf_hooks";

import {
  getDistinctValuesAndIndices,
  MatchedValues,
  replaySinglePassCascade,
  roundValueFirstRows,
  type KeyCells,
} from "../../src/psi/link";
import { MAX_SINGLE_PASS_SET_ELEMENTS } from "../../src/connection/frameSize";

export const PROBE_CASES = [
  "distinctValues",
  "firstRows",
  "oneToOneReplay",
  "manyToManyReplay",
  "receiverGroupsReplay",
  "senderGroupsReplay",
] as const;
export type ProbeCase = (typeof PROBE_CASES)[number];

export interface ProbeResult {
  readonly probe: ProbeCase;
  readonly entries: number;
  readonly holds: boolean;
  readonly error?: string;
  readonly elapsedMs: number;
  readonly maxRssMiB: number;
}

// One value a row: row `row` holds `row % distinct`.
function cyclicCells(distinct: number): KeyCells {
  return { count: () => 1, valueAt: (row) => row % distinct };
}

function identityMatches(count: number): MatchedValues {
  const ids = new Int32Array(count);
  for (let k = 0; k < count; ++k) ids[k] = k;
  return MatchedValues.of(ids, ids);
}

// `entries` distinct values and a last row repeating the first, which finds
// the first shard's id from past the boundary.
function distinctValues(entries: number): boolean {
  const rows = Array.from({ length: entries }, (_unused, i) => i.toString(36));
  rows.push(rows[0]);
  const { distinctValues, columns } = getDistinctValuesAndIndices(
    [rows],
    false,
    [1],
    MAX_SINGLE_PASS_SET_ELEMENTS,
  );
  const column = columns[0];
  return (
    distinctValues.length === entries &&
    !column.ragged &&
    column.indices[entries - 1] === entries - 1 &&
    column.indices[entries] === 0
  );
}

function firstRows(entries: number): boolean {
  const { firstRow, recurring } = roundValueFirstRows(
    cyclicCells(entries),
    entries + 1,
    new Uint8Array(entries + 1),
  );
  return (
    firstRow.size === entries &&
    firstRow.get(entries - 1) === entries - 1 &&
    recurring.size === 1 &&
    recurring.has(0)
  );
}

// Every value on one row of each side: the receiver's and the sender's
// first-row maps hold one entry a value.
function oneToOneReplay(entries: number): boolean {
  const { table } = replaySinglePassCascade(
    [cyclicCells(entries)],
    [cyclicCells(entries)],
    identityMatches(entries),
    entries,
    entries,
    { localKeepsDuplicates: false, partnerKeepsDuplicates: false },
  );
  return table[0].length === entries && table[1][entries - 1] === entries - 1;
}

// One block a matched value.
function manyToManyReplay(entries: number): boolean {
  const { table, closure } = replaySinglePassCascade(
    [cyclicCells(entries)],
    [cyclicCells(entries)],
    identityMatches(entries),
    entries,
    entries,
    { localKeepsDuplicates: true, partnerKeepsDuplicates: true },
  );
  const last = closure?.blocks[entries - 1];
  return (
    table[0].length === entries &&
    closure?.blocks.length === entries &&
    last?.localRows[0] === entries - 1 &&
    last.partnerRows[0] === entries - 1
  );
}

// Every value on two receiver rows: one group of two a value.
function receiverGroupsReplay(entries: number): boolean {
  const { table } = replaySinglePassCascade(
    [cyclicCells(entries)],
    [cyclicCells(entries)],
    identityMatches(entries),
    2 * entries,
    entries,
    { localKeepsDuplicates: true, partnerKeepsDuplicates: false },
  );
  const last = 2 * entries - 1;
  return (
    table[0].length === 2 * entries &&
    table[0][last] === last &&
    table[1][last] === entries - 1
  );
}

// Every value on two sender rows: a further sender row for every receiver row.
function senderGroupsReplay(entries: number): boolean {
  const { table } = replaySinglePassCascade(
    [cyclicCells(entries)],
    [cyclicCells(entries)],
    identityMatches(entries),
    entries,
    2 * entries,
    { localKeepsDuplicates: false, partnerKeepsDuplicates: true },
  );
  const last = 2 * entries - 1;
  return (
    table[0].length === 2 * entries &&
    table[0][last] === entries - 1 &&
    table[1][last] === last
  );
}

function run(probe: ProbeCase, entries: number): boolean {
  switch (probe) {
    case "distinctValues":
      return distinctValues(entries);
    case "firstRows":
      return firstRows(entries);
    case "oneToOneReplay":
      return oneToOneReplay(entries);
    case "manyToManyReplay":
      return manyToManyReplay(entries);
    case "receiverGroupsReplay":
      return receiverGroupsReplay(entries);
    case "senderGroupsReplay":
      return senderGroupsReplay(entries);
  }
}

const [probe, entriesArg] = process.argv.slice(2);
if (!PROBE_CASES.includes(probe as ProbeCase) || !entriesArg)
  throw new Error(`usage: <${PROBE_CASES.join("|")}> <entries>`);
const entries = Number(entriesArg);
const start = performance.now();
let result: Omit<ProbeResult, "elapsedMs" | "maxRssMiB">;
try {
  result = {
    probe: probe as ProbeCase,
    entries,
    holds: run(probe as ProbeCase, entries),
  };
} catch (error) {
  result = {
    probe: probe as ProbeCase,
    entries,
    holds: false,
    error: String(error),
  };
}
console.log(
  JSON.stringify({
    ...result,
    elapsedMs: Math.round(performance.now() - start),
    maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  }),
);
