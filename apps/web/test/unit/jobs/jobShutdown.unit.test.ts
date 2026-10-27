import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { stringify as stringifyYaml } from "yaml";

import { snakeizeKeys } from "@alcove/core";

import { JobManager } from "@jobs/jobManager";
import { registerJobManagerShutdown } from "@jobs/index";
import { runCapturedCliChild } from "@jobs/capturedCliChild";

import {
  createCloseHooks,
  installGracefulShutdown,
} from "../../../server/console/shutdown";

import {
  STUB_CLI_PATH,
  VALID_SHARED_SECRET,
  trackScratchDirs,
  validIntent,
  validLinkageTerms,
} from "../../utils/jobFixtures";
import { waitFor } from "../../utils/waitFor";

import type { JobFiledropExchangeIntent } from "@jobContract/intentSchemas";
import type { JobRecord } from "@jobs/jobManager";

// A server shutting down while a CLI child runs must wait for the child to
// exit: in the image the server is PID 1, so its exit kills the child
// mid-cleanup, and elsewhere the child would outlive it.

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();

afterEach(() => {
  globalThis.jobManagerInstance = undefined;
  vi.restoreAllMocks();
  removeScratchDirs();
});

/**
 * A manager running one stub exchange that stays up until signalled, with the
 * child's signal handlers installed before this resolves. `cleanupFile` is
 * written by the child just before its SIGTERM exit.
 */
async function runningJob(
  childEnv: NodeJS.ProcessEnv,
  options: { cancelSigkillGraceMs?: number } = {},
): Promise<{ manager: JobManager; record: JobRecord; cleanupFile: string }> {
  const scratch = scratchDir("shutdown-scratch");
  const readyFile = path.join(scratch, "ready");
  const cleanupFile = path.join(scratch, "cleaned-up");
  const manager = new JobManager({
    dataRoot: scratchDir("shutdown-root"),
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("shutdown-rvz"),
    ...options,
    childEnv: {
      STUB_FD3_EVENTS: "[]",
      STUB_DELAY_MS: "30000",
      STUB_READY_FILE: readyFile,
      STUB_SIGTERM_CLEANUP_FILE: cleanupFile,
      ...childEnv,
    },
  });
  const record = manager.getJob(await manager.createJob(validIntent()))!;
  await waitFor(() => fs.existsSync(readyFile));
  return { manager, record, cleanupFile };
}

describe("JobManager.shutdown waits for the running child", () => {
  test("it resolves only after the child has finished its SIGTERM cleanup", async () => {
    const { manager, record, cleanupFile } = await runningJob({
      STUB_SIGTERM_CLEANUP_MS: "400",
    });
    const started = Date.now();
    await manager.shutdown();
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(fs.existsSync(cleanupFile)).toBe(true);
    expect(record.terminal).toEqual({
      outcome: "cancelled",
      exitCode: 143,
      signal: null,
    });
  });

  test("it SIGKILLs a child still running after the grace, then resolves on its exit", async () => {
    const { manager, record } = await runningJob(
      { STUB_IGNORE_SIGTERM: "1" },
      { cancelSigkillGraceMs: 200 },
    );
    await manager.shutdown();
    expect(record.terminal).toEqual({
      outcome: "failed",
      exitCode: null,
      signal: "SIGKILL",
    });
  });

  test("a repeated call waits on the same exit", async () => {
    const { manager, record } = await runningJob({
      STUB_SIGTERM_CLEANUP_MS: "200",
    });
    const first = manager.shutdown();
    const second = manager.shutdown();
    expect(second).toBe(first);
    await second;
    expect(record.terminal?.exitCode).toBe(143);
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  test("it resolves at once when no exchange is running", async () => {
    const manager = new JobManager({
      dataRoot: scratchDir("shutdown-idle"),
      binaryPath: STUB_CLI_PATH,
    });
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

/** Whether a process with this pid still runs (a reaped child does not). */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a stub child wrote to `pidFile`, once it has written it. */
async function pidIn(pidFile: string): Promise<number> {
  await waitFor(
    () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "",
  );
  return Number(fs.readFileSync(pidFile, "utf8"));
}

/** A captured child's operation started on a manager, and the child's pid. */
interface RunningCapturedChild {
  manager: JobManager;
  operation: Promise<unknown>;
  pid: number;
}

type ManagerOptions = { cancelSigkillGraceMs?: number };

/** A host-key probe whose stub child waits until signalled. */
async function runningProbe(
  stub: NodeJS.ProcessEnv,
  options: ManagerOptions,
): Promise<RunningCapturedChild> {
  const pidFile = path.join(scratchDir("probe-pid"), "pid");
  const manager = new JobManager({
    dataRoot: scratchDir("probe-root"),
    binaryPath: STUB_CLI_PATH,
    childEnv: { STUB_DELAY_MS: "30000", STUB_PID_FILE: pidFile, ...stub },
    ...options,
  });
  const operation = manager.probeSftpHostKey({ host: "sftp.example.org" });
  return { manager, operation, pid: await pidIn(pidFile) };
}

/** A signing fingerprint whose stub child waits until signalled. */
async function runningFingerprint(
  stub: NodeJS.ProcessEnv,
  options: ManagerOptions,
): Promise<RunningCapturedChild> {
  const pidFile = path.join(scratchDir("fingerprint-pid"), "pid");
  const manager = new JobManager({
    dataRoot: scratchDir("fingerprint-root"),
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("fingerprint-rvz"),
    jobSecretsDir: scratchDir("fingerprint-secrets"),
    childEnv: { STUB_DELAY_MS: "30000", STUB_PID_FILE: pidFile, ...stub },
    ...options,
  });
  const operation = manager.resolveSigningFingerprint({
    identityLabel: "Agency A",
    exportCertificate: false,
  });
  return { manager, operation, pid: await pidIn(pidFile) };
}

/**
 * A terms apply whose stub child waits until signalled, over the proposal a
 * run of the opened configuration stopped on.
 */
async function runningTermsApply(
  stub: NodeJS.ProcessEnv,
  options: ManagerOptions,
): Promise<RunningCapturedChild> {
  const root = scratchDir("apply-root");
  fs.writeFileSync(
    path.join(root, "alcove.yaml"),
    stringifyYaml(
      snakeizeKeys({
        connection: { channel: "filedrop", path: "/srv/exchange" },
        linkageTerms: validLinkageTerms(),
      }),
    ),
  );
  fs.writeFileSync(
    path.join(root, ".alcove.key"),
    JSON.stringify({ sharedSecret: VALID_SHARED_SECRET }),
    { mode: 0o600 },
  );
  const pidFile = path.join(scratchDir("apply-pid"), "pid");
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir("apply-rvz"),
    childEnv: {
      STUB_FD3_EVENTS: JSON.stringify([
        {
          v: 1,
          type: "error",
          category: "config",
          message: "this run is not attended.",
          termsChange: { proposalWritten: true, otherTerms: [] },
        },
      ]),
      STUB_EXIT_CODE: "64",
      STUB_TERMS_PROPOSAL: "proposal",
      STUB_APPLY_DELAY_MS: "30000",
      STUB_PID_FILE: pidFile,
      ...stub,
    },
    ...options,
  });
  manager.openMountedConfiguration();
  const { sharedSecret: _omitted, ...intent } = validIntent();
  const opened: JobFiledropExchangeIntent = {
    ...intent,
    mountedConfigurationOpened: true,
  };
  const record = manager.getJob(await manager.createJob(opened))!;
  await waitFor(() => record.terminal !== null, {
    timeoutMs: 5000,
    message: "the exchange child did not exit",
  });
  expect(record.termsProposal).toBe("available");
  const operation = manager.applyTermsProposal(record.id);
  return { manager, operation, pid: await pidIn(pidFile) };
}

const CAPTURED_CHILDREN = [
  ["host-key probe", runningProbe],
  ["signing fingerprint", runningFingerprint],
  ["terms apply", runningTermsApply],
] as const;

describe("JobManager.shutdown stops every captured child", () => {
  test.each(CAPTURED_CHILDREN)(
    "it stops a running %s child before it resolves",
    async (_name, running) => {
      const { manager, operation, pid } = await running({}, {});

      await manager.shutdown();

      expect(processRuns(pid)).toBe(false);
      await expect(operation).resolves.toBeDefined();
    },
  );

  test.each(CAPTURED_CHILDREN)(
    "it SIGKILLs a %s child still running after the grace",
    async (_name, running) => {
      const { manager, operation, pid } = await running(
        { STUB_IGNORE_SIGTERM: "1" },
        { cancelSigkillGraceMs: 200 },
      );
      const started = Date.now();

      await manager.shutdown();

      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      expect(processRuns(pid)).toBe(false);
      await expect(operation).resolves.toBeDefined();
    },
  );

  test("a child that has already exited does not delay it", async () => {
    const manager = new JobManager({
      dataRoot: scratchDir("probe-done-root"),
      binaryPath: STUB_CLI_PATH,
    });
    expect(
      (await manager.probeSftpHostKey({ host: "sftp.example.org" })).kind,
    ).toBe("ok");

    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

describe("a captured child's stop", () => {
  test("ends a child that never started without throwing", async () => {
    const outcome = await runCapturedCliChild({
      argv: ["-e", "0"],
      cwd: path.join(scratchDir("stop-no-cwd"), "missing"),
      sigtermMs: 10_000,
      sigkillGraceMs: 1_000,
      stop: { signal: AbortSignal.abort(), sigkillGraceMs: 1_000 },
    });
    expect(outcome).toEqual({ kind: "spawnFailed" });
  });

  test("signals nothing and does not throw once the child has exited", async () => {
    // The child exits at once while a grandchild holds its stdout open, so
    // the stop arrives after the exit and before the child settles.
    const pidFile = path.join(scratchDir("stop-exited"), "pids.json");
    const holdsStdout =
      "const { spawn } = require('node:child_process');" +
      "const held = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']," +
      " { stdio: ['ignore', 'inherit', 'ignore'] });" +
      "require('node:fs').writeFileSync(process.argv[1]," +
      " JSON.stringify({ child: process.pid, grandchild: held.pid }));" +
      "process.exit(0);";
    const stop = new AbortController();
    let settled = false;
    const outcome = runCapturedCliChild({
      argv: ["-e", holdsStdout, pidFile],
      sigtermMs: 10_000,
      sigkillGraceMs: 1_000,
      stop: { signal: stop.signal, sigkillGraceMs: 100 },
    }).then((value) => {
      settled = true;
      return value;
    });
    await waitFor(
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "",
    );
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
      child: number;
      grandchild: number;
    };
    try {
      await waitFor(() => !processRuns(pids.child));
      expect(settled).toBe(false);

      expect(() => stop.abort()).not.toThrow();

      await expect(outcome).resolves.toEqual({
        kind: "exited",
        code: 0,
        stdout: "",
      });
    } finally {
      if (processRuns(pids.grandchild)) process.kill(pids.grandchild);
    }
  });
});

/**
 * Drive `manager` through the console server's own graceful shutdown: a
 * SIGTERM to this process, answered by the handlers the server installs, and
 * resolve once they call `process.exit`, with what `atExit` saw then.
 */
async function consoleServerShutdown<TSeen>(
  manager: JobManager,
  atExit: () => TSeen,
): Promise<TSeen> {
  globalThis.jobManagerInstance = manager;

  // Signal listeners already on this process (the test runner's) are set
  // aside, so the emitted SIGTERM reaches only the handlers under test.
  const signals = ["SIGINT", "SIGTERM"] as const;
  const runnerListeners = new Map(
    signals.map((signal) => [signal, process.listeners(signal)]),
  );
  for (const signal of signals) process.removeAllListeners(signal);

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const hooks = createCloseHooks();
    registerJobManagerShutdown(hooks);
    installGracefulShutdown(server, hooks, { timeoutMs: 30_000 });

    const seenAtExit = new Promise<TSeen>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation((() => {
        resolve(atExit());
      }) as () => never);
    });

    process.emit("SIGTERM", "SIGTERM");
    return await seenAtExit;
  } finally {
    for (const signal of signals) {
      process.removeAllListeners(signal);
      for (const listener of runnerListeners.get(signal)!)
        process.on(signal, listener);
    }
    if (server.listening) server.close();
  }
}

describe("the console server's graceful shutdown", () => {
  test("exits the process only after the running exchange child has exited", async () => {
    const { manager, record, cleanupFile } = await runningJob({
      STUB_SIGTERM_CLEANUP_MS: "400",
    });

    const childExitedAtProcessExit = await consoleServerShutdown(
      manager,
      () => record.terminal !== null && fs.existsSync(cleanupFile),
    );

    expect(childExitedAtProcessExit).toBe(true);
    expect(record.terminal?.exitCode).toBe(143);
  }, 15000);

  test.each(CAPTURED_CHILDREN)(
    "exits the process only after a running %s child has exited",
    async (_name, running) => {
      const { manager, operation, pid } = await running({}, {});
      let operationSettled = false;
      void operation.finally(() => {
        operationSettled = true;
      });

      const seen = await consoleServerShutdown(manager, () => ({
        childRuns: processRuns(pid),
        operationSettled,
      }));

      expect(seen).toEqual({ childRuns: false, operationSettled: true });
    },
    15000,
  );
});
