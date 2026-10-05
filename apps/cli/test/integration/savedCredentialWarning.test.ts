import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import YAML from "yaml";

import { parseExchangeSpec } from "@alcove/core";
import type { SFTPConnectionConfig } from "@alcove/core";

import { describeCliRun, startCli } from "../cliProcess";
import type { FinishedCli } from "../cliProcess";
import { inProcessOnly } from "../sftpBackendGate";
import { localPath, remotePath, sftpServer } from "../sftpServer/testContext";

/**
 * The quick exchange's `--save`, run as an operator types it: two `alcove`
 * processes against the test SFTP server, each saving the configuration it
 * ran on. A password typed into the URL is saved as typed, and the run says so
 * and names the `@path` form; a password given as an `@path` is saved as that
 * reference, with no warning. Either way the saved file is owner-only.
 *
 * In-process backend only: the URL carries a password, and the native sshd
 * backend authenticates by public key.
 */

vi.setConfig({ testTimeout: 120_000 });

const RUN_BUDGET_MS = 90_000;

const INPUT_A =
  "first_name,last_name,date_of_birth\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n";
const INPUT_B =
  "first_name,last_name,date_of_birth\n" +
  "Zoe,Adams,2001-03-03\n" +
  "Bob,Jones,1990-01-02\n";

const SAVED_WARNING =
  "holds a credential as typed in connection.server.password";
const COMMAND_LINE_NOTICE = "the command line holds a credential as typed";

const srv = sftpServer();
const LOCAL_ROOT = localPath(srv, "savedcredential");
const REMOTE_ROOT = remotePath(srv, "savedcredential");

let work: string;

beforeAll(async () => {
  await fsp.rm(LOCAL_ROOT, { recursive: true, force: true });
  await fsp.mkdir(LOCAL_ROOT, { recursive: true });
});

afterAll(async () => {
  await fsp.rm(LOCAL_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-saved-credential-"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** Run both parties of one `--save` quick exchange; `urlFor` builds each URL. */
async function saveBoth(
  tag: string,
  party: (side: "a" | "b") => { url: string; extra: string[] },
): Promise<{ a: FinishedCli; b: FinishedCli }> {
  await fsp.mkdir(path.join(LOCAL_ROOT, tag), { recursive: true });
  const run = (side: "a" | "b", input: string) => {
    const cwd = path.join(work, side);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "in.csv"), input);
    const { url, extra } = party(side);
    return startCli({
      args: [
        "--save",
        "--identity",
        `party ${side}`,
        "--server-host-key-fingerprint",
        srv.hostKeyFingerprint,
        "--polling-frequency",
        "200ms",
        ...extra,
        url,
        "in.csv",
        "out",
      ],
      cwd,
      timeoutMs: RUN_BUDGET_MS,
    }).finished;
  };
  const [a, b] = await Promise.all([run("a", INPUT_A), run("b", INPUT_B)]);
  return { a, b };
}

function savedServer(side: "a" | "b"): SFTPConnectionConfig["server"] {
  const configPath = path.join(work, side, "alcove.yaml");
  if (process.platform !== "win32")
    expect(fs.statSync(configPath).mode & 0o077).toBe(0);
  const spec = parseExchangeSpec(
    YAML.parse(fs.readFileSync(configPath, "utf8")),
  );
  expect(spec.connection.channel).toBe("sftp");
  return (spec.connection as SFTPConnectionConfig).server;
}

inProcessOnly(
  "--save with a password in the URL saves it, warns, and names the @path form",
  async () => {
    const tag = "literal";
    const { a, b } = await saveBoth(tag, (side) => {
      const user = side === "a" ? srv.usera : srv.userb;
      return {
        url: `sftp://${user.username}:${user.password}@${srv.host}:${srv.port}${REMOTE_ROOT}/${tag}`,
        extra: [],
      };
    });
    for (const [side, run] of [
      ["a", a],
      ["b", b],
    ] as const) {
      expect(run.exitCode, describeCliRun(`party ${side}`, run)).toBe(0);
      expect(run.stderr).toContain(
        "the configuration saved to ./alcove.yaml " + SAVED_WARNING,
      );
      expect(run.stderr).toContain('password: "@./sftp-password.txt"');
      expect(run.stderr).toContain(`${COMMAND_LINE_NOTICE} in the URL`);
      const user = side === "a" ? srv.usera : srv.userb;
      expect(savedServer(side).password).toBe(user.password);
    }
  },
);

inProcessOnly(
  "--save with the password as an @path saves the reference and does not warn",
  async () => {
    const tag = "reference";
    const { a, b } = await saveBoth(tag, (side) => {
      const user = side === "a" ? srv.usera : srv.userb;
      const passwordFile = path.join(work, `${side}-password.txt`);
      fs.writeFileSync(passwordFile, `${user.password}\n`);
      return {
        url: `sftp://${user.username}@${srv.host}:${srv.port}${REMOTE_ROOT}/${tag}`,
        extra: ["--server-password", `@${passwordFile}`],
      };
    });
    for (const [side, run] of [
      ["a", a],
      ["b", b],
    ] as const) {
      expect(run.exitCode, describeCliRun(`party ${side}`, run)).toBe(0);
      expect(run.stderr).not.toContain(SAVED_WARNING);
      expect(run.stderr).not.toContain(COMMAND_LINE_NOTICE);
      expect(savedServer(side).password).toBe(
        `@${path.join(work, `${side}-password.txt`)}`,
      );
    }
  },
);
