import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { freemem, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import {
  PSI_HEAP_CEILING_FLAG,
  psiRoundMemoryNeedBytes,
} from "../../src/psiMemoryBudget";

// Two parties of the built `alcove` exchanging over a synced folder at 2^24
// records a side, each in its own process as an operator runs them, to
// completion (docs/spec/FILE_SYNC.md, Measured runs at 2^24). Half of each
// input is shared with the other, one distinct SSN a record, so the result is
// known without running the exchange: the shared half, row for row. Logs the
// wall time and each party's peak resident set, PSI worker included. About
// 60 GB for the pair, which is why it is the opt-in tier and skips on a host
// with less free memory. ALCOVE_STRESS_COMPLETION_ROWS lowers the row count;
// ALCOVE_STRESS_COMPLETION_TIMEOUT_MS bounds the run (four hours by default);
// ALCOVE_STRESS_COMPLETION_LOG_DIR, an existing directory, keeps each party's
// log there as party-a.log and party-b.log.

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const PEAK_MEMORY_REPORT = pathToFileURL(
  fileURLToPath(new URL("./peakMemoryReport.mjs", import.meta.url)),
).href;
const ROWS = Number(process.env.ALCOVE_STRESS_COMPLETION_ROWS ?? 2 ** 24);
const RUN_TIMEOUT_MS = Number(
  process.env.ALCOVE_STRESS_COMPLETION_TIMEOUT_MS ?? 4 * 3_600_000,
);
const LOG_DIR = process.env.ALCOVE_STRESS_COMPLETION_LOG_DIR;
const GB = 1e9;
// The main thread holds the prepared input beside the PSI worker: 7.69 GiB at
// 2^24 records, measured (docs/spec/FILE_SYNC.md, Preparing the input at 2^24).
const MAIN_THREAD_BYTES_PER_RECORD = 492;
const NEED_BYTES =
  2 * (psiRoundMemoryNeedBytes(ROWS) + MAIN_THREAD_BYTES_PER_RECORD * ROWS);

function ssn(i: number): string {
  const digits = String(100_000_000 + i);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

// Rows `offset` to `offset + ROWS - 1` of one population, numbered from 1.
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
  peakRssBytes: number;
  log: string;
}

function runParty(dir: string, drop: string): Promise<PartyRun> {
  const peakFile = join(dir, "peak-rss");
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      CLI,
      "--no-record",
      `file://${drop}`,
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
  let log = "";
  child.stdout.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  return new Promise((resolve) => {
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        peakRssBytes: existsSync(peakFile)
          ? Number(readFileSync(peakFile, "utf8"))
          : Number.NaN,
        log,
      });
    });
  });
}

// One party's result as [own record id, partner's row index] pairs, sorted:
// the id is the input's 1-based Person_ID, the index the partner's 0-based
// row.
function matchedRows(resultPath: string): Array<[number, number]> {
  const [, ...rows] = readFileSync(resultPath, "utf8").trim().split("\n");
  return rows
    .map((row): [number, number] => {
      const [own, partner] = row.split(",").map(Number);
      return [own, partner];
    })
    .sort((a, b) => a[0] - b[0]);
}

test(
  `two file-sync parties of ${ROWS} records a side complete with the known result`,
  { timeout: RUN_TIMEOUT_MS + 30 * 60_000 },
  async (ctx) => {
    ctx.skip(
      !existsSync(CLI),
      "the completion run drives the built CLI; run npm run build -w apps/cli",
    );
    ctx.skip(
      freemem() < NEED_BYTES,
      `two parties of ${ROWS} records need about ` +
        `${(NEED_BYTES / GB).toFixed(1)} GB free; ` +
        `${(freemem() / GB).toFixed(1)} GB is free`,
    );
    const root = mkdtempSync(join(tmpdir(), "alcove-completion-"));
    try {
      const drop = join(root, "drop");
      const a = join(root, "a");
      const b = join(root, "b");
      for (const dir of [drop, a, b]) mkdirSync(dir);
      const shared = Math.floor(ROWS / 2);
      await writeInput(join(a, "input.csv"), 0);
      await writeInput(join(b, "input.csv"), shared);

      const startedAt = performance.now();
      const [partyA, partyB] = await Promise.all([
        runParty(a, drop),
        runParty(b, drop),
      ]);
      const wallMs = Math.round(performance.now() - startedAt);
      console.log(
        `${ROWS} records a side: wall ${wallMs} ms; peak RSS ` +
          `${(partyA.peakRssBytes / GB).toFixed(2)} GB and ` +
          `${(partyB.peakRssBytes / GB).toFixed(2)} GB; exit ` +
          `${partyA.exitCode} and ${partyB.exitCode}`,
      );
      if (LOG_DIR !== undefined) {
        writeFileSync(join(LOG_DIR, "party-a.log"), partyA.log);
        writeFileSync(join(LOG_DIR, "party-b.log"), partyB.log);
      }
      for (const party of [partyA, partyB])
        if (party.exitCode !== 0) console.log(party.log.slice(-4000));

      expect([partyA.exitCode, partyB.exitCode]).toEqual([0, 0]);
      // Party A's row shared + j holds the value of party B's row j, so a
      // run bounded by no size limit matches exactly these rows.
      const pairs = Array.from({ length: ROWS - shared }, (_unused, j) => j);
      expect(matchedRows(join(a, "result.csv"))).toEqual(
        pairs.map((j): [number, number] => [shared + j + 1, j]),
      );
      expect(matchedRows(join(b, "result.csv"))).toEqual(
        pairs.map((j): [number, number] => [j + 1, shared + j]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
