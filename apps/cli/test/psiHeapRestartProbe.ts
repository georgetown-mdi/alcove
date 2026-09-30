import fs from "node:fs";
import { getHeapStatistics } from "node:v8";

import {
  allowPsiHeapRestart,
  restartedForPsiHeap,
  restartUnderPsiHeapCeiling,
} from "../src/psiHeapRestart";
import { startPsiWorkerThread } from "../src/psiWorkerHost";

/**
 * A command that restarts itself under the PSI heap ceiling, as the CLI's
 * exchange-running commands do, then reports on the process it ended up in.
 * Run as a child process because the restart and the process's end are what
 * is under test. `PROBE_MODE` picks what the reporting process does next:
 *
 * - `exit` (the default): exit with `PROBE_EXIT_CODE`.
 * - `die-by-signal`: end itself with SIGTERM.
 * - `await-signal`: wait for SIGTERM, then exit 143.
 *
 * `PROBE_WORKER_ENTRY` names a worker that posts its heap limit back, started
 * as the PSI worker is. `PROBE_EXEC_PATH` replaces `process.execPath` before
 * the restart, to make the spawn fail.
 */

const report = (line: string): void => {
  fs.writeSync(1, `${line}\n`);
};

async function workerHeapLimit(): Promise<number | undefined> {
  const entry = process.env.PROBE_WORKER_ENTRY;
  if (entry === undefined) return undefined;
  const worker = startPsiWorkerThread(entry, {
    role: "starter",
    id: "heap-restart-probe",
    mode: "identifier-revealing",
  });
  const limit = await new Promise<number>((resolve, reject) => {
    worker.once("message", (value: number) => resolve(value));
    worker.once("error", reject);
  });
  await worker.terminate();
  return limit;
}

async function main(): Promise<void> {
  if (process.env.PROBE_EXEC_PATH !== undefined)
    process.execPath = process.env.PROBE_EXEC_PATH;
  allowPsiHeapRestart();
  await restartUnderPsiHeapCeiling({
    passEventStreamFd: process.env.PROBE_EVENT_STREAM === "1",
  });
  let eventStreamWritable = false;
  if (process.env.PROBE_EVENT_STREAM === "1") {
    fs.writeSync(3, "event-stream\n");
    eventStreamWritable = true;
  }
  report(
    JSON.stringify({
      pid: process.pid,
      restarted: restartedForPsiHeap(),
      heapLimit: getHeapStatistics().heap_size_limit,
      exposedGc: typeof globalThis.gc === "function",
      workerHeapLimit: await workerHeapLimit(),
      eventStreamWritable,
    }),
  );
  const mode = process.env.PROBE_MODE ?? "exit";
  if (mode === "die-by-signal") {
    process.kill(process.pid, "SIGTERM");
    return;
  }
  if (mode === "await-signal") {
    process.on("SIGTERM", () => {
      report("caught SIGTERM");
      process.exit(143);
    });
    report("ready");
    setInterval(() => {}, 60_000);
    return;
  }
  process.exit(Number(process.env.PROBE_EXIT_CODE ?? "0"));
}

void main();
