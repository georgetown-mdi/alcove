import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { ProbeResult } from "./verifyReceiptLarge.probe";
import { stressMemory } from "./stressMemory";

// Opt-in: verifies a record from a re-supplied input of 2^24 + 2048 rows,
// through an identifier column and through row indices; needs about 11 GiB.

const PROBE = fileURLToPath(
  new URL("./verifyReceiptLarge.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(9_216, Math.floor(totalmem() / MIB) - 2_048);
const PROBE_TIMEOUT_MS = 1_800_000;
const ROWS = 2 ** 24 + 2048;
// The probe's peak resident set at ROWS, rounded up to whole GiB.
const NEED_GIB = 11;

test(
  `a record over an input of ${ROWS} rows verifies`,
  { timeout: PROBE_TIMEOUT_MS },
  (ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes / GIB < NEED_GIB,
      `the verification probe needs ${NEED_GIB} GiB; this host's ` +
        `${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const out = execFileSync(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_MIB}`,
        "--import",
        "tsx",
        PROBE,
        String(ROWS),
      ],
      {
        encoding: "utf8",
        maxBuffer: 1 << 20,
        timeout: PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    const result = JSON.parse(out.trim()) as ProbeResult;
    console.log(
      `verification at ${ROWS} input rows: record build ${result.buildMs} ms, ` +
        `by identifier ${result.byIdentifierMs} ms, by row index ` +
        `${result.byRowIndexMs} ms, peak RSS ${result.maxRssMiB} MiB`,
    );
    expect(result.error).toBeUndefined();
    expect(result.warnings).toBe(0);
    expect(result.byIdentifier).toBe("verified");
    expect(result.byRowIndex).toBe("verified");
  },
);
