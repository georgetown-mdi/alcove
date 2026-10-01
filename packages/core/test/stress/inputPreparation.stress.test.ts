import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";

import type { PreparationProbeResult } from "./inputPreparation.probe";
import { stressMemory } from "./stressMemory";

// The CLI's input preparation over 2^24 records, each with its own 9-digit
// SSN, from reading the CSV to the first-round check: admitted at the per-set
// maximum, and refused with the maximum one value under the rows, a count that
// walks every record (docs/spec/FILE_SYNC.md, Preparing the input at 2^24).
// The probe runs in its own process under the heap the CLI raises its main
// thread to, and reports each stage's time and the process's peak resident
// set. About eight minutes and 12 GB resident on the measured host, which is
// why it is the opt-in tier. ALCOVE_STRESS_PREPARATION_ROWS lowers the row
// count for a quicker run; the maximum is lowered with it to the row count, so
// the check is still taken at the bound.

const PROBE = fileURLToPath(
  new URL("./inputPreparation.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const ROWS = Number(process.env.ALCOVE_STRESS_PREPARATION_ROWS ?? 2 ** 24);
const HEAP_MIB = Math.min(19_075, Math.floor(totalmem() / MIB) - 2_048);
// Rounded up from the measured peak at 2^24 records, scaled to the run.
const NEED_GIB = Math.ceil((12 * ROWS) / 2 ** 24);
const PROBE_TIMEOUT_MS = 40 * 60_000;
const MAX_VALUES = Math.min(ROWS, MAX_PSI_DECODE_ELEMENTS);

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test(
  `preparing ${ROWS} records keeps its pace through the first-round count`,
  { timeout: PROBE_TIMEOUT_MS + 60_000 },
  (ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes / GIB < NEED_GIB,
      `the preparation of ${ROWS} records needs ${NEED_GIB} GiB; ` +
        `this host's ${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const dir = mkdtempSync(join(tmpdir(), "alcove-preparation-"));
    let out: string;
    try {
      // A synchronous spawn blocks the event loop, so vitest's own test
      // timeout cannot fire while it runs; the spawn's timeout is the bound.
      out = execFileSync(
        process.execPath,
        [
          `--max-old-space-size=${HEAP_MIB}`,
          "--import",
          "tsx",
          PROBE,
          String(ROWS),
          join(dir, "input.csv"),
          String(MAX_VALUES),
        ],
        {
          encoding: "utf8",
          maxBuffer: 1 << 20,
          timeout: PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const result = JSON.parse(out.trim()) as PreparationProbeResult;
    for (const { stage, elapsedMs, peakRssMiB } of result.stages)
      console.log(
        `${stage}: ${elapsedMs} ms, peak RSS ${peakRssMiB} MiB, ` +
          `${Math.round(elapsedMs / (ROWS / 1e6))} ms per million records`,
      );
    console.log(
      `first-round count, rows a second per million: ${result.countRowsPerSecond.join(", ")}`,
    );

    expect(result.stages.map(({ stage }) => stage)).toStrictEqual([
      "read",
      "prepare",
      "constraints",
      "first-round count",
      "first-round count, one over",
    ]);
    expect(result.firstRound).toBe(ROWS > MAX_VALUES ? "refused" : "fits");
    expect(result.firstRoundOneOver).toBe("refused");
    // The string-table slowdown this guards against cut the count's pace about
    // fiftyfold from partway through to the end. A pause or a busy host slows
    // some millions severalfold, so the halves are compared by their medians.
    const paces = result.countRowsPerSecond;
    if (paces.length > 1) {
      const half = Math.floor(paces.length / 2);
      expect(median(paces.slice(half))).toBeGreaterThan(
        median(paces.slice(0, half)) / 8,
      );
    }
  },
);
