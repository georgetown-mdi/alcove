// The CLI's input read and preparation at the record count the main thread's
// heap check admits, run in its own process under whatever heap it was started
// with: `mainThreadHeap.stress.test.ts` spawns it at Node's default heap and
// reads the one JSON line it prints. It writes the four-column input, runs the
// check and the CLI's read, the preparation, the constraint pass, and the
// first-round check one value under the record count, which walks every record
// and builds the index of first-round values.
//
// Usage: node --import tsx mainThreadHeap.probe.ts <csv> [<rows>]

import { getHeapStatistics } from "node:v8";

import {
  assertFirstRoundWithinSetMaximum,
  prepareForExchange,
  RoundSetLimitError,
  summarizeDatasetConstraintViolations,
} from "@alcove/core";

import {
  checkInputFitsMainThreadHeap,
  MAIN_THREAD_HEAP_BYTES_PER_RECORD,
} from "../../src/inputHeapCheck";
import { loadInputRows } from "../../src/onlineBootstrap";
import { writeInput } from "./completionRun";

export interface MainThreadHeapProbeResult {
  readonly rows: number;
  readonly heapLimitBytes: number;
  readonly peakHeapUsedBytes: number;
  readonly peakRssBytes: number;
  readonly firstRoundOneUnder: "fits" | "refused";
}

let peakHeapUsedBytes = 0;
const sampler = setInterval(() => {
  peakHeapUsedBytes = Math.max(
    peakHeapUsedBytes,
    getHeapStatistics().used_heap_size,
  );
}, 100);
sampler.unref();

async function main(): Promise<void> {
  const csv = process.argv[2];
  if (csv === undefined)
    throw new Error("usage: mainThreadHeap.probe.ts <csv> [<rows>]");
  const heapLimitBytes = getHeapStatistics().heap_size_limit;
  const rows = Number(
    process.argv[3] ??
      Math.floor(heapLimitBytes / MAIN_THREAD_HEAP_BYTES_PER_RECORD),
  );
  await writeInput(csv, rows, 0);
  await checkInputFitsMainThreadHeap(csv);
  const { rawRows, columns, sanitizedColumnPositions } =
    await loadInputRows(csv);
  const prepared = prepareForExchange(
    {},
    undefined,
    rawRows,
    columns,
    sanitizedColumnPositions,
  );
  summarizeDatasetConstraintViolations(
    prepared.linkageTerms,
    prepared.dataset,
    prepared.rowCount,
  );
  const firstRoundOneUnder = await assertFirstRoundWithinSetMaximum(prepared, {
    maxValues: rows - 1,
  }).then(
    () => "fits" as const,
    (error: unknown) => {
      if (error instanceof RoundSetLimitError) return "refused" as const;
      throw error;
    },
  );
  const result: MainThreadHeapProbeResult = {
    rows,
    heapLimitBytes,
    peakHeapUsedBytes: Math.max(
      peakHeapUsedBytes,
      getHeapStatistics().used_heap_size,
    ),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    firstRoundOneUnder,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
