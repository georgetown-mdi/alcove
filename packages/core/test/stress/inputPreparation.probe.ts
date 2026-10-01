// One measurement of the CLI's input preparation, stage by stage, run in its
// own process so its peak resident set is its own:
// `inputPreparation.stress.test.ts` spawns it and reads the one JSON line it
// prints. It writes the input first where the file does not exist: four
// columns, an id, a synthetic SSN, a last name and a date of birth, one
// distinct SSN a row.
//
// Usage: node --max-old-space-size=<MiB> --import tsx inputPreparation.probe.ts <rows> <csv>

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

import { RoundSetLimitError } from "../../src/errors";
import {
  assertFirstRoundFitsFileSyncFrame,
  prepareForExchange,
} from "../../src/exchange";
import { loadCSVFile } from "../../src/file";
import { summarizeDatasetConstraintViolations } from "../../src/valueConstraints";

export interface PreparationStage {
  readonly stage: string;
  readonly elapsedMs: number;
  readonly rssMiB: number;
  readonly peakRssMiB: number;
}

export interface PreparationProbeResult {
  readonly rows: number;
  readonly stages: ReadonlyArray<PreparationStage>;
  /** Rows a second over each successive million the first count walked. */
  readonly countRowsPerSecond: ReadonlyArray<number>;
  readonly firstRound: "fits" | "refused";
}

function ssn(i: number): string {
  const digits = String(100_000_000 + i);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

async function writeInput(path: string, rows: number): Promise<void> {
  const out = createWriteStream(path);
  out.write("Person_ID,SSN,LastName,DOB\n");
  let buffered = "";
  for (let i = 0; i < rows; i++) {
    buffered +=
      `${i + 1},${ssn(i)},N${i % 99991},` +
      `${1 + (i % 12)}/${1 + (i % 28)}/${1940 + (i % 60)}\n`;
    if (buffered.length > 1 << 20) {
      if (!out.write(buffered)) await once(out, "drain");
      buffered = "";
    }
  }
  out.end(buffered);
  await once(out, "finish");
}

const MIB = 1024 * 1024;
const stages: Array<PreparationStage> = [];

async function timed<T>(stage: string, run: () => Promise<T> | T): Promise<T> {
  const startedAt = performance.now();
  const result = await run();
  const measured: PreparationStage = {
    stage,
    elapsedMs: Math.round(performance.now() - startedAt),
    rssMiB: Math.round(process.memoryUsage().rss / MIB),
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  };
  stages.push(measured);
  // On stderr as each stage ends, so a run stopped partway shows how far it got.
  process.stderr.write(`${JSON.stringify(measured)}\n`);
  return result;
}

async function main(): Promise<void> {
  const rows = Number(process.argv[2]);
  const csv = process.argv[3];
  if (!Number.isSafeInteger(rows) || rows < 1 || csv === undefined)
    throw new Error("usage: inputPreparation.probe.ts <rows> <csv>");
  if (!existsSync(csv)) await writeInput(csv, rows);

  const parsed = await timed("read", () => loadCSVFile(createReadStream(csv)));
  const prepared = await timed("prepare", () =>
    prepareForExchange(
      {},
      undefined,
      parsed.data,
      parsed.meta.fields ?? [],
      parsed.meta.sanitizedColumnPositions,
    ),
  );
  await timed("constraints", () =>
    summarizeDatasetConstraintViolations(
      prepared.linkageTerms,
      prepared.dataset,
      prepared.rowCount,
    ),
  );
  const countRowsPerSecond: Array<number> = [];
  let lastMillion = 0;
  let lastMillionAt = performance.now();
  const firstRound = await timed("first-round count", () =>
    assertFirstRoundFitsFileSyncFrame(prepared, {
      progressIntervalMs: 100,
      onProgress: (report) => {
        if (report.state === "started") {
          lastMillion = 0;
          lastMillionAt = performance.now();
        }
        if (report.state !== "progress" || report.processed === undefined)
          return;
        const million = Math.floor(report.processed / 1_000_000);
        if (million === lastMillion) return;
        const now = performance.now();
        countRowsPerSecond.push(
          Math.round(
            ((million - lastMillion) * 1_000_000) /
              ((now - lastMillionAt) / 1000),
          ),
        );
        lastMillion = million;
        lastMillionAt = now;
      },
    }).then(
      () => "fits" as const,
      (error: unknown) => {
        if (error instanceof RoundSetLimitError) return "refused" as const;
        throw error;
      },
    ),
  );
  const result: PreparationProbeResult = {
    rows,
    stages,
    countRowsPerSecond,
    firstRound,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
