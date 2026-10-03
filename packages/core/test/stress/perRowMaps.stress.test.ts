import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { ProbeCase, ProbeResult } from "./perRowMaps.probe";
import { stressMemory } from "./stressMemory";

// The per-row structures of a linkage round and of the entity closure, driven
// past the 2^24 entries a V8 Map or Set holds and at a 50-million-record input
// (docs/spec/PROTOCOL.md, One round's matched records, and the CSV intake
// cap). Each run is its own process, so the peak resident set it reports is
// its own, and each completes. Minutes and up to about 13 GB resident, which
// is why it is the opt-in tier.

const PROBE = fileURLToPath(new URL("./perRowMaps.probe.ts", import.meta.url));
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HEAP_MIB = Math.min(16_384, Math.floor(totalmem() / MIB) - 2_048);
const PAST_MAP_LIMIT = 2 ** 24 + 1024;
const TARGET = 50_000_000;
const PROBE_TIMEOUT_MS = 600_000;

function measure(
  probe: ProbeCase,
  entries: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): ProbeResult {
  let out: string;
  try {
    // A synchronous spawn blocks the event loop, so vitest's own test timeout
    // cannot fire while it runs; the spawn's timeout is the only bound.
    out = execFileSync(
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
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );
  } catch (error) {
    const { signal, code } = error as NodeJS.ErrnoException & {
      signal?: string;
    };
    const reason =
      code === "ETIMEDOUT"
        ? `did not finish within ${timeoutMs} ms and was killed`
        : `failed${signal ? ` with ${signal}` : ""}`;
    throw new Error(`the ${probe} probe at ${entries} entries ${reason}`, {
      cause: error,
    });
  }
  const result = JSON.parse(out.trim()) as ProbeResult;
  console.log(
    `${probe} at ${entries}: ${result.holds ? "holds" : `threw in ${result.failedIn}`}, ` +
      `${result.elapsedMs} ms, peak RSS ${result.maxRssMiB} MiB`,
  );
  return result;
}

// The free memory a case needs before it spawns: its peak resident set as
// measured in docs/spec/PROTOCOL.md, rounded up to whole GiB, and for a case
// the spec records as not run, the 2^24 figure scaled to its size.
const cases: ReadonlyArray<[ProbeCase, number, number]> = [
  ["localGrouping", PAST_MAP_LIMIT, 1],
  ["localGrouping", TARGET, 2],
  ["localRanks", PAST_MAP_LIMIT, 4],
  ["localRanks", TARGET, 12],
  ["partnerRanks", PAST_MAP_LIMIT, 4],
  ["partnerRanks", TARGET, 11],
  ["entityClusters", PAST_MAP_LIMIT, 5],
  ["entityClusters", TARGET, 13],
  ["closurePairs", PAST_MAP_LIMIT, 2],
  ["closurePairs", TARGET, 5],
];

test.for(cases)(
  "%s at %i entries completes past the Map or Set limit",
  { timeout: PROBE_TIMEOUT_MS },
  ([probe, entries, needGiB], ctx) => {
    const memory = stressMemory();
    ctx.skip(
      memory.bytes / GIB < needGiB,
      `${probe} at ${entries} entries needs ${needGiB} GiB; ` +
        `this host's ${memory.measure} is ${(memory.bytes / GIB).toFixed(1)} GiB`,
    );
    const result = measure(probe, entries);
    expect(result.error).toBeUndefined();
    expect(result.holds).toBe(true);
  },
);

test("a probe past its timeout is killed and the failure names its case and size", () => {
  expect(() => measure("localGrouping", PAST_MAP_LIMIT, 1)).toThrow(
    `the localGrouping probe at ${PAST_MAP_LIMIT} entries did not finish within 1 ms and was killed`,
  );
});
