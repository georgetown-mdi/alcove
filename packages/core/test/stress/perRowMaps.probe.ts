// One measurement of the per-row structures on the linkage path, run in its own
// process so its peak resident set is its own: `perRowMaps.stress.test.ts`
// spawns it once per case and size and reads the one JSON line it prints.
//
// Usage: node --max-old-space-size=<MiB> --import tsx perRowMaps.probe.ts <case> <entries>

import { performance } from "node:perf_hooks";

import {
  assertRoundDiagonalClosure,
  entityClusters,
} from "../../src/psi/entityClosure";
import { linkViaPSI } from "../../src/psi/link";
import { describeLocalRoundGrouping } from "../../src/psi/roundGrouping";

import type { ClosureBlock } from "../../src/psi/entityClosure";
import type { MessageConnection } from "../../src/connection/messageConnection";
import type {
  PSIParticipant,
  RoundGroupingExchange,
} from "../../src/psi/participant";
import type { AssociationTable } from "../../src/types";
import type { LinkageCardinality } from "../../src/psi/link";

export const PROBE_CASES = [
  "localGrouping",
  "localRanks",
  "partnerRanks",
  "entityClusters",
  "closurePairs",
] as const;
export type ProbeCase = (typeof PROBE_CASES)[number];

export interface ProbeResult {
  readonly probe: ProbeCase;
  readonly entries: number;
  readonly holds: boolean;
  readonly error?: string;
  readonly failedIn?: string;
  readonly elapsedMs: number;
  readonly maxRssMiB: number;
}

// Rows per matched value on the side that keeps its duplicates, so a round's
// distinct values stay under 2^24 while its records pass it.
const GROUP = 4;

const ROUND_DONE = new Error("the first round finished");

// Position `k` of the round stands for rows `GROUP * k` up to `GROUP * k + GROUP`.
function grouped(rowCount: number): {
  rows: Array<number>;
  groupStarts: Array<number>;
} {
  const positions = Math.ceil(rowCount / GROUP);
  const groupStarts = new Array<number>(positions + 1);
  for (let k = 0; k <= positions; ++k)
    groupStarts[k] = Math.min(k * GROUP, rowCount);
  return { rows: Array.from({ length: rowCount }, (_, i) => i), groupStarts };
}

function localGrouping(entries: number): void {
  const candidates = grouped(entries);
  const matched = Array.from(
    { length: candidates.groupStarts.length - 1 },
    (_, k) => k,
  );
  describeLocalRoundGrouping(candidates, matched, true);
}

// One round of `linkViaPSI` with every value of this party's set matched
// against one of the partner's, the partner's grouping stated as owner lists.
// The run stops at the second key, so it measures the first round whole: its
// candidate list, both groupings, the rank maps and the pair resolution.
async function linkRound(
  cardinality: LinkageCardinality,
  localRecords: number,
  partnerOwners: number,
): Promise<void> {
  const localKeepsDuplicates = cardinality === "many-to-one";
  const values = localKeepsDuplicates
    ? Math.ceil(localRecords / GROUP)
    : localRecords;
  const key = Array.from({ length: localRecords }, (_, i) =>
    (localKeepsDuplicates ? Math.floor(i / GROUP) : i).toString(36),
  );
  const matched = Array.from({ length: values }, (_, k) => k);
  const owners: Array<Array<number>> = [];
  if (partnerOwners > 1)
    for (let k = 0; k < values; ++k)
      owners.push(
        Array.from({ length: partnerOwners }, (_, o) => k * partnerOwners + o),
      );
  const participant = {
    id: "probe",
    config: { role: "starter", verbose: 0 },
    identifyIntersection: async (
      _conn: MessageConnection,
      set: Array<string>,
      grouping?: RoundGroupingExchange,
    ): Promise<AssociationTable> => {
      if (set.length !== values || grouping === undefined)
        throw new Error("the probe's round did not take the expected form");
      grouping.describe(matched);
      grouping.accept(partnerOwners > 1 ? owners : undefined, matched);
      return [matched, matched];
    },
  } as unknown as PSIParticipant;
  const stop = (stage: string) => {
    if (stage.startsWith("stage 2")) throw ROUND_DONE;
  };
  try {
    await linkViaPSI(
      { cardinality },
      participant,
      {} as MessageConnection,
      [key, key],
      { partnerRecordCount: values * partnerOwners, keyWidths: [1, 1] },
      0,
      stop,
    );
  } catch (error) {
    if (error !== ROUND_DONE) throw error;
    return;
  }
  throw new Error("the probe's run passed its first round without stopping");
}

function oneToOneTable(entries: number): AssociationTable {
  const rows = Array.from({ length: entries }, (_, i) => i);
  return [rows, rows.slice()];
}

// Two of this party's rows and two of the partner's per cluster, every pair
// between them in the table, one block per cluster: the rows stay at half the
// pairs, so the pair-keyed structures are the ones driven past 2^24.
function closurePairs(entries: number): void {
  const clusters = Math.ceil(entries / 4);
  const local: Array<number> = [];
  const partner: Array<number> = [];
  const blocks: Array<ClosureBlock> = [];
  for (let c = 0; c < clusters; ++c) {
    const rows = [2 * c, 2 * c + 1];
    for (const l of rows)
      for (const p of rows) {
        local.push(l);
        partner.push(p);
      }
    blocks.push({ localRows: rows, partnerRows: rows });
  }
  assertRoundDiagonalClosure(
    "probe",
    [local, partner],
    new Array<number>(local.length).fill(0),
    blocks,
  );
}

async function run(probe: ProbeCase, entries: number): Promise<void> {
  switch (probe) {
    case "localGrouping":
      return localGrouping(entries);
    case "localRanks":
      return linkRound("many-to-one", entries, 1);
    case "partnerRanks":
      return linkRound("one-to-many", Math.ceil(entries / GROUP), GROUP);
    case "entityClusters":
      entityClusters(oneToOneTable(entries));
      return;
    case "closurePairs":
      return closurePairs(entries);
  }
}

// The innermost frame in the package's own source, which names the structure
// that threw.
function sourceFrame(error: Error): string | undefined {
  for (const line of (error.stack ?? "").split("\n").slice(1)) {
    const match = /at (?:(\S+) \()?.*\/src\/(.+?):(\d+):\d+\)?$/.exec(line);
    if (match) return `${match[1] ?? "<anonymous>"} (${match[2]}:${match[3]})`;
  }
  return undefined;
}

const [probe, entriesArg] = process.argv.slice(2);
if (!PROBE_CASES.includes(probe as ProbeCase) || !entriesArg)
  throw new Error(`usage: <${PROBE_CASES.join("|")}> <entries>`);
const entries = Number(entriesArg);
const start = performance.now();
let result: Omit<ProbeResult, "elapsedMs" | "maxRssMiB">;
try {
  await run(probe as ProbeCase, entries);
  result = { probe: probe as ProbeCase, entries, holds: true };
} catch (error) {
  const failure = error as Error;
  result = {
    probe: probe as ProbeCase,
    entries,
    holds: false,
    error: `${failure.name}: ${failure.message}`,
    failedIn: sourceFrame(failure),
  };
}
const elapsedMs = Math.round(performance.now() - start);
const maxRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
process.stdout.write(
  `${JSON.stringify({ ...result, elapsedMs, maxRssMiB })}\n`,
);
