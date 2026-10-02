import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PSI_HEAP_CEILING_FLAG,
  psiRoundMemoryNeedBytes,
} from "../../src/psiMemoryBudget";
import {
  expectedResultCount,
  expectedResultPairs,
  nulledPopulationRows,
  populationSsn,
} from "./completionPopulation";

// What the completion runs share: the built CLI they drive, the host-memory
// gate, the input they write, how a party is run and logged, and the check of
// its result against the population's known one.

/** The built CLI a completion run drives. */
export const CLI = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url),
);
const PEAK_MEMORY_REPORT = pathToFileURL(
  fileURLToPath(new URL("./peakMemoryReport.mjs", import.meta.url)),
).href;
const LOOP_LAG_REPORT = pathToFileURL(
  fileURLToPath(new URL("./loopLagReport.mjs", import.meta.url)),
).href;

/** Each party's bound, from ALCOVE_STRESS_COMPLETION_TIMEOUT_MS. */
export const RUN_TIMEOUT_MS = Number(
  process.env.ALCOVE_STRESS_COMPLETION_TIMEOUT_MS ?? 4 * 3_600_000,
);
/** Where each party's log is kept, from ALCOVE_STRESS_COMPLETION_LOG_DIR. */
export const LOG_DIR = process.env.ALCOVE_STRESS_COMPLETION_LOG_DIR;
/** Arguments added to each party's command line. */
export const EXTRA_CLI_ARGS = (
  process.env.ALCOVE_STRESS_COMPLETION_CLI_ARGS ?? ""
)
  .split(/\s+/)
  .filter((arg) => arg !== "");
/** Bytes in a gigabyte, as the runs report them. */
export const GB = 1e9;

/**
 * The main thread's peak beside the PSI worker: 11.78 GiB at 2^24 records, the
 * prepared input and the first-round count's index (docs/spec/FILE_SYNC.md,
 * Preparing the input at 2^24).
 */
export const MAIN_THREAD_BYTES_PER_RECORD = 754;

/**
 * A party's need at `rows` records under the CLI's own round budget, the main
 * thread's peak beside it: the file-sync joiner's figure, the costlier role.
 */
export function cliPartyNeedBytes(rows: number): number {
  return psiRoundMemoryNeedBytes(rows) + MAIN_THREAD_BYTES_PER_RECORD * rows;
}

/**
 * The memory the host-memory gate compares a run's need against. macOS counts
 * its reclaimable cache as used, so os.freemem() there reads a fraction of
 * what a run can have; the gate takes the total memory there. A copy of
 * stressMemory() in packages/core/test/stress/stressMemory.ts, which the core
 * cases share: the CLI's test tsconfig cannot import it (rootDir), so the two
 * must match.
 */
export function hostMemory(): { bytes: number; measure: string } {
  return platform() === "darwin"
    ? { bytes: totalmem(), measure: "total memory (macOS)" }
    : { bytes: freemem(), measure: "free memory" };
}

/** The host a run's summary names. */
export function hostDescription(): Record<string, string | number | undefined> {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
  };
}

/**
 * Writes rows `offset` to `offset + rows - 1` of the population to `path`,
 * numbered from 1. The starter's input is the population from 0, the joiner's
 * from half the row count.
 */
export async function writeInput(
  path: string,
  rows: number,
  offset: number,
): Promise<void> {
  const out = createWriteStream(path);
  out.write("Person_ID,SSN,LastName,DOB\n");
  let buffered = "";
  for (let i = 0; i < rows; i++) {
    const k = offset + i;
    buffered +=
      `${i + 1},${populationSsn(k)},N${k % 99991},` +
      `${1 + (k % 12)}/${1 + (k % 28)}/${1940 + (k % 60)}\n`;
    if (buffered.length > 1 << 20) {
      if (!out.write(buffered)) await once(out, "drain");
      buffered = "";
    }
  }
  out.end(buffered);
  await once(out, "finish");
}

/** One party's run of the built CLI. */
export interface PartyRun {
  exitCode: number | null;
  wallMs: number;
  peakRssBytes: number;
  /** The PSI role the party logged. */
  loggedRole?: string;
  /** When the party logged its role, from its start. */
  loggedRoleAtMs?: number;
  /** Set when the party was stopped for logging a role other than the one asked for. */
  stoppedForRole?: string;
  /**
   * Each time the party's event loop ran over a second late, as
   * loopLagReport.mjs records it: when the late turn ran, and how late.
   */
  loopLags: Array<{ at: number; lateMs: number }>;
  log: string;
}

/**
 * Runs the built CLI in `dir` with `args` after it, keeping its log in
 * {@link LOG_DIR} as party-<name>.log when that is set, reading its role off
 * the first line `roleLine` matches, and stopping it when that role is not
 * `expectedRole`.
 */
export function runParty(options: {
  dir: string;
  args: readonly string[];
  name: string;
  roleLine: RegExp;
  expectedRole?: string;
}): Promise<PartyRun> {
  const { dir, args, name, roleLine, expectedRole } = options;
  const peakFile = join(dir, "peak-rss");
  const lagFile =
    LOG_DIR === undefined
      ? join(dir, "loop-lag")
      : join(LOG_DIR, `loop-lag-${name}.log`);
  rmSync(lagFile, { force: true });
  const startedAt = performance.now();
  const child = spawn(process.execPath, ["--expose-gc", CLI, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${PSI_HEAP_CEILING_FLAG} --import=${PEAK_MEMORY_REPORT} ` +
        `--import=${LOOP_LAG_REPORT}`,
      ALCOVE_STRESS_PEAK_RSS_FILE: peakFile,
      ALCOVE_STRESS_LOOP_LAG_FILE: lagFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logPath =
    LOG_DIR === undefined ? undefined : join(LOG_DIR, `party-${name}.log`);
  if (LOG_DIR !== undefined) mkdirSync(LOG_DIR, { recursive: true });
  const logFile =
    logPath === undefined ? undefined : createWriteStream(logPath);
  let logError: Error | undefined;
  logFile?.on("error", (error) => {
    logError = error;
  });
  const run: PartyRun = {
    exitCode: null,
    wallMs: 0,
    peakRssBytes: Number.NaN,
    loopLags: [],
    log: "",
  };
  const onOutput = (chunk: Buffer): void => {
    const text = chunk.toString();
    run.log += text;
    logFile?.write(text);
    if (run.loggedRole !== undefined) return;
    const role = roleLine.exec(run.log)?.[1];
    if (role === undefined) return;
    run.loggedRole = role;
    run.loggedRoleAtMs = Math.round(performance.now() - startedAt);
    if (expectedRole !== undefined && role !== expectedRole) {
      run.stoppedForRole = role;
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    child.on("close", async (exitCode) => {
      clearTimeout(timer);
      if (logFile !== undefined)
        await new Promise((done) => {
          logFile.end(done);
        });
      if (logError !== undefined) {
        reject(new Error(`could not write ${logPath}: ${logError.message}`));
        return;
      }
      run.exitCode = exitCode;
      run.wallMs = Math.round(performance.now() - startedAt);
      if (existsSync(peakFile))
        run.peakRssBytes = Number(readFileSync(peakFile, "utf8"));
      if (existsSync(lagFile))
        for (const line of readFileSync(lagFile, "utf8").split("\n")) {
          const [at, lateMs] = line.split(" ");
          if (at === "" || at === "max") continue;
          run.loopLags.push({ at: Date.parse(at), lateMs: Number(lateMs) });
        }
      resolve(run);
    });
  });
}

/**
 * The first difference between a party's result and the rows a run of `rows`
 * records a side bounded by no size limit returns, or undefined when they
 * agree. `party` names which half of the population the party holds.
 */
export function resultDifference(
  resultPath: string,
  rows: number,
  party: "starter" | "joiner",
): string | undefined {
  const shared = Math.floor(rows / 2);
  const [, ...lines] = readFileSync(resultPath, "utf8").trim().split("\n");
  const pairs = lines
    .map((row): [number, number] => {
      const [own, partner] = row.split(",").map(Number);
      return [own, partner];
    })
    .sort((a, b) => a[0] - b[0]);
  const nulledRows = nulledPopulationRows(rows + shared);
  const expectedCount = expectedResultCount(rows, shared, nulledRows);
  if (pairs.length !== expectedCount)
    return `${pairs.length} matched rows, expected ${expectedCount}`;
  let j = 0;
  for (const expected of expectedResultPairs(rows, shared, party, nulledRows)) {
    const [own, partner] = pairs[j];
    if (own !== expected[0] || partner !== expected[1])
      return `matched row ${j} is ${own},${partner}, expected ${expected.join(",")}`;
    j++;
  }
  return undefined;
}

/**
 * The latest the party's event loop ran after `since`, in milliseconds: the
 * longest the main thread was held from then on, read to the second
 * loopLagReport.mjs reports from.
 */
export function maxLoopLagSince(run: PartyRun, since: number): number {
  return run.loopLags.reduce(
    (max, lag) => (lag.at > since && lag.lateMs > max ? lag.lateMs : max),
    0,
  );
}

/** A party's peak resident set in gigabytes, for a log line. */
export function peakGb(run: PartyRun): string {
  return (run.peakRssBytes / GB).toFixed(2);
}
