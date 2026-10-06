import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { JobManager } from "@jobs/jobManager";
import { runCapturedCliChild } from "@jobs/capturedCliChild";

import {
  STUB_CLI_PATH,
  tempDataRoot,
  validIntent,
} from "../../utils/jobFixtures";

import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess } from "node:child_process";

// A console child settles only on its `close`: an `error` from a failed kill
// leaves the child running, and a child can end its stdio long before it exits.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  spawnMock.mockImplementation(original.spawn);
  return { ...original, spawn: spawnMock };
});

const dirs: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(async () => {
  spawnMock.mockClear();
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** A spawned child (it has a pid) that the test closes by hand. */
function liveFakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const fd3 = new PassThrough();
  Object.assign(child, {
    pid: 4242,
    stdout,
    stderr,
    stdio: [null, stdout, stderr, fd3],
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });
  return child as unknown as ChildProcess & EventEmitter;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("a captured child settles on close only", () => {
  test("a child that ends its stdio and keeps running settles on its exit", async () => {
    const started = Date.now();
    const outcome = await runCapturedCliChild({
      argv: [
        "-e",
        "process.stdout.write('line\\n', () => { require('fs').closeSync(1); " +
          "require('fs').closeSync(2); setTimeout(() => process.exit(3), 300); });",
      ],
      sigtermMs: 10_000,
      sigkillGraceMs: 1_000,
    });
    expect(outcome).toEqual({ kind: "exited", code: 3, stdout: "line\n" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  test("a child that cannot be spawned settles as a spawn failure", async () => {
    const outcome = await runCapturedCliChild({
      argv: ["-e", "0"],
      cwd: path.join(scratchDir("captured-no-cwd"), "missing"),
      sigtermMs: 10_000,
      sigkillGraceMs: 1_000,
    });
    expect(outcome).toEqual({ kind: "spawnFailed" });
  });

  test("an error on a running child does not settle it", async () => {
    const child = liveFakeChild();
    spawnMock.mockImplementationOnce(() => child);
    let settled = false;
    const outcome = runCapturedCliChild({
      argv: ["probe-host-key"],
      sigtermMs: 10_000,
      sigkillGraceMs: 1_000,
    }).then((value) => {
      settled = true;
      return value;
    });

    child.emit("error", new Error("kill EPERM"));
    await tick();
    expect(settled).toBe(false);

    (child.stdout as PassThrough).end();
    (child.stderr as PassThrough).end();
    child.emit("close", 0, null);
    await expect(outcome).resolves.toEqual({
      kind: "exited",
      code: 0,
      stdout: "",
    });
  });
});

describe("an exchange child settles on close only", () => {
  test("an error on a running child leaves the run unsettled until close", async () => {
    const child = liveFakeChild();
    spawnMock.mockImplementationOnce(() => child);
    const manager = new JobManager({
      dataRoot: scratchDir("exchange-close-root"),
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: scratchDir("exchange-close-rvz"),
    });
    managers.push(manager);
    const id = await manager.createJob(validIntent());
    const record = manager.getJob(id)!;

    child.emit("error", new Error("kill EPERM"));
    await tick();
    expect(record.terminal).toBeNull();
    expect(manager.getJobView(id)?.recordUnavailableReason).toBe("not-settled");

    child.emit("close", 1, null);
    await tick();
    expect(record.terminal).toEqual({
      outcome: "failed",
      exitCode: 1,
      signal: null,
    });
  });
});
