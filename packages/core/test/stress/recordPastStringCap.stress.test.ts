import { constants } from "node:buffer";
import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { ProbeMode, ProbeResult } from "./recordPastStringCap.probe";
import { stressMemory } from "./stressMemory";

// An exchange record and receipt over a payload of one 30-character column
// whose commitment encoding is just under V8's longest string, and one of
// 2^24 + 2048 rows, past it. Both build and verify; under the cap each value
// equals the one built from the one-shot encoding, and past it the one-shot
// encoding is refused.

const PROBE = fileURLToPath(
  new URL("./recordPastStringCap.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(14_336, Math.floor(totalmem() / MIB) - 2_048);
const PROBE_TIMEOUT_MS = 1_800_000;
// Each probe's peak resident set, rounded up to whole GiB.
const NEED_GIB: Record<ProbeMode, number> = { under: 10, past: 7 };

function runProbe(mode: ProbeMode): ProbeResult {
  // A synchronous spawn blocks the event loop, so vitest's own test timeout
  // cannot fire while it runs; the spawn's timeout is the only bound.
  const out = execFileSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_MIB}`, "--import", "tsx", PROBE, mode],
    {
      encoding: "utf8",
      maxBuffer: 1 << 20,
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const result = JSON.parse(out.trim()) as ProbeResult;
  console.log(
    `record and receipt ${mode} the string cap at ${result.rows} rows ` +
      `(${result.commitmentEncodingBytes} encoded bytes): build ` +
      `${result.buildMs} ms, verify ${result.verifyMs} ms, receipt ` +
      `${result.receiptMs} ms, peak RSS ${result.maxRssMiB} MiB`,
  );
  return result;
}

function skipWithoutMemory(
  ctx: { skip: (condition: boolean, note: string) => void },
  mode: ProbeMode,
): void {
  const memory = stressMemory();
  ctx.skip(
    memory.bytes / GIB < NEED_GIB[mode],
    `the record probe ${mode} the string cap needs ${NEED_GIB[mode]} GiB; ` +
      `this host's ${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
  );
}

test(
  "a record and receipt just under the string cap match the one-shot values",
  { timeout: PROBE_TIMEOUT_MS },
  (ctx) => {
    skipWithoutMemory(ctx, "under");
    const result = runProbe("under");
    expect(result.error).toBeUndefined();
    expect(result.commitmentEncodingBytes).toBeLessThanOrEqual(
      constants.MAX_STRING_LENGTH,
    );
    expect(result.holds).toBe(true);
    expect(result.matchesOneShot).toBe(true);
    expect(result.oneShotRefused).toBe(true);
  },
);

test(
  "a record and receipt past the string cap build and verify",
  { timeout: PROBE_TIMEOUT_MS },
  (ctx) => {
    skipWithoutMemory(ctx, "past");
    const result = runProbe("past");
    expect(result.error).toBeUndefined();
    expect(result.commitmentEncodingBytes).toBeGreaterThan(
      constants.MAX_STRING_LENGTH,
    );
    expect(result.holds).toBe(true);
    expect(result.oneShotRefused).toBe(true);
  },
);
