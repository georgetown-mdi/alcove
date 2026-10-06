import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ConsoleShuttingDownError, JobManager } from "@jobs/jobManager";

import {
  STUB_CLI_PATH,
  trackScratchDirs,
  validIntent,
} from "../../utils/jobFixtures";

import type * as WorkdirModule from "@jobs/workdir";

// Once the server has begun shutting down, a child spawned now would be killed
// mid-run or outlive the server, so every spawn is refused.

const { removal } = vi.hoisted(() => ({ removal: { fail: false } }));

vi.mock("@jobs/workdir", async (importOriginal) => {
  const original = await importOriginal<typeof WorkdirModule>();
  return {
    ...original,
    removeWorkdir: async (workdir: string) => {
      if (removal.fail) throw new Error("EACCES: permission denied, rmdir");
      await original.removeWorkdir(workdir);
    },
  };
});

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();

afterEach(() => {
  removal.fail = false;
  removeScratchDirs();
});

function manager(argvFile: string): { manager: JobManager; dataRoot: string } {
  const dataRoot = scratchDir("spawn-refusal-root");
  return {
    dataRoot,
    manager: new JobManager({
      dataRoot,
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: scratchDir("spawn-refusal-rvz"),
      childEnv: { STUB_ARGV_FILE: argvFile },
    }),
  };
}

describe("spawns are refused once shutdown has started", () => {
  test("a create after shutdown is refused with nothing on disk and the slot free", async () => {
    const argvFile = path.join(scratchDir("spawn-refusal-argv"), "argv");
    const { manager: jobs, dataRoot } = manager(argvFile);
    await jobs.shutdown();

    await expect(jobs.createJob(validIntent())).rejects.toBeInstanceOf(
      ConsoleShuttingDownError,
    );
    expect(jobs.occupiedSlotId()).toBeNull();
    expect(fs.readdirSync(dataRoot)).toEqual([]);
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  test("a create in flight when shutdown starts spawns no child and removes its folder", async () => {
    const argvFile = path.join(scratchDir("spawn-refusal-argv"), "argv");
    const { manager: jobs, dataRoot } = manager(argvFile);

    const created = jobs.createJob(validIntent());
    await jobs.shutdown();

    await expect(created).rejects.toBeInstanceOf(ConsoleShuttingDownError);
    expect(jobs.occupiedSlotId()).toBeNull();
    expect(fs.readdirSync(dataRoot)).toEqual([]);
    expect(fs.existsSync(argvFile)).toBe(false);
  });

  test("a failed folder removal does not replace the refusal", async () => {
    const argvFile = path.join(scratchDir("spawn-refusal-argv"), "argv");
    const { manager: jobs } = manager(argvFile);
    removal.fail = true;

    const created = jobs.createJob(validIntent());
    await jobs.shutdown();

    await expect(created).rejects.toBeInstanceOf(ConsoleShuttingDownError);
    expect(jobs.occupiedSlotId()).toBeNull();
  });

  test("the host-key probe, the signing fingerprint and the terms apply are refused", async () => {
    const argvFile = path.join(scratchDir("spawn-refusal-argv"), "argv");
    const { manager: jobs } = manager(argvFile);
    await jobs.shutdown();

    await expect(
      jobs.probeSftpHostKey({ host: "sftp.example.org" }),
    ).rejects.toBeInstanceOf(ConsoleShuttingDownError);
    await expect(
      jobs.resolveSigningFingerprint({
        identityLabel: "inviter",
        exportCertificate: false,
      }),
    ).rejects.toBeInstanceOf(ConsoleShuttingDownError);
    await expect(
      jobs.applyTermsProposal("00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(ConsoleShuttingDownError);
    expect(fs.existsSync(argvFile)).toBe(false);
  });
});
