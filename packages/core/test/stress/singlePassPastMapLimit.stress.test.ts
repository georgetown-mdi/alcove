import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { ProbeCase, ProbeResult } from "./singlePassPastMapLimit.probe";
import { MAX_MAP_SHARD_ENTRIES } from "../../src/psi/shardedMap";
import { stressMemory } from "./stressMemory";

// The single-pass structures that hold one entry a distinct value or a row,
// past the 2^24 entries one V8 Map holds: 2^24 + 1 of them, so the last opens
// a second shard (docs/spec/PROTOCOL.md, The limits over file-sync). Each
// case is its own process, so the peak resident set it reports is its own.
// Minutes and up to about 11 GB resident, which is why it is the opt-in tier.

const PROBE = fileURLToPath(
  new URL("./singlePassPastMapLimit.probe.ts", import.meta.url),
);
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(16_384, Math.floor(totalmem() / MIB) - 2_048);
const PAST_MAP_LIMIT = MAX_MAP_SHARD_ENTRIES + 1;
const PROBE_TIMEOUT_MS = 600_000;

function measure(probe: ProbeCase): ProbeResult {
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
      String(PAST_MAP_LIMIT),
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
    `${probe} at ${PAST_MAP_LIMIT}: ${result.holds ? "holds" : "fails"}, ` +
      `${result.elapsedMs} ms, peak RSS ${result.maxRssMiB} MiB`,
  );
  return result;
}

// The free memory a case needs before it spawns: its peak resident set as
// measured on 2026-11-04 (docs/spec/PROTOCOL.md, The limits over file-sync),
// rounded up to whole GiB.
const cases: ReadonlyArray<[ProbeCase, number]> = [
  ["distinctValues", 3],
  ["firstRows", 1],
  ["oneToOneReplay", 4],
  ["manyToManyReplay", 11],
  ["receiverGroupsReplay", 8],
  ["senderGroupsReplay", 6],
];

test.for(cases)(
  "%s completes past the Map limit",
  { timeout: PROBE_TIMEOUT_MS },
  ([probe, needGiB], ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes / GIB < needGiB,
      `${probe} needs ${needGiB} GiB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const result = measure(probe);
    expect(result.error).toBeUndefined();
    expect(result.holds).toBe(true);
  },
);
