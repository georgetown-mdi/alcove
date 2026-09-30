import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  needsPsiHeapRestart,
  psiHeapRestartArgs,
  PSI_HEAP_RESTART_MARKER,
} from "../../src/psiHeapRestart";
import {
  PSI_HEAP_CEILING_BYTES,
  PSI_HEAP_CEILING_MIB,
} from "../../src/psiMemoryBudget";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROBE = fileURLToPath(
  new URL("../psiHeapRestartProbe.ts", import.meta.url),
);
// Two Node starts, each transpiling the probe's imports, on a loaded machine.
const CASE_TIMEOUT_MS = 60_000;
const CEILING_LIMIT_BYTES = PSI_HEAP_CEILING_MIB * 2 ** 20;

interface ProbeReport {
  pid: number;
  restarted: boolean;
  heapLimit: number;
  exposedGc: boolean;
  workerHeapLimit?: number;
  eventStreamWritable: boolean;
}

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) fs.rmSync(scratch, { recursive: true });
  scratch = undefined;
});

function probeEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (extra.NODE_OPTIONS === undefined) delete env.NODE_OPTIONS;
  if (extra[PSI_HEAP_RESTART_MARKER] === undefined)
    delete env[PSI_HEAP_RESTART_MARKER];
  return env;
}

function runProbe(
  extra: NodeJS.ProcessEnv,
  nodeFlags: string[] = [],
  stdio: StdioOptions = ["ignore", "pipe", "pipe"],
) {
  const result = spawnSync(
    process.execPath,
    [...nodeFlags, "--import=tsx", PROBE],
    { cwd: CLI_ROOT, env: probeEnv(extra), encoding: "utf8", stdio },
  );
  const line = result.stdout.split("\n").find((l) => l.startsWith("{"));
  return {
    result,
    report: line === undefined ? undefined : (JSON.parse(line) as ProbeReport),
  };
}

describe("whether a process restarts", () => {
  it("restarts below the ceiling and not at or above it", () => {
    expect(needsPsiHeapRestart(4_395_630_592, {})).toBe(true);
    expect(needsPsiHeapRestart(CEILING_LIMIT_BYTES - 1, {})).toBe(true);
    expect(needsPsiHeapRestart(CEILING_LIMIT_BYTES, {})).toBe(false);
    expect(needsPsiHeapRestart(40e9, {})).toBe(false);
  });

  it("does not restart the restarted process", () => {
    expect(
      needsPsiHeapRestart(4_395_630_592, { [PSI_HEAP_RESTART_MARKER]: "1" }),
    ).toBe(false);
  });

  it("puts the heap flag ahead of the process's own flags", () => {
    expect(
      psiHeapRestartArgs(
        ["--expose-gc", "--max-old-space-size=4096"],
        ["/usr/bin/node", "/opt/alcove/dist/index.js", "exchange", "in.csv"],
      ),
    ).toEqual([
      `--max-old-space-size=${PSI_HEAP_CEILING_MIB}`,
      "--expose-gc",
      "--max-old-space-size=4096",
      "/opt/alcove/dist/index.js",
      "exchange",
      "in.csv",
    ]);
  });
});

// Windows has no signal a process can catch or re-raise on itself.
describe.skipIf(process.platform === "win32")("the restart", () => {
  it(
    "runs the command under the ceiling, keeping Node's flags, and exits with its code",
    () => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-restart-"));
      const workerEntry = path.join(scratch, "worker.cjs");
      fs.writeFileSync(
        workerEntry,
        `const { getHeapStatistics } = require("node:v8");\n` +
          `const { parentPort } = require("node:worker_threads");\n` +
          `parentPort.postMessage(getHeapStatistics().heap_size_limit);\n`,
      );
      const { result, report } = runProbe(
        { PROBE_EXIT_CODE: "7", PROBE_WORKER_ENTRY: workerEntry },
        ["--expose-gc"],
      );
      expect(result.status, result.stderr).toBe(7);
      expect(report).toMatchObject({ restarted: true, exposedGc: true });
      expect(report?.pid).not.toBe(result.pid);
      expect(report?.heapLimit).toBeGreaterThanOrEqual(PSI_HEAP_CEILING_BYTES);
      expect(report?.workerHeapLimit).toBeGreaterThanOrEqual(
        PSI_HEAP_CEILING_BYTES,
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "does not restart a process started at the ceiling, as the image starts it",
    () => {
      const { result, report } = runProbe({
        NODE_OPTIONS: `--max-old-space-size=${PSI_HEAP_CEILING_MIB}`,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(report).toMatchObject({ pid: result.pid, restarted: false });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "does not restart a process started with a larger limit",
    () => {
      const { result, report } = runProbe({
        NODE_OPTIONS: "--max-old-space-size=30000",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(report).toMatchObject({ pid: result.pid, restarted: false });
      expect(report?.heapLimit).toBeGreaterThanOrEqual(30_000 * 2 ** 20);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "does not restart twice",
    () => {
      const { result, report } = runProbe({ [PSI_HEAP_RESTART_MARKER]: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(report?.pid).toBe(result.pid);
      expect(report?.heapLimit).toBeLessThan(CEILING_LIMIT_BYTES);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "ends on the signal that ended the restarted process",
    () => {
      const { result, report } = runProbe({ PROBE_MODE: "die-by-signal" });
      expect(report?.restarted).toBe(true);
      expect(result.signal).toBe("SIGTERM");
      expect(result.status).toBeNull();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "hands the restarted process the event-stream descriptor",
    () => {
      const { result, report } = runProbe(
        { PROBE_EVENT_STREAM: "1" },
        [],
        ["ignore", "pipe", "pipe", "pipe"],
      );
      expect(result.status, result.stderr).toBe(0);
      expect(report?.restarted).toBe(true);
      expect(String(result.output[3])).toBe("event-stream\n");
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "exits 64 when the restart cannot start",
    () => {
      const { result, report } = runProbe({
        PROBE_EXEC_PATH: path.join(os.tmpdir(), "alcove-no-such-node"),
      });
      expect(report).toBeUndefined();
      expect(result.status).toBe(64);
      expect(result.stderr).toContain(
        "could not start the exchange with a larger heap limit",
      );
      expect(result.stderr).toContain(
        `Set NODE_OPTIONS=--max-old-space-size=${PSI_HEAP_CEILING_MIB}`,
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "passes SIGTERM to the restarted process and exits with its code",
    async () => {
      const child = spawn(process.execPath, ["--import=tsx", PROBE], {
        cwd: CLI_ROOT,
        env: probeEnv({ PROBE_MODE: "await-signal" }),
        stdio: ["ignore", "pipe", "inherit"],
        timeout: CASE_TIMEOUT_MS - 10_000,
        killSignal: "SIGKILL",
      });
      let stdout = "";
      let signalled = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!signalled && stdout.includes("ready\n")) {
          signalled = true;
          child.kill("SIGTERM");
        }
      });
      const [code, signal] = await new Promise<
        [number | null, NodeJS.Signals | null]
      >((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode, exitSignal) =>
          resolve([exitCode, exitSignal]),
        );
      });
      expect(stdout).toContain("caught SIGTERM");
      expect([code, signal]).toEqual([143, null]);
    },
    CASE_TIMEOUT_MS,
  );
});
