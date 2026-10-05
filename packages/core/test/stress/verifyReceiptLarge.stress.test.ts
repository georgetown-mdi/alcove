import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { ProbeResult } from "./verifyReceiptLarge.probe";
import { stressMemory } from "./stressMemory";

// A record verified from a re-supplied input of 2^24 + 2048 rows, more than
// the entries one V8 Map holds, through the input's identifier column and
// through row indices (docs/spec/PROTOCOL.md, Measured whole exchange past
// 2^24 matched records). About 10 GiB resident under a 9 GiB heap, and 25
// minutes on a 10-core container under a load of 25, which is why it is the
// opt-in tier.

const PROBE = fileURLToPath(
  new URL("./verifyReceiptLarge.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
// The heap the figures above were measured under.
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
    // A synchronous spawn blocks the event loop, so vitest's own test timeout
    // cannot fire while it runs; the spawn's timeout is the only bound.
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
