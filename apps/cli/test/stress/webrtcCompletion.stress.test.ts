import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "vitest";

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

// The built `alcove` exchanging CLI to CLI over WebRTC, to completion, both
// parties on this host: the WebRTC counterpart of
// fileSyncCompletion.stress.test.ts, over the same population and known
// result. Logs the wall time and each party's peak resident set, PSI worker
// included.
//
// Each party runs `alcove exchange` on the configuration `alcove init` writes
// from its input, with the connection block replaced by a `channel: webrtc`
// one -- one party `role: inviter`, the other `role: acceptor` -- and a key
// file holding one shared secret. The signaling broker is not started here:
// run `npm start -w packages/peerjs-broker -- --port 9000` first, or name
// another with ALCOVE_STRESS_COMPLETION_BROKER_URL (a ws:// URL, mount path
// included).
//
// ALCOVE_STRESS_COMPLETION_ROWS lowers the row count;
// ALCOVE_STRESS_COMPLETION_TIMEOUT_MS bounds each party (four hours by
// default); ALCOVE_STRESS_COMPLETION_CLI_ARGS adds arguments, separated by
// whitespace, to each party's command line;
// ALCOVE_STRESS_COMPLETION_LOG_DIR, a directory the test creates, keeps each
// party's log there as it runs (party-<name>.log) and a summary of the run
// (webrtc-completion.json).

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const PEAK_MEMORY_REPORT = pathToFileURL(
  fileURLToPath(new URL("./peakMemoryReport.mjs", import.meta.url)),
).href;
// Past the 7,643,790 elements one WebRTC frame holds (docs/spec/PROTOCOL.md,
// The memory ceiling and the CSV intake cap), so each first-round set goes in
// two parts.
const ROWS = Number(process.env.ALCOVE_STRESS_COMPLETION_ROWS ?? 7_700_000);
const RUN_TIMEOUT_MS = Number(
  process.env.ALCOVE_STRESS_COMPLETION_TIMEOUT_MS ?? 4 * 3_600_000,
);
const LOG_DIR = process.env.ALCOVE_STRESS_COMPLETION_LOG_DIR;
const BROKER_URL = new URL(
  process.env.ALCOVE_STRESS_COMPLETION_BROKER_URL ?? "ws://127.0.0.1:9000/api",
);
const EXTRA_CLI_ARGS = (process.env.ALCOVE_STRESS_COMPLETION_CLI_ARGS ?? "")
  .split(/\s+/)
  .filter((arg) => arg !== "");
const GB = 1e9;
const SHARED = Math.floor(ROWS / 2);

// The inviter holds the population from 0, as the file-sync starter does; the
// acceptor holds it from SHARED, as the joiner does.
type PartyName = "inviter" | "acceptor";
const POPULATION_PARTY = {
  inviter: "starter",
  acceptor: "joiner",
} as const;

// The file-sync joiner's figure for either party: the CLI's own round budget
// and the main thread's peak beside it (docs/spec/FILE_SYNC.md, Preparing the
// input at 2^24).
const MAIN_THREAD_BYTES_PER_RECORD = 754;

function partyNeedBytes(): number {
  return psiRoundMemoryNeedBytes(ROWS) + MAIN_THREAD_BYTES_PER_RECORD * ROWS;
}

// macOS counts its reclaimable cache as used, so os.freemem() there reads a
// fraction of what a run can have; the gate takes the total memory there. A
// copy of the one in fileSyncCompletion.stress.test.ts.
function hostMemory(): { bytes: number; measure: string } {
  return platform() === "darwin"
    ? { bytes: totalmem(), measure: "total memory (macOS)" }
    : { bytes: freemem(), measure: "free memory" };
}

// Rows `offset` to `offset + ROWS - 1` of one population, numbered from 1.
async function writeInput(path: string, offset: number): Promise<void> {
  const out = createWriteStream(path);
  out.write("Person_ID,SSN,LastName,DOB\n");
  let buffered = "";
  for (let i = 0; i < ROWS; i++) {
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

function connectionBlock(role: PartyName): string {
  const secure = BROKER_URL.protocol === "wss:";
  const port = BROKER_URL.port === "" ? (secure ? 443 : 80) : BROKER_URL.port;
  // The host-candidates-only form docs/CLI.md documents (STUN, and what it
  // discloses): both parties are on this host.
  return (
    "connection:\n" +
    "  channel: webrtc\n" +
    "  server:\n" +
    `    host: ${BROKER_URL.hostname}\n` +
    `    port: ${port}\n` +
    `    path: ${BROKER_URL.pathname}\n` +
    `    secure: ${secure}\n` +
    `  role: ${role}\n` +
    "  stun:\n" +
    "    - stun:127.0.0.1:3478\n"
  );
}

// Writes the party's alcove.yaml and .alcove.key into `dir`: the linkage terms
// `alcove init` infers from the input under a webrtc connection block.
function writeConfiguration(
  dir: string,
  role: PartyName,
  sharedSecret: string,
): void {
  const configPath = join(dir, "alcove.yaml");
  const init = spawnSync(
    process.execPath,
    [
      CLI,
      "init",
      join(dir, "input.csv"),
      "--config-file",
      configPath,
      "--identity",
      role,
    ],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (init.status !== 0)
    throw new Error(
      `alcove init exited ${init.status} for the ${role}:\n${init.stderr}`,
    );
  const template = readFileSync(configPath, "utf8");
  const start = template.indexOf("\nconnection:\n");
  const end = template.indexOf("\nlinkage_terms:\n");
  if (start === -1 || end === -1 || end < start)
    throw new Error(
      "the alcove init template has no connection block ahead of its " +
        "linkage_terms block",
    );
  writeFileSync(
    configPath,
    template.slice(0, start + 1) +
      connectionBlock(role) +
      template.slice(end + 1),
  );
  writeFileSync(
    join(dir, ".alcove.key"),
    JSON.stringify({ sharedSecret }, null, 2) + "\n",
    { mode: 0o600 },
  );
}

interface PartyRun {
  exitCode: number | null;
  wallMs: number;
  peakRssBytes: number;
  // The PSI role the party logged, and when, from its start.
  loggedRole?: string;
  loggedRoleAtMs?: number;
  log: string;
}

const ROLE_LINE = /\[exchange\] role: (sender|receiver)\b/;

function runParty(dir: string, name: PartyName): Promise<PartyRun> {
  const peakFile = join(dir, "peak-rss");
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      CLI,
      "exchange",
      "--no-record",
      ...EXTRA_CLI_ARGS,
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
// no size limit returns, or undefined when they agree.
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
  const nulledRows = nulledPopulationRows(ROWS + SHARED);
  const expectedCount = expectedResultCount(ROWS, SHARED, nulledRows);
  if (pairs.length !== expectedCount)
    return `${pairs.length} matched rows, expected ${expectedCount}`;
  let j = 0;
  for (const expected of expectedResultPairs(
    ROWS,
    SHARED,
    POPULATION_PARTY[party],
    nulledRows,
  )) {
    const [own, partner] = pairs[j];
    if (own !== expected[0] || partner !== expected[1])
      return `matched row ${j} is ${own},${partner}, expected ${expected.join(",")}`;
    j++;
  }
  return undefined;
}

function peakGb(run: PartyRun): string {
  return (run.peakRssBytes / GB).toFixed(2);
}

// The broker's readiness endpoint (packages/peerjs-broker/README.md).
async function brokerIsReady(): Promise<boolean> {
  const health = new URL(BROKER_URL.href);
  health.protocol = BROKER_URL.protocol === "wss:" ? "https:" : "http:";
  health.pathname = `${BROKER_URL.pathname.replace(/\/$/, "")}/health`;
  try {
    const response = await fetch(health, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

test(
  `two WebRTC parties of ${ROWS} records a side complete with the known result`,
  { timeout: RUN_TIMEOUT_MS + 30 * 60_000 },
  async (ctx) => {
    ctx.skip(
      !existsSync(CLI),
      "the completion run drives the built CLI; run npm run build -w apps/cli",
    );
    const need = 2 * partyNeedBytes();
    const memory = hostMemory();
    ctx.skip(
      memory.bytes < need,
      `two parties of ${ROWS} records need about ` +
        `${(need / GB).toFixed(1)} GB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GB).toFixed(1)} GB`,
    );
    if (!(await brokerIsReady()))
      throw new Error(
        `no signaling broker answers at ${BROKER_URL.href}: start one with ` +
          "npm start -w packages/peerjs-broker -- --port 9000, or set " +
          "ALCOVE_STRESS_COMPLETION_BROKER_URL",
      );
    const root = mkdtempSync(join(tmpdir(), "alcove-completion-"));
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      for (const dir of [a, b]) mkdirSync(dir);
      await writeInput(join(a, "input.csv"), 0);
      await writeInput(join(b, "input.csv"), SHARED);
      const sharedSecret = randomBytes(32).toString("base64url");
      writeConfiguration(a, "inviter", sharedSecret);
      writeConfiguration(b, "acceptor", sharedSecret);

      const startedAt = new Date();
      const startedAtMs = performance.now();
      const [inviter, acceptor] = await Promise.all([
        runParty(a, "inviter"),
        runParty(b, "acceptor"),
      ]);
      const wallMs = Math.round(performance.now() - startedAtMs);
      console.log(
        `${ROWS} records a side: wall ${wallMs} ms; peak RSS ` +
          `${peakGb(inviter)} GB and ${peakGb(acceptor)} GB; roles ` +
          `${inviter.loggedRole ?? "not logged"} and ` +
          `${acceptor.loggedRole ?? "not logged"}; exit ` +
          `${inviter.exitCode} and ${acceptor.exitCode}`,
      );
      const inviterDifference =
        inviter.exitCode === 0
          ? resultDifference(join(a, "result.csv"), "inviter")
          : undefined;
      const acceptorDifference =
        acceptor.exitCode === 0
          ? resultDifference(join(b, "result.csv"), "acceptor")
          : undefined;
      if (LOG_DIR !== undefined) {
        const summary = (run: PartyRun, difference: string | undefined) => ({
          wallMs: run.wallMs,
          peakRssBytes: run.peakRssBytes,
          loggedRole: run.loggedRole,
          loggedRoleAtMs: run.loggedRoleAtMs,
          exitCode: run.exitCode,
          resultDifference: difference ?? null,
        });
        writeFileSync(
          join(LOG_DIR, "webrtc-completion.json"),
          JSON.stringify(
            {
              rows: ROWS,
              broker: BROKER_URL.href,
              startedAt: startedAt.toISOString(),
              wallMs,
              inviter: summary(inviter, inviterDifference),
              acceptor: summary(acceptor, acceptorDifference),
              host: {
                platform: platform(),
                release: release(),
                arch: arch(),
                cpuModel: cpus()[0]?.model,
                cpuCount: cpus().length,
                totalMemoryBytes: totalmem(),
                gateMemoryBytes: memory.bytes,
                gateNeedBytes: need,
                node: process.version,
              },
            },
            null,
            2,
          ) + "\n",
        );
      }
      for (const party of [inviter, acceptor])
        if (party.exitCode !== 0) console.log(party.log.slice(-4000));

      expect([inviter.exitCode, acceptor.exitCode]).toEqual([0, 0]);
      expect(inviterDifference).toBe(undefined);
      expect(acceptorDifference).toBe(undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
