import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, expect, test } from "vitest";

import { canonicalString } from "../../src/utils/canonical";
import type { ProbeResult } from "./exchangeRecordLarge.probe";
import { stressMemory } from "./stressMemory";

// Arrays at and past 2^24 elements, the length at which V8's
// Object.getOwnPropertyNames throws, through the canonical encoder and through
// the exchange record and receipt built over a result that large. Several GB
// resident and tens of seconds, which is why it is the opt-in tier.

const PROBE = fileURLToPath(
  new URL("./exchangeRecordLarge.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(16_384, Math.floor(totalmem() / MIB) - 2_048);
const PROBE_TIMEOUT_MS = 600_000;
// The whole-exchange figures' result size in docs/spec/PROTOCOL.md.
const PAIRS = 2 ** 24 + 2048;
// The record probe's peak resident set at PAIRS, rounded up to whole GiB.
const RECORD_NEED_GIB = 8;

afterAll(() => {
  const peakMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(`canonical large-array stress: peak RSS ${peakMiB} MiB`);
});

test("an array of 2^24 elements encodes", () => {
  const length = 2 ** 24;
  const values = Array.from({ length }, (_unused, at) => at % 10);
  const startedAt = performance.now();
  const encoded = canonicalString(values);
  console.log(
    `canonicalString over 2^24 numbers: ` +
      `${Math.round(performance.now() - startedAt)} ms`,
  );
  expect(encoded.length).toBe(2 * length + 1);
  expect(encoded.startsWith("[0,1,2,")).toBe(true);
  expect(encoded.endsWith(",4,5]")).toBe(true);
});

test("an array of 2^24 elements with a named property is rejected", () => {
  const values: unknown[] = Array.from({ length: 2 ** 24 }, () => 0);
  (values as unknown as Record<string, unknown>).foo = "bar";
  expect(() => canonicalString({ a: values })).toThrow(
    /\$\.a: non-index array property \("foo"\)/,
  );
});

test(
  `a record and a receipt over ${PAIRS} matched pairs build and verify`,
  { timeout: PROBE_TIMEOUT_MS },
  (ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes / GIB < RECORD_NEED_GIB,
      `the record probe needs ${RECORD_NEED_GIB} GiB; this host's ` +
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
        String(PAIRS),
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
      `record at ${PAIRS} pairs: build ${result.buildMs} ms, verify ` +
        `${result.verifyMs} ms, receipt ${result.receiptMs} ms, ` +
        `peak RSS ${result.maxRssMiB} MiB`,
    );
    expect(result.error).toBeUndefined();
    expect(result.holds).toBe(true);
  },
);
