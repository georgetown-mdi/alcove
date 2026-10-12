#!/usr/bin/env node
// Lists the jobs of the core stress workflow (.github/workflows/
// nightly_core_stress.yaml) for one tier, from the files vitest lists for the
// `stress` project.
//
//   npx vitest list --project stress --filesOnly --json \
//     | node ../../scripts/list-stress-jobs.mjs <all|nightly|weekly>
//
// Run from packages/core: the listed paths are made relative to the working
// directory. It prints the jobs as one line of JSON, and exits 1 when a file
// named below is not in the listing (a rename cannot drop a file from its
// tier) or the tier is unknown.

import { relative } from "node:path";
import { fileURLToPath } from "node:url";

// Measured job walls on a hosted runner: psiRoundWalls 2 h 45 min
// (per-test limit 241 min), wasmMaskingGrowth 14 to 21 min (31
// min). The 270 minutes for psiRoundWalls cover one round, 2^22
// (measured 2 h 44 min); its 2^23 round needs about 24 GiB, which
// a hosted runner lacks, so WALLS_SIZES pins the job to 2^22.
// streamedMatchLarge at 2^24, identifier-revealing: job 2 h 58
// min; building the round 33.1 min (peak RSS 11557 MiB); the
// match 144.8 min, WASM memory peak 860 MiB, heap peak 274 MiB,
// peak RSS 2193 MiB. Its probe limits, each at least 1.5 times
// its measured time rounded up to 5 min, are 50 min to build and
// 220 to match; the job limit of 290 is those plus 1 of test margin
// and 15 for setup, rounded up. It needs 13 GiB free.
// streamedMatchLargeNative, the same round matched on the native
// addon: job 42 min; building the round 33.3 min (peak RSS 11444
// MiB); the match 8.3 min, 33704 elements a second, heap peak 273
// MiB, peak RSS 1949 MiB. Its probe limits, sized the same way,
// are 50 min to build and 15 to match, and its job limit of 85 is
// those plus 1 of test margin and 15 for setup, rounded up. It
// needs 13 GiB free.
const WALLS_FILE = "test/stress/psiRoundWalls.stress.test.ts";
const WALLS_SIZES = "4194304";
export const WEEKLY_MINUTES = {
  [WALLS_FILE]: 270,
  "test/stress/streamedMatchLarge.stress.test.ts": 290,
  "test/stress/streamedMatchLargeNative.stress.test.ts": 85,
  "test/stress/wasmMaskingGrowth.stress.test.ts": 45,
};
// Each took 0.5 to 2.5 minutes as a job of its own.
export const GROUPED = [
  "test/stress/createSetupMessageLarge.stress.test.ts",
  "test/stress/findAllScanBudget.stress.test.ts",
  "test/stress/identifyIntersectionLarge.stress.test.ts",
  "test/stress/psiSetFraming.stress.test.ts",
  "test/stress/roundDedupPastMapLimit.stress.test.ts",
  "test/stress/standardizedFieldRowCount.stress.test.ts",
];
// The longest nightly job measured 8 min 47 s (recordPastStringCap);
// the longest nightly per-test limit is 41 min (inputPreparation).
export const NIGHTLY_MINUTES = 60;

/**
 * The jobs of one tier. `listing` is the parsed `vitest list --json` output,
 * `directory` the directory its file paths are made relative to, and `tier`
 * one of `all`, `nightly` and `weekly`.
 */
export function listStressJobs(listing, directory, tier) {
  const files = listing.map((each) => relative(directory, each.file)).sort();
  const missing = [...Object.keys(WEEKLY_MINUTES), ...GROUPED].filter(
    (name) => !files.includes(name),
  );
  if (missing.length > 0)
    throw new Error(`the stress project lists no ${missing.join(", ")}`);
  const single = (file, minutes) => ({
    name: file,
    files: file,
    minutes,
    wallsSizes: file === WALLS_FILE ? WALLS_SIZES : "",
  });
  const weekly = files
    .filter((file) => file in WEEKLY_MINUTES)
    .map((file) => single(file, WEEKLY_MINUTES[file]));
  const nightly = [
    { name: "short files", files: GROUPED.join(" "), minutes: NIGHTLY_MINUTES },
    ...files
      .filter((file) => !(file in WEEKLY_MINUTES) && !GROUPED.includes(file))
      .map((file) => single(file, NIGHTLY_MINUTES)),
  ];
  const jobs = { all: [...nightly, ...weekly], nightly, weekly }[tier];
  if (jobs === undefined) throw new Error(`no stress tier ${tier}`);
  return jobs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    try {
      const jobs = listStressJobs(
        JSON.parse(input),
        process.cwd(),
        process.argv[2],
      );
      console.log(JSON.stringify(jobs));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}
