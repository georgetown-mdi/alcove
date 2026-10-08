import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

import { prepareForExchange } from "@alcove/core";
import type { ConnectionConfig, ExchangeSpec } from "@alcove/core";

import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";

/**
 * A failed run under --event-stream, as a supervisor sees it: the CLI as a
 * child process with fd 3 wired to a pipe, its exit status, and every line it
 * wrote there. The child loads tsx in its own process rather than through
 * `tsx/cli`, which runs the entry point in a second process that does not
 * inherit fd 3. Some failures are reported at the command's exit boundary --
 * the configuration load among them -- the others inside the protocol
 * lifecycle; each ends the stream with one `error` event whose `exitCode` is
 * the status the process exits with.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "../../../src/index.ts");

/** 32 zero bytes as base64url: a valid shared secret. */
const SHARED_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const CSV_FIELDS = ["ssn", "last_name", "first_name", "date_of_birth"];
const CSV =
  "ssn,last_name,first_name,date_of_birth\n" +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n";

const RUN_DEADLINE_MS = 60_000;

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-terminal-error-"));
  fs.writeFileSync(path.join(work, "input.csv"), CSV);
  saveKeyFile(path.join(work, "alcove.key"), { sharedSecret: SHARED_SECRET });
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function writeConfig(connection: ConnectionConfig): void {
  const prepared = prepareForExchange(
    {},
    "config",
    [
      {
        ssn: "123456789",
        last_name: "SMITH",
        first_name: "JOHN",
        date_of_birth: "19900115",
      },
    ],
    CSV_FIELDS,
  );
  const spec: ExchangeSpec = {
    connection,
    linkageTerms: prepared.linkageTerms,
    metadata: prepared.metadata,
  };
  saveConfig(path.join(work, "alcove.yaml"), spec);
}

interface FailedRun {
  status: number | null;
  stderr: string;
  events: Array<Record<string, unknown>>;
}

/** Run `alcove exchange` non-interactively with fd 3 wired to a pipe. */
function runExchange(): Promise<FailedRun> {
  return runCli([
    "exchange",
    path.join(work, "input.csv"),
    path.join(work, "out"),
    "--config-file",
    path.join(work, "alcove.yaml"),
    "--key-file",
    path.join(work, "alcove.key"),
    "--no-record",
    "--peer-timeout",
    "5s",
    "--event-stream",
  ]);
}

/** Run the CLI on `args` non-interactively with fd 3 wired to a pipe. */
function runCli(args: Array<string>): Promise<FailedRun> {
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(require.resolve("tsx")).href, cliEntry, ...args],
    { cwd: work, stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  const fd3: Buffer[] = [];
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString("utf8");
  });
  (child.stdio[3] as NodeJS.ReadableStream).on("data", (data: Buffer) => {
    fd3.push(data);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), RUN_DEADLINE_MS);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(deadline);
      resolve({
        status,
        stderr,
        events: Buffer.concat(fd3)
          .toString("utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      });
    });
  });
}

function expectOneTerminalError(
  run: FailedRun,
  loggerName = "exchange",
): Record<string, unknown> {
  const errors = run.events.filter((event) => event.type === "error");
  expect(errors, run.stderr).toHaveLength(1);
  const terminal = run.events.at(-1);
  expect(terminal).toBe(errors[0]);
  expect(terminal?.exitCode).toBe(run.status);
  expect(run.events.some((event) => event.type === "result")).toBe(false);
  // The field is the text of stderr's error line after its log prefix, byte
  // for byte (docs/spec/CLI_EVENTS.md, the error event's `message`).
  expect(run.stderr).toContain(
    `[ERROR] [${loggerName}] ${String(terminal?.message)}\n`,
  );
  return terminal ?? {};
}

test(
  "an unpinned SFTP host on a non-interactive run ends the stream with exitCode 64",
  async () => {
    writeConfig({
      channel: "sftp",
      server: { host: "127.0.0.1", port: 1, username: "alcove" },
    } as ConnectionConfig);
    const run = await runExchange();
    expect(run.status).toBe(64);
    const terminal = expectOneTerminalError(run);
    expect(terminal.message).toContain(
      "no host_key_fingerprint is pinned for this SFTP server",
    );
  },
  RUN_DEADLINE_MS + 10_000,
);

test(
  "a failure inside the protocol lifecycle ends the stream with its exit status",
  async () => {
    writeConfig({
      channel: "filedrop",
      path: path.join(work, "no-such-directory"),
    } as ConnectionConfig);
    const run = await runExchange();
    expect(run.status).not.toBe(0);
    expect(run.events.some((event) => event.type === "metrics")).toBe(true);
    const terminal = expectOneTerminalError(run);
    expect(terminal.cause).toEqual({
      kind: "folder-missing",
      path: path.join(work, "no-such-directory"),
      code: "ENOENT",
    });
    expect(terminal.recoveryHint).toBe(true);
  },
  RUN_DEADLINE_MS + 10_000,
);

test(
  "a partner that never arrives ends the stream with the cause and the wait",
  async () => {
    fs.mkdirSync(path.join(work, "shared"));
    writeConfig({
      channel: "filedrop",
      path: path.join(work, "shared"),
    } as ConnectionConfig);
    const run = await runExchange();
    const terminal = expectOneTerminalError(run);
    expect(terminal.cause).toEqual({
      kind: "partner-never-arrived",
      channel: "filedrop",
      waitedMs: 5000,
    });
    expect(terminal.recoveryHint).toBe(true);
    expect(terminal.message).toContain("--peer-timeout");
  },
  RUN_DEADLINE_MS + 10_000,
);

test(
  "a configuration that is not YAML ends the stream with a config error",
  async () => {
    fs.writeFileSync(path.join(work, "alcove.yaml"), "connection: [unclosed\n");
    const run = await runExchange();
    expect(run.status).toBe(64);
    expect(run.events.some((event) => event.type === "metrics")).toBe(false);
    const terminal = expectOneTerminalError(run);
    expect(terminal.category).toBe("config");
    expect(terminal.message).toContain("could not be parsed as YAML");
  },
  RUN_DEADLINE_MS + 10_000,
);

test(
  "a configuration the schema refuses ends the stream with a config error",
  async () => {
    fs.writeFileSync(
      path.join(work, "alcove.yaml"),
      "connection:\n  channel: carrier-pigeon\n",
    );
    const run = await runExchange();
    expect(run.status).toBe(64);
    const terminal = expectOneTerminalError(run);
    expect(terminal.category).toBe("config");
    expect(terminal.message).toContain("is not a valid exchange spec");
  },
  RUN_DEADLINE_MS + 10_000,
);

test(
  "a missing configuration ends the stream with a config error",
  async () => {
    const run = await runExchange();
    expect(run.status).toBe(64);
    const terminal = expectOneTerminalError(run);
    expect(terminal.category).toBe("config");
    expect(terminal.message).toContain("does not exist");
  },
  RUN_DEADLINE_MS + 10_000,
);

test(
  "a quick exchange refused before it reads its input ends the stream",
  async () => {
    fs.mkdirSync(path.join(work, "shared"));
    const run = await runCli([
      pathToFileURL(path.join(work, "shared")).href,
      path.join(work, "input.csv"),
      "--save",
      "--key-file",
      path.join(work, "alcove.key"),
      "--event-stream",
    ]);
    expect(run.status).toBe(64);
    const terminal = expectOneTerminalError(run, "alcove");
    expect(terminal.message).toContain("alcove.key");
  },
  RUN_DEADLINE_MS + 10_000,
);
