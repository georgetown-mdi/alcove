import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "@alcove/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { configureLogFile } from "../../../src/util/logging";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";

// The Windows branch of the --log-file open, driven on any host: the platform
// is set to win32 for the call, and `icacls` and `whoami` are answered here,
// so what is asserted is the command line the CLI runs and what it does with
// the answer. Whether icacls itself narrows the access list is the credential
// writers' Windows coverage, which runs the same command line.
const execFile = vi.hoisted(() => ({
  commands: [] as string[][],
  icaclsFails: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[]) => {
      execFile.commands.push([file, ...args]);
      if (file === "whoami") return "HOST\\operator\n";
      if (file === "icacls") {
        if (execFile.icaclsFails) throw new Error("icacls exited 5");
        return "";
      }
      throw new Error(`unexpected command ${file}`);
    },
  };
});

let tmpDir: string;

snapshotDiagnosticSinkAndLevel();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-logfile-acl-"));
  execFile.commands = [];
  execFile.icaclsFails = false;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function onWindows<T>(body: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  if (real === undefined) throw new Error("process.platform is not defined");
  Object.defineProperty(process, "platform", { ...real, value: "win32" });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

function icaclsCalls(): string[][] {
  return execFile.commands.filter(([file]) => file === "icacls");
}

test.skipIf(process.platform === "win32")(
  "a log file the run creates has its access list narrowed to the user",
  () => {
    const logPath = path.join(tmpDir, "run.log");
    onWindows(() => configureLogFile(logPath)).close();

    expect(icaclsCalls()).toEqual([
      ["icacls", logPath, "/inheritance:r", "/grant:r", "HOST\\operator:(M)"],
    ]);
  },
);

test.skipIf(process.platform === "win32")(
  "an existing log file keeps its access list",
  () => {
    const logPath = path.join(tmpDir, "run.log");
    fs.writeFileSync(logPath, "earlier line\n");
    onWindows(() => configureLogFile(logPath)).close();

    expect(icaclsCalls()).toEqual([]);
    expect(fs.readFileSync(logPath, "utf8")).toBe("earlier line\n");
  },
);

test.skipIf(process.platform === "win32")(
  "a log file whose access list cannot be narrowed is removed and the run refused",
  () => {
    const logPath = path.join(tmpDir, "run.log");
    execFile.icaclsFails = true;

    let thrown: unknown;
    try {
      onWindows(() => configureLogFile(logPath));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as Error).message).toContain(
      `could not restrict the new log file ${logPath} to your user account, so it was removed.`,
    );
    expect(fs.existsSync(logPath)).toBe(false);
  },
);
