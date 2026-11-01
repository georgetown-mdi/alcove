import { expect } from "vitest";

import PSI from "@openmined/psi.js";

import { linkViaSinglePassPSI } from "../../src/psi/link";
import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import type { AssociationTable } from "../../src/types";
import {
  candidateSetBounds,
  declaredKeyWidths,
  type Column,
} from "./candidateSetBounds";
import { fixedKeyPsiLibrary, psiTestKey } from "./fixedKeyPsiLibrary";
import { greedySwitch } from "./greedyRoundSweep";
import {
  firstLargestPairing,
  largestPairingSize,
  type Pair,
} from "./largestPairingOracle";
import { readPartFrame } from "./matchedListPartFrames";
import { recordingConnection } from "./recordingConnection";
import { makeParticipant, runCascade, tablesOf } from "./support";

// The one-to-one resolution against the greedy sweep it replaced, run through
// the whole protocol over every input up to a stated size. A test file mocks
// the round-resolution module with `withGreedySwitch` (greedyRoundSweep.ts), so
// the sweep both strategies call answers from either rule, and runs each input
// under both with nothing else changed.

/** The records on each side of every input. */
export const RECORDS = 3;

// Fixed keys, so two runs of one input put the same bytes on the wire wherever
// the protocol computes the same thing.
const psiLibrary = fixedKeyPsiLibrary(
  await PSI(),
  psiTestKey(0x11),
  psiTestKey(0x22),
);

// One input: a first-round candidate pair set, as (written starter row,
// written joiner row), and each side's key columns.
interface Input {
  readonly pairs: Array<Pair>;
  readonly first: Array<Column>;
  readonly second: Array<Column>;
}

function cell(values: Array<string>): string | Set<string> | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : new Set(values);
}

// Every candidate pair set on RECORDS records a side, written as the first
// key's candidate sets with one value per pair, so no value is dropped for
// ambiguity and the round's candidate pairs are exactly the set. A second key
// pairs record i with record i on each side, so the records the first round
// leaves in candidacy meet a later round.
function everyInput(): Array<Input> {
  const grid: Array<Pair> = [];
  for (let a = 0; a < RECORDS; ++a)
    for (let b = 0; b < RECORDS; ++b) grid.push([a, b]);
  const late = Array.from({ length: RECORDS }, (_, i) => `late${i}`);
  const inputs: Array<Input> = [];
  for (let mask = 0; mask < 1 << grid.length; ++mask) {
    const pairs = grid.filter((_, i) => (mask & (1 << i)) !== 0);
    const value = ([a, b]: Pair) => `p${a}${b}`;
    const first: Column = [];
    const second: Column = [];
    for (let r = 0; r < RECORDS; ++r) {
      first.push(cell(pairs.filter(([a]) => a === r).map(value)));
      second.push(cell(pairs.filter(([, b]) => b === r).map(value)));
    }
    inputs.push({ pairs, first: [first, late], second: [second, late] });
  }
  return inputs;
}

/** A linkage strategy the differential runs. */
export type Strategy = "cascade" | "single-pass";

interface Run {
  // The starter's table, as (starter row, joiner row) pairs in ascending order.
  readonly table: Array<Pair>;
  readonly starterSent: Array<unknown>;
  readonly joinerSent: Array<unknown>;
}

function pairsOf(table: AssociationTable): Array<Pair> {
  return table[0]
    .map((local, i): Pair => [local, table[1][i]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

async function run(
  strategy: Strategy,
  starterKeys: Array<Column>,
  joinerKeys: Array<Column>,
): Promise<Run> {
  let starterSent: Array<unknown> = [];
  let joinerSent: Array<unknown> = [];
  const record = {
    starter: (conn: MessageConnection) => {
      const recorder = recordingConnection(conn);
      starterSent = recorder.sent;
      return recorder.conn;
    },
    joiner: (conn: MessageConnection) => {
      const recorder = recordingConnection(conn);
      joinerSent = recorder.sent;
      return recorder.conn;
    },
  };
  let starter: AssociationTable;
  let joiner: AssociationTable;
  if (strategy === "cascade") {
    ({ starter, joiner } = tablesOf(
      await runCascade({
        library: psiLibrary,
        starterKeys,
        joinerKeys,
        wrap: record,
      }),
    ));
  } else {
    const [starterConn, joinerConn] = createMessagePipe();
    const keyWidths = declaredKeyWidths(starterKeys, joinerKeys);
    [starter, joiner] = await Promise.all([
      linkViaSinglePassPSI(
        { cardinality: "one-to-one" },
        makeParticipant(psiLibrary, "starter"),
        record.starter(starterConn),
        starterKeys,
        {
          ...candidateSetBounds(joinerKeys[0].length, keyWidths),
          localFanOutFactor: 1,
        },
        false,
        -1,
      ),
      linkViaSinglePassPSI(
        { cardinality: "one-to-one" },
        makeParticipant(psiLibrary, "joiner"),
        record.joiner(joinerConn),
        joinerKeys,
        {
          ...candidateSetBounds(starterKeys[0].length, keyWidths),
          localFanOutFactor: 1,
        },
        false,
        -1,
      ),
    ]);
    await starterConn.close();
  }
  expect(pairsOf([joiner[1], joiner[0]])).toStrictEqual(pairsOf(starter));
  return { table: pairsOf(starter), starterSent, joinerSent };
}

// One input in one role assignment.
interface Case {
  readonly input: number;
  readonly swapped: boolean;
  readonly starterKeys: Array<Column>;
  readonly joinerKeys: Array<Column>;
  // The first round's candidate pairs, as (starter row, joiner row).
  readonly firstRound: Array<Pair>;
}

function casesOf(inputs: ReadonlyArray<Input>): Array<Case> {
  const cases: Array<Case> = [];
  inputs.forEach((input, index) => {
    for (const swapped of [false, true])
      cases.push({
        input: index,
        swapped,
        starterKeys: swapped ? input.second : input.first,
        joinerKeys: swapped ? input.first : input.second,
        firstRound: swapped
          ? input.pairs.map(([a, b]): Pair => [b, a])
          : input.pairs,
      });
  });
  return cases;
}

// Runs under one rule at a time, so the rule a sweep answers from is the one
// every run in flight was started under.
async function runAll(
  greedy: boolean,
  strategy: Strategy,
  cases: ReadonlyArray<Case>,
): Promise<Array<Run>> {
  greedySwitch.greedy = greedy;
  try {
    return await Promise.all(
      cases.map((c) => run(strategy, c.starterKeys, c.joinerKeys)),
    );
  } finally {
    greedySwitch.greedy = false;
  }
}

// Cases run together, a working bound on the runs in flight at once.
const BATCH = 64;

// A frame as the bytes it is compared by.
function bytesOf(frame: unknown): string {
  if (frame instanceof Uint8Array) return Buffer.from(frame).toString("hex");
  return JSON.stringify(frame, (_, value: unknown) =>
    value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value,
  );
}

// A frame's fields without their values: a part frame's body, or the frame
// itself, as the keys of each object and the types of each leaf.
function shapeOf(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    const part = readPartFrame(value);
    return part === undefined ? "bytes" : { part: shapeOf(part.body) };
  }
  if (Array.isArray(value))
    return [...new Set(value.map((v) => JSON.stringify(shapeOf(v))))].sort();
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, shapeOf(v)]),
    );
  return typeof value;
}

// Whether a frame is built from the association table, judged by its kind: a
// part of the cascade's mapped-element lists, whose entries name partner
// positions, or the single-pass receiver's returned table, two lists of row
// indices sent as one frame. A list that is empty under both rules is neither,
// and is compared by its bytes.
function isBuiltFromTable(strategy: Strategy, frame: unknown): boolean {
  if (strategy === "single-pass")
    return (
      Array.isArray(frame) &&
      frame.length === 2 &&
      frame.every((half) => Array.isArray(half))
    );
  const body = readPartFrame(frame)?.body;
  return (
    Array.isArray(body) &&
    body.some(
      (entry) =>
        typeof entry === "object" && entry !== null && "theirIndex" in entry,
    )
  );
}

// The frames one party sent under the two rules: the same number, each built
// from the table at the same place, every frame not built from the table the
// same bytes wherever it falls, every later round's sets included, and the
// table-built frames the same fields.
function expectFramesAgreeOutsideTheTable(
  strategy: Strategy,
  largest: Array<unknown>,
  greedy: Array<unknown>,
  where: string,
): void {
  expect(largest.length, where).toBe(greedy.length);
  const fromTable = largest.map((frame) => isBuiltFromTable(strategy, frame));
  expect(
    greedy.map((frame) => isBuiltFromTable(strategy, frame)),
    where,
  ).toStrictEqual(fromTable);
  // Every party sends the round's set before anything built from its table.
  expect(fromTable[0], where).toBe(false);
  const outside = (frames: Array<unknown>) =>
    frames.filter((_, i) => !fromTable[i]);
  const inside = (frames: Array<unknown>) =>
    frames.filter((_, i) => fromTable[i]);
  expect(outside(largest).map(bytesOf), where).toStrictEqual(
    outside(greedy).map(bytesOf),
  );
  expect(inside(largest).map(shapeOf), where).toStrictEqual(
    inside(greedy).map(shapeOf),
  );
}

// Every candidate pair of a run, as (starter row, joiner row): the first
// round's set, and the second round's pair of each record index the first
// left in candidacy on both sides.
function candidatePairs(firstRound: Array<Pair>): Array<Pair> {
  const starters = new Set(firstRound.map(([a]) => a));
  const joiners = new Set(firstRound.map(([, b]) => b));
  const secondRound: Array<Pair> = [];
  for (let i = 0; i < RECORDS; ++i)
    if (!starters.has(i) && !joiners.has(i)) secondRound.push([i, i]);
  return [...firstRound, ...secondRound];
}

// Asserts what the two rules owe each other on one case, and returns how many
// more pairs the shipped rule's table holds than the greedy sweep's.
function expectCaseAgrees(
  c: Case,
  strategy: Strategy,
  largest: Run,
  greedy: Run,
  where: string,
): number {
  const candidates = new Set(
    candidatePairs(c.firstRound).map((pair) => pair.join(",")),
  );
  for (const pair of [...largest.table, ...greedy.table])
    expect(candidates.has(pair.join(",")), where).toBe(true);
  const inFirstRound = (table: Array<Pair>) =>
    table.filter(([a, b]) => c.firstRound.some(([x, y]) => x === a && y === b));
  expect(inFirstRound(largest.table), where).toStrictEqual(
    firstLargestPairing(c.firstRound),
  );

  for (const party of ["starter", "joiner"] as const)
    expectFramesAgreeOutsideTheTable(
      strategy,
      party === "starter" ? largest.starterSent : largest.joinerSent,
      party === "starter" ? greedy.starterSent : greedy.joinerSent,
      `${where}, ${party}`,
    );

  if (inFirstRound(greedy.table).length === largestPairingSize(c.firstRound)) {
    expect(largest.table, where).toStrictEqual(greedy.table);
    expect(largest.starterSent.map(bytesOf), where).toStrictEqual(
      greedy.starterSent.map(bytesOf),
    );
    expect(largest.joinerSent.map(bytesOf), where).toStrictEqual(
      greedy.joinerSent.map(bytesOf),
    );
    return 0;
  }
  expect(largest.table.length, where).toBeGreaterThan(greedy.table.length);
  return largest.table.length - greedy.table.length;
}

/** What the differential measures over every input under one strategy. */
export interface Measured {
  readonly inputs: number;
  readonly runs: number;
  readonly inputsWhereTablesDiffer: number;
  readonly largestGainInPairs: number;
  readonly inputsWhoseTableDependsOnTheRole: number;
}

/**
 * Runs every input in both role assignments under `strategy`, once under each
 * rule, asserting for each run:
 *
 * - every accepted pair, under either rule, is one of the run's candidate
 *   pairs, and the shipped rule's first-round pairs are the brute-force first
 *   largest pairing;
 * - where the greedy sweep's first-round pairs are a largest pairing, the two
 *   tables are equal and so is every frame either party sent, byte for byte;
 * - elsewhere the shipped rule's table holds more pairs, and each party sent
 *   the same number of frames under both rules: every frame not built from
 *   the table byte-identical, a later round's sets included, and each frame
 *   built from it with the same fields.
 */
export async function measureDifferential(
  strategy: Strategy,
): Promise<Measured> {
  const inputs = everyInput();
  const cases = casesOf(inputs);
  const differing = new Set<number>();
  let largestGainInPairs = 0;
  let runs = 0;
  // Each input's table under the shipped rule in each role assignment, read
  // as (written starter row, written joiner row).
  const asWritten = new Map<number, Set<string>>();
  for (let from = 0; from < cases.length; from += BATCH) {
    const batch = cases.slice(from, from + BATCH);
    const largestRuns = await runAll(false, strategy, batch);
    const greedyRuns = await runAll(true, strategy, batch);
    runs += 2 * batch.length;
    batch.forEach((c, i) => {
      const where =
        `${strategy}, ${c.swapped ? "roles exchanged" : "roles as written"}, ` +
        `pairs ${JSON.stringify(inputs[c.input].pairs)}`;
      const gain = expectCaseAgrees(
        c,
        strategy,
        largestRuns[i],
        greedyRuns[i],
        where,
      );
      if (gain > 0) differing.add(c.input);
      largestGainInPairs = Math.max(largestGainInPairs, gain);
      const table = largestRuns[i].table
        .map(([a, b]) => (c.swapped ? `${b},${a}` : `${a},${b}`))
        .sort();
      const seen = asWritten.get(c.input) ?? new Set<string>();
      seen.add(JSON.stringify(table));
      asWritten.set(c.input, seen);
    });
  }
  return {
    inputs: inputs.length,
    runs,
    inputsWhereTablesDiffer: differing.size,
    largestGainInPairs,
    inputsWhoseTableDependsOnTheRole: [...asWritten.values()].filter(
      (tables) => tables.size > 1,
    ).length,
  };
}

/**
 * Replaces the collector the unit project exposes with a no-op for the
 * caller's file, returning the restore. A run asks for a full collection after
 * its rounds, which over thousands of small runs is a large share of the time,
 * and nothing the differential asserts reads memory. The property is writable
 * and not configurable, so it is assigned rather than stubbed.
 */
export function withoutCollector(): () => void {
  const global = globalThis as unknown as { gc?: () => void };
  const collector = global.gc;
  if (collector === undefined) return () => {};
  global.gc = () => {};
  return () => {
    global.gc = collector;
  };
}
