import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import type { ProbeCase, ProbeResult } from "./perRowMaps.probe";

// The per-row structures of a linkage round and of the entity closure, driven
// past the 2^24 entries a V8 Map or Set holds and at a 50-million-record input
// (docs/spec/PROTOCOL.md, The memory ceiling, and the CSV intake cap). Each
// run is its own process, so the peak resident set it reports is its own, and
// each throws the Map or Set RangeError from the frame the spec names. About
// five minutes and up to 11 GB resident, which is why it is the opt-in tier.

const PROBE = fileURLToPath(new URL("./perRowMaps.probe.ts", import.meta.url));
const HEAP_MIB = 16_384;
const PAST_MAP_LIMIT = 2 ** 24 + 1024;
const TARGET = 50_000_000;

function measure(probe: ProbeCase, entries: number): ProbeResult {
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
    { encoding: "utf8", maxBuffer: 1 << 20 },
  );
  const result = JSON.parse(out.trim()) as ProbeResult;
  console.log(
    `${probe} at ${entries}: ${result.holds ? "holds" : `threw in ${result.failedIn}`}, ` +
      `${result.elapsedMs} ms, peak RSS ${result.maxRssMiB} MiB`,
  );
  return result;
}

const cases: ReadonlyArray<[ProbeCase, number, string]> = [
  ["ordinalOfRow", PAST_MAP_LIMIT, "describeLocalRoundGrouping"],
  ["ordinalOfRow", TARGET, "describeLocalRoundGrouping"],
  ["localRanks", PAST_MAP_LIMIT, "describeLocalRoundGrouping"],
  ["localRanks", TARGET, "describeLocalRoundGrouping"],
  ["partnerRanks", PAST_MAP_LIMIT, "noteMatch"],
  ["partnerRanks", TARGET, "noteMatch"],
  ["entityClusters", PAST_MAP_LIMIT, "RowForest.node"],
  ["entityClusters", TARGET, "RowForest.node"],
  ["closurePairs", PAST_MAP_LIMIT, "assertRoundDiagonalClosure"],
  ["closurePairs", TARGET, "RowForest.node"],
];

test.each(cases)(
  "%s at %i entries throws at the Map or Set limit in %s",
  (probe, entries, frame) => {
    const result = measure(probe, entries);
    expect(result.holds).toBe(false);
    expect(result.error).toMatch(
      /^RangeError: (Map|Set) maximum size exceeded$/,
    );
    expect(result.failedIn?.split(" ")[0]).toBe(frame);
  },
  600_000,
);
