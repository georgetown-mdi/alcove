import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { ProbeCase, ProbeResult } from "./perRowMaps.probe";

// The per-row structures of a linkage round and of the entity closure, driven
// past the 2^24 entries a V8 Map or Set holds and at a 50-million-record input
// (docs/spec/PROTOCOL.md, The memory ceiling, and the CSV intake cap). Each
// run is its own process, so the peak resident set it reports is its own, and
// each throws the Map or Set RangeError from the frame the spec names. About
// five minutes and up to 12 GB resident, which is why it is the opt-in tier.

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

// Each case's peak resident set as measured in docs/spec/PROTOCOL.md, rounded
// up to whole GiB: the free memory a case needs before it spawns.
const cases: ReadonlyArray<[ProbeCase, number, string, number]> = [
  ["ordinalOfRow", PAST_MAP_LIMIT, "describeLocalRoundGrouping", 2],
  ["ordinalOfRow", TARGET, "describeLocalRoundGrouping", 4],
  ["localRanks", PAST_MAP_LIMIT, "describeLocalRoundGrouping", 5],
  ["localRanks", TARGET, "describeLocalRoundGrouping", 12],
  ["partnerRanks", PAST_MAP_LIMIT, "noteMatch", 7],
  ["partnerRanks", TARGET, "noteMatch", 10],
  ["entityClusters", PAST_MAP_LIMIT, "RowForest.node", 3],
  ["entityClusters", TARGET, "RowForest.node", 4],
  ["closurePairs", PAST_MAP_LIMIT, "assertRoundDiagonalClosure", 9],
  ["closurePairs", TARGET, "RowForest.node", 6],
];

test.for(cases)(
  "%s at %i entries throws at the Map or Set limit in %s",
  { timeout: PROBE_TIMEOUT_MS },
  ([probe, entries, frame, needGiB], ctx) => {
    const freeGiB = freemem() / GIB;
    ctx.skip(
      freeGiB < needGiB,
      `${probe} at ${entries} entries needs ${needGiB} GiB free; ` +
        `${freeGiB.toFixed(1)} GiB is free`,
    );
    const result = measure(probe, entries);
    expect(result.holds).toBe(false);
    expect(result.error).toMatch(
      /^RangeError: (Map|Set) maximum size exceeded$/,
    );
    expect(result.failedIn?.split(" ")[0]).toBe(frame);
  },
);

test("a probe past its timeout is killed and the failure names its case and size", () => {
  expect(() => measure("ordinalOfRow", PAST_MAP_LIMIT, 1)).toThrow(
    `the ordinalOfRow probe at ${PAST_MAP_LIMIT} entries did not finish within 1 ms and was killed`,
  );
});
