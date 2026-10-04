import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import type { ProbeCase, ProbeResult } from "./matchedListParts.probe";
import { stressMemory } from "./stressMemory";

// The lists naming matched records, exchanged over file-sync past both bounds
// one message holds -- 2^24 entries and MAX_FRAME_SIZE_BYTES -- so each goes in
// more than one part (docs/spec/PROTOCOL.md, A list of matched records is sent
// in parts). Both parties run in one process, which is what the memory figure
// in the spec counts. Minutes and several GB resident, which is why it is the
// opt-in tier.

const PROBE = fileURLToPath(
  new URL("./matchedListParts.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(16_384, Math.floor(totalmem() / MIB) - 2_048);
const PAST_LIST_LIMIT = 2 ** 24 + 1024;
const PROBE_TIMEOUT_MS = 1_200_000;

function measure(probe: ProbeCase, entries: number): ProbeResult {
  // A synchronous spawn blocks the event loop, so vitest's own test timeout
  // cannot fire while it runs; the spawn's timeout is the only bound.
  const out = execFileSync(
    process.execPath,
    [
      `--max-old-space-size=${HEAP_MIB}`,
      "--import",
      "tsx",
      PROBE,
      probe,
      String(entries),
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
    `${probe} at ${entries}: ${result.holds ? "holds" : "failed"}, ` +
      `${result.partsSent} parts, largest file ${result.largestFileBytes} bytes, ` +
      `${result.elapsedMs} ms, peak RSS ${result.maxRssMiB} MiB`,
  );
  return result;
}

// The free memory a case needs before it spawns: its peak resident set as
// measured in docs/spec/PROTOCOL.md, rounded up to whole GiB.
const cases: ReadonlyArray<[ProbeCase, number, number, number]> = [
  // Four lists of two parts each: two mapped-element passes, each way.
  ["mappedElements", PAST_LIST_LIMIT, 8, 9],
  // One payload of two parts, and the partner's empty one.
  ["payload", PAST_LIST_LIMIT, 3, 7],
];

test.for(cases)(
  "%s at %i entries crosses file-sync in parts",
  { timeout: PROBE_TIMEOUT_MS },
  ([probe, entries, partsSent, needGiB], ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes / GIB < needGiB,
      `${probe} at ${entries} entries needs ${needGiB} GiB; ` +
        `this host's ${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const result = measure(probe, entries);
    expect(result.error).toBeUndefined();
    expect(result.holds).toBe(true);
    expect(result.partsSent).toBe(partsSent);
    expect(result.largestFileBytes).toBeLessThanOrEqual(MAX_FRAME_SIZE_BYTES);
  },
);
