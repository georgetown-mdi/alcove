import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  freemem,
  platform,
  release,
  tmpdir,
  totalmem,
} from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import {
  PSI_HEAP_CEILING_FLAG,
  psiRoundMemoryNeedBytes,
} from "../../src/psiMemoryBudget";

// The built `alcove` exchanging over a synced folder or an SFTP server at 2^24
// records a side, to completion (docs/spec/FILE_SYNC.md, Measured runs at
// 2^24). Half of each side's input is shared with the other, one distinct SSN
// a record, so each party's result is known without running the exchange: the
// shared half, row for row. Logs the wall time and each party's peak resident
// set, PSI worker included. Two modes, chosen by environment variable:
//
// - Both parties on this host over a local directory (the default). For small
//   sizes: at 2^24 the pair needs about 62 GB.
// - One party on this host, against a partner on another
//   (ALCOVE_STRESS_COMPLETION_PARTY=starter or joiner, with
//   ALCOVE_STRESS_COMPLETION_URL naming the shared directory as a file:// or
//   sftp:// URL). Each host runs its own party at the same row count.
//
// ALCOVE_STRESS_COMPLETION_ROWS lowers the row count;
// ALCOVE_STRESS_COMPLETION_TIMEOUT_MS bounds each party (four hours by
// default); ALCOVE_STRESS_COMPLETION_CLI_ARGS adds arguments, separated by
// whitespace, to each party's command line, as SFTP credentials need;
// ALCOVE_STRESS_COMPLETION_LOG_DIR, a directory the test creates, keeps each
// party's log there as it runs (party-<name>.log) and, in one-party mode, a
// summary of the run (party-<name>.json).

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const PEAK_MEMORY_REPORT = pathToFileURL(
  fileURLToPath(new URL("./peakMemoryReport.mjs", import.meta.url)),
).href;
const ROWS = Number(process.env.ALCOVE_STRESS_COMPLETION_ROWS ?? 2 ** 24);
const RUN_TIMEOUT_MS = Number(
  process.env.ALCOVE_STRESS_COMPLETION_TIMEOUT_MS ?? 4 * 3_600_000,
);
const LOG_DIR = process.env.ALCOVE_STRESS_COMPLETION_LOG_DIR;
const PARTY = process.env.ALCOVE_STRESS_COMPLETION_PARTY;
const URL_OF_DROP = process.env.ALCOVE_STRESS_COMPLETION_URL;
const EXTRA_CLI_ARGS = (process.env.ALCOVE_STRESS_COMPLETION_CLI_ARGS ?? "")
  .split(/\s+/)
  .filter((arg) => arg !== "");
const GB = 1e9;
const SHARED = Math.floor(ROWS / 2);

type PartyName = "starter" | "joiner";

// The main thread's peak beside the PSI worker: 11.78 GiB at 2^24 records, the
// prepared input and the first-round count's index (docs/spec/FILE_SYNC.md,
// Preparing the input at 2^24).
const MAIN_THREAD_BYTES_PER_RECORD = 754;
// The starter's round from the measured costs (docs/spec/FILE_SYNC.md, The
// measured costs): 983 bytes an element over a 62 MB baseline and an 80 MB
// intercept. The joiner's is the CLI's own budget, the costlier role.
const STARTER_BYTES_PER_ELEMENT = 983;
const STARTER_FIXED_BYTES = 142_000_000;

function partyNeedBytes(party: PartyName): number {
  const round =
    party === "joiner"
      ? psiRoundMemoryNeedBytes(ROWS)
      : STARTER_FIXED_BYTES + STARTER_BYTES_PER_ELEMENT * ROWS;
  return round + MAIN_THREAD_BYTES_PER_RECORD * ROWS;
}

// macOS counts its reclaimable cache as used, so os.freemem() there reads a
// fraction of what a run can have; the gate takes the total memory there. A
// copy of stressMemory() in packages/core/test/stress/stressMemory.ts, which
// the core cases share: the CLI's test tsconfig cannot import it (rootDir), so
// the two must match.
function hostMemory(): { bytes: number; measure: string } {
  return platform() === "darwin"
    ? { bytes: totalmem(), measure: "total memory (macOS)" }
    : { bytes: freemem(), measure: "free memory" };
}

function ssn(i: number): string {
  const digits = String(100_000_000 + i);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

// Rows `offset` to `offset + ROWS - 1` of one population, numbered from 1. The
// starter's input is the population from 0, the joiner's from SHARED.
async function writeInput(path: string, offset: number): Promise<void> {
  const out = createWriteStream(path);
  out.write("Person_ID,SSN,LastName,DOB\n");
  let buffered = "";
  for (let i = 0; i < ROWS; i++) {
    const k = offset + i;
    buffered +=
      `${i + 1},${ssn(k)},N${k % 99991},` +
      `${1 + (k % 12)}/${1 + (k % 28)}/${1940 + (k % 60)}\n`;
    if (buffered.length > 1 << 20) {
      if (!out.write(buffered)) await once(out, "drain");
      buffered = "";
    }
  }
  out.end(buffered);
  await once(out, "finish");
}

interface PartyRun {
  exitCode: number | null;
  wallMs: number;
  peakRssBytes: number;
  // The PSI role the party logged, and when, from its start.
  loggedRole?: string;
  loggedRoleAtMs?: number;
  // Set when the party was stopped for logging a role other than the one
  // asked for.
  stoppedForRole?: string;
  log: string;
}

const ROLE_LINE = /\[alcove\] role: (sender|receiver)\b/;
// The starter sends; the joiner, the party arriving second, receives.
const ROLE_OF_PARTY: Record<PartyName, string> = {
  starter: "sender",
  joiner: "receiver",
};

function runParty(
  dir: string,
  url: string,
  name: string,
  expectedRole?: string,
): Promise<PartyRun> {
  const peakFile = join(dir, "peak-rss");
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      CLI,
      "--no-record",
      ...EXTRA_CLI_ARGS,
      url,
      join(dir, "input.csv"),
      join(dir, "result.csv"),
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        NODE_OPTIONS: `${PSI_HEAP_CEILING_FLAG} --import=${PEAK_MEMORY_REPORT}`,
        ALCOVE_STRESS_PEAK_RSS_FILE: peakFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
    log: "",
  };
  const onOutput = (chunk: Buffer): void => {
    const text = chunk.toString();
    run.log += text;
    logFile?.write(text);
    if (run.loggedRole !== undefined) return;
    const role = ROLE_LINE.exec(run.log)?.[1];
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
      resolve(run);
    });
  });
}

// The first difference between a party's result and the rows a run bounded by
// no size limit returns, or undefined when they agree. The starter's row
// SHARED + j holds the value of the joiner's row j; a result row is the
// party's own 1-based Person_ID, then the partner's 0-based row index.
function resultDifference(
  resultPath: string,
  party: PartyName,
): string | undefined {
  const [, ...rows] = readFileSync(resultPath, "utf8").trim().split("\n");
  const pairs = rows
    .map((row): [number, number] => {
      const [own, partner] = row.split(",").map(Number);
      return [own, partner];
    })
    .sort((a, b) => a[0] - b[0]);
  const expectedCount = ROWS - SHARED;
  if (pairs.length !== expectedCount)
    return `${pairs.length} matched rows, expected ${expectedCount}`;
  for (let j = 0; j < expectedCount; j++) {
    const expected: [number, number] =
      party === "starter" ? [SHARED + j + 1, j] : [j + 1, SHARED + j];
    const [own, partner] = pairs[j];
    if (own !== expected[0] || partner !== expected[1])
      return `matched row ${j} is ${own},${partner}, expected ${expected.join(",")}`;
  }
  return undefined;
}

function peakGb(run: PartyRun): string {
  return (run.peakRssBytes / GB).toFixed(2);
}

const PEER_HELLO = /-hello\.json$/;

// A party's hello, on a directory this host can list. The joiner is the party
// that finds its partner's hello there on arrival.
function peerHelloPresent(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => PEER_HELLO.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test(
  `two file-sync parties of ${ROWS} records a side complete with the known result`,
  { timeout: RUN_TIMEOUT_MS + 30 * 60_000 },
  async (ctx) => {
    ctx.skip(
      PARTY !== undefined,
      "ALCOVE_STRESS_COMPLETION_PARTY selects the one-party mode",
    );
    ctx.skip(
      !existsSync(CLI),
      "the completion run drives the built CLI; run npm run build -w apps/cli",
    );
    const need = partyNeedBytes("starter") + partyNeedBytes("joiner");
    const memory = hostMemory();
    ctx.skip(
      memory.bytes < need,
      `two parties of ${ROWS} records need about ` +
        `${(need / GB).toFixed(1)} GB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GB).toFixed(1)} GB`,
    );
    const root = mkdtempSync(join(tmpdir(), "alcove-completion-"));
    try {
      const drop = join(root, "drop");
      const a = join(root, "a");
      const b = join(root, "b");
      for (const dir of [drop, a, b]) mkdirSync(dir);
      await writeInput(join(a, "input.csv"), 0);
      await writeInput(join(b, "input.csv"), SHARED);

      const startedAt = performance.now();
      const [partyA, partyB] = await Promise.all([
        runParty(a, `file://${drop}`, "a"),
        runParty(b, `file://${drop}`, "b"),
      ]);
      const wallMs = Math.round(performance.now() - startedAt);
      console.log(
        `${ROWS} records a side: wall ${wallMs} ms; peak RSS ` +
          `${peakGb(partyA)} GB and ${peakGb(partyB)} GB; exit ` +
          `${partyA.exitCode} and ${partyB.exitCode}`,
      );
      for (const party of [partyA, partyB])
        if (party.exitCode !== 0) console.log(party.log.slice(-4000));

      expect([partyA.exitCode, partyB.exitCode]).toEqual([0, 0]);
      expect(resultDifference(join(a, "result.csv"), "starter")).toBe(
        undefined,
      );
      expect(resultDifference(join(b, "result.csv"), "joiner")).toBe(undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  `one file-sync party of ${ROWS} records completes with the known result against a partner on another host`,
  { timeout: 2 * RUN_TIMEOUT_MS + 30 * 60_000 },
  async (ctx) => {
    ctx.skip(
      PARTY === undefined,
      "set ALCOVE_STRESS_COMPLETION_PARTY to starter or joiner, and " +
        "ALCOVE_STRESS_COMPLETION_URL, to run one party",
    );
    if (PARTY !== "starter" && PARTY !== "joiner")
      throw new Error(
        `ALCOVE_STRESS_COMPLETION_PARTY is ${PARTY}; set it to starter or joiner`,
      );
    if (URL_OF_DROP === undefined || !/^(file|sftp|ssh):\/\//.test(URL_OF_DROP))
      throw new Error(
        "set ALCOVE_STRESS_COMPLETION_URL to the shared directory as a " +
          "file://, sftp:// or ssh:// URL",
      );
    ctx.skip(
      !existsSync(CLI),
      "the completion run drives the built CLI; run npm run build -w apps/cli",
    );
    const need = partyNeedBytes(PARTY);
    const memory = hostMemory();
    ctx.skip(
      memory.bytes < need,
      `the ${PARTY} of ${ROWS} records needs about ` +
        `${(need / GB).toFixed(1)} GB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GB).toFixed(1)} GB`,
    );
    const localDrop = URL_OF_DROP.startsWith("file://")
      ? fileURLToPath(URL_OF_DROP)
      : undefined;
    if (PARTY === "starter" && localDrop !== undefined) {
      if (!existsSync(localDrop))
        throw new Error(
          `${localDrop} does not exist: create the shared directory before ` +
            "the starter runs",
        );
      if (peerHelloPresent(localDrop))
        throw new Error(
          `${localDrop} already holds a hello: the starter arrives first, so ` +
            "clear the directory and start the joiner after the starter",
        );
    }

    const root = mkdtempSync(join(tmpdir(), "alcove-completion-"));
    try {
      await writeInput(
        join(root, "input.csv"),
        PARTY === "starter" ? 0 : SHARED,
      );
      // The joiner must arrive second. On a directory this host lists, it
      // waits for the starter's hello; over SFTP the operator starts it after
      // the starter's log shows "synchronizing".
      if (PARTY === "joiner" && localDrop !== undefined) {
        console.log(`waiting for the starter's hello in ${localDrop}`);
        const deadline = performance.now() + RUN_TIMEOUT_MS;
        while (!peerHelloPresent(localDrop)) {
          if (performance.now() > deadline)
            throw new Error(
              `no starter's hello appeared in ${localDrop} within ` +
                `${RUN_TIMEOUT_MS} ms`,
            );
          await delay(2_000);
        }
      }

      const startedAt = new Date();
      const run = await runParty(
        root,
        URL_OF_DROP,
        PARTY,
        ROLE_OF_PARTY[PARTY],
      );
      const difference =
        run.exitCode === 0
          ? resultDifference(join(root, "result.csv"), PARTY)
          : undefined;
      console.log(
        `${PARTY}, ${ROWS} records: wall ${run.wallMs} ms; peak RSS ` +
          `${peakGb(run)} GB; role ${run.loggedRole ?? "not logged"} at ` +
          `${run.loggedRoleAtMs ?? "-"} ms; exit ${run.exitCode}`,
      );
      if (LOG_DIR !== undefined)
        writeFileSync(
          join(LOG_DIR, `party-${PARTY}.json`),
          JSON.stringify(
            {
              party: PARTY,
              rows: ROWS,
              scheme: URL_OF_DROP.slice(0, URL_OF_DROP.indexOf(":")),
              startedAt: startedAt.toISOString(),
              wallMs: run.wallMs,
              peakRssBytes: run.peakRssBytes,
              loggedRole: run.loggedRole,
              loggedRoleAtMs: run.loggedRoleAtMs,
              exitCode: run.exitCode,
              resultDifference: difference ?? null,
              host: {
                platform: platform(),
                release: release(),
                arch: arch(),
                cpuModel: cpus()[0]?.model,
                cpuCount: cpus().length,
                totalMemoryBytes: totalmem(),
                node: process.version,
              },
            },
            null,
            2,
          ) + "\n",
        );
      if (run.exitCode !== 0) console.log(run.log.slice(-4000));

      expect(
        run.stoppedForRole,
        `the ${PARTY} logged role ${run.stoppedForRole} and was stopped: ` +
          "start the starter first and the joiner after it",
      ).toBe(undefined);
      expect(run.exitCode).toBe(0);
      expect(difference).toBe(undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
