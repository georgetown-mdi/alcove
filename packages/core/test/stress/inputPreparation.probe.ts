// One measurement of the CLI's input preparation, stage by stage, run in its
// own process so its peak resident set is its own:
// `inputPreparation.stress.test.ts` spawns it and reads the one JSON line it
// prints. It writes the input first where the file does not exist: four
// columns, an id, a synthetic SSN, a last name and a date of birth, one
// distinct SSN a row. The first-round check runs twice: at a per-set maximum
// of `<maxValues>`, and at one value fewer than the round sends, so the input
// is one value over it and the count walks every record. The values the round
// sends are counted with the check's own counter, since the standardization
// drops some SSNs as placeholders.
//
// Usage: node --max-old-space-size=<MiB> --import tsx inputPreparation.probe.ts <rows> <csv> [<maxValues>]

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import { RoundSetLimitError } from "../../src/errors";
import { prepareForExchange } from "../../src/exchange";
import type { PreparedExchange } from "../../src/exchange";
import { assertFirstRoundWithinSetMaximum } from "../../src/exchange/firstRoundCapacity";
import { loadCSVFile } from "../../src/file";
import { RoundSetCounter } from "../../src/psi/link";
import { StandardizedKeyIterable } from "../../src/standardization";
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
  /** The values the first round sends, in the sending role. */
  readonly firstRoundValues: number;
  /** Rows a second over each successive million the one-over count walked. */
  readonly countRowsPerSecond: ReadonlyArray<number>;
  /** The first-round check at the per-set maximum. */
  readonly firstRound: "fits" | "refused";
  /** The first-round check at one value fewer than `firstRoundValues`. */
  readonly firstRoundOneOver: "fits" | "refused";
}

function ssn(i: number): string {
  const digits = String(100_000_000 + i);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

function countFirstRoundValues(prepared: PreparedExchange): number {
  const { linkageTerms, dataset, rowCount } = prepared;
  const counter = new RoundSetCounter(linkageTerms.deduplicate);
  let row = 0;
  for (const candidates of new StandardizedKeyIterable(
    linkageTerms.linkageKeys[0],
    dataset,
    rowCount,
    false,
    0,
    false,
  ))
    counter.add(row++, candidates);
  return counter.size;
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
  const maxValues = Number(process.argv[4] ?? MAX_PSI_DECODE_ELEMENTS);
  if (
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    csv === undefined ||
    !Number.isSafeInteger(maxValues)
  )
    throw new Error(
      "usage: inputPreparation.probe.ts <rows> <csv> [<maxValues>]",
    );
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
  const outcome = (check: Promise<void>): Promise<"fits" | "refused"> =>
    check.then(
      () => "fits" as const,
      (error: unknown) => {
        if (error instanceof RoundSetLimitError) return "refused" as const;
        throw error;
      },
    );
  const firstRound = await timed("first-round count", () =>
    outcome(assertFirstRoundWithinSetMaximum(prepared, { maxValues })),
  );
  const firstRoundValues = await timed("first-round values", () =>
    countFirstRoundValues(prepared),
  );
  const countRowsPerSecond: Array<number> = [];
  let lastMillion = 0;
  let lastMillionAt = performance.now();
  const firstRoundOneOver = await timed("first-round count, one over", () =>
    outcome(
      assertFirstRoundWithinSetMaximum(prepared, {
        maxValues: firstRoundValues - 1,
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
      }),
    ),
  );
  const result: PreparationProbeResult = {
    rows,
    stages,
    firstRoundValues,
    countRowsPerSecond,
    firstRound,
    firstRoundOneOver,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
