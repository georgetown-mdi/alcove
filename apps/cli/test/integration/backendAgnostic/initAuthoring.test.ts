import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";

import { parseExchangeSpec, safeParseMetadata } from "@alcove/core";

import { describeCliRun, startCli } from "../../cliProcess";
import type { FinishedCli } from "../../cliProcess";
import { ACCEPT_NEEDS_TERMINAL } from "../../../src/commands/accept";
import { configPlaceholderFields } from "../../../src/config";

/**
 * First-time authoring as an operator types it: `alcove init` given a server
 * URL, the refusal an exchange gives a file that still holds a placeholder,
 * and an acceptance run without a terminal. Each run is a real `alcove`
 * process over its own argv, so the positional and flag parsing under test
 * is the CLI's own. No server is contacted: init reads none, and the two
 * refusals come before any connection.
 */

const RUN_BUDGET_MS = 60_000;

// A test here runs up to three cold `alcove` processes. The slowest full-suite
// run measured under container load (load average ~26 on 10 cores) took 40 s,
// for the three-process acceptance test; 60 s is a 1.5x margin over it.
vi.setConfig({ testTimeout: 60_000 });

const INPUT_CSV =
  "member_id,first_name,last_name,dob,score,notes\n" +
  "M-1,Alice,Smith,1990-01-02,5,first\n";

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-init-authoring-"));
  fs.writeFileSync(path.join(work, "in.csv"), INPUT_CSV);
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

async function alcove(args: string[], stdin = ""): Promise<FinishedCli> {
  return startCli({ args, cwd: work, stdin, timeoutMs: RUN_BUDGET_MS })
    .finished;
}

test("init from an sftp URL writes a connection block that needs only a credential", async () => {
  const run = await alcove([
    "init",
    "sftp://alice@sftp.example.org:2222/exchanges/drop",
    "in.csv",
    "--identity",
    "Agency A, Health Dept, data@agency-a.example",
    "--config-file",
    "alcove.yaml",
  ]);
  expect(run.exitCode, describeCliRun("init", run)).toBe(0);
  expect(run.stderr).toContain("add your SFTP credential to connection.server");
  expect(run.stderr).not.toContain("replace the placeholder");

  const written = fs.readFileSync(path.join(work, "alcove.yaml"), "utf8");
  const spec = parseExchangeSpec(YAML.parse(written));
  expect(spec.connection).toMatchObject({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      port: 2222,
      username: "alice",
      path: "/exchanges/drop",
    },
  });
  expect(configPlaceholderFields(spec, [])).toEqual([]);

  // The columns the inference did not declare are listed, commented, and
  // uncommenting them yields metadata the schema accepts, each one sent.
  const lines = written.split("\n");
  const start = lines.indexOf("metadata:");
  const end = lines.findIndex(
    (line, index) => index > start && /^\S/.test(line),
  );
  const uncommented = lines
    .slice(start, end)
    .map((line) => line.replace(/^( {2})# (- name: | {2})/, "$1$2"))
    .join("\n");
  const metadata = (YAML.parse(uncommented) as { metadata: unknown }).metadata;
  const parsedMetadata = safeParseMetadata(metadata);
  expect(parsedMetadata.success).toBe(true);
  const declared = parsedMetadata.success ? parsedMetadata.data : [];
  for (const name of ["score", "notes"])
    expect(declared.find((column) => column.name === name)).toMatchObject({
      role: "payload",
      isPayload: true,
    });
});

test("an exchange refuses an init template's placeholder, naming the field", async () => {
  const init = await alcove([
    "init",
    "--channel",
    "filedrop",
    "--identity",
    "Agency A",
    "--config-file",
    "alcove.yaml",
  ]);
  expect(init.exitCode, describeCliRun("init", init)).toBe(0);
  expect(init.stderr).toContain("replace the placeholder in connection.path");

  const run = await alcove([
    "exchange",
    "--config-file",
    "alcove.yaml",
    "--key-file",
    ".alcove.key",
    "in.csv",
    "out.csv",
  ]);
  expect(run.exitCode, describeCliRun("exchange", run)).toBe(64);
  expect(run.stderr).toContain(
    "still has a REPLACE_WITH_... placeholder as connection.path",
  );
});

test("init refuses a password in the URL and writes nothing", async () => {
  const run = await alcove([
    "init",
    "sftp://alice:secret@sftp.example.org/drop",
    "--config-file",
    "alcove.yaml",
  ]);
  expect(run.exitCode, describeCliRun("init", run)).toBe(64);
  expect(run.stderr).not.toContain("secret");
  expect(fs.existsSync(path.join(work, "alcove.yaml"))).toBe(false);
});

test("accept with no terminal and no --consent-to-terms exits 64 before the terms", async () => {
  const invite = await alcove([
    "init",
    pathToFileURL(path.join(work, "drop")).href,
    "in.csv",
    "--identity",
    "Agency A",
    "--config-file",
    "inviter.yaml",
  ]);
  expect(invite.exitCode, describeCliRun("init", invite)).toBe(0);
  const minted = await alcove([
    "invite",
    "--config-file",
    "inviter.yaml",
    "--key-file",
    "inviter.key",
  ]);
  expect(minted.exitCode, describeCliRun("invite", minted)).toBe(0);
  const invitation = minted.stdout.trim().split("\n")[0]!;

  // A piped answer is not a terminal: the acceptance refuses rather than
  // reading the line, and shows none of the terms it cannot ask about.
  const run = await alcove(
    [
      "accept",
      invitation,
      "in.csv",
      "--identity",
      "Agency B",
      "--config-file",
      "acceptor.yaml",
      "--key-file",
      "acceptor.key",
    ],
    "y\n",
  );
  expect(run.exitCode, describeCliRun("accept", run)).toBe(64);
  expect(run.stderr).toContain(ACCEPT_NEEDS_TERMINAL);
  expect(run.stdout + run.stderr).not.toContain("linkage keys");
  expect(fs.existsSync(path.join(work, "acceptor.yaml"))).toBe(false);
  expect(fs.existsSync(path.join(work, "acceptor.key"))).toBe(false);
});

test.each([
  ["a space in the host", "sftp://user:pwDISTINCT7@ho st/x"],
  ["a port out of range", "sftp://user:pwDISTINCT7@host:99999/x"],
  ["a single slash after the scheme", "sftp:/user:pwDISTINCT7@host/x"],
  ["a file URL naming a remote host", "file://remote/pwDISTINCT7"],
])(
  "init refuses an unparsable URL with %s and prints none of it",
  async (_label, url) => {
    const run = await alcove([
      "init",
      url,
      "--config-file",
      "alcove.yaml",
      "--log-file",
      "run.log",
    ]);
    expect(run.exitCode, describeCliRun("init", run)).toBe(64);
    const log = fs.readFileSync(path.join(work, "run.log"), "utf8");
    expect(log).toMatch(/could not (read|use) the URL/);
    for (const text of [run.stdout, run.stderr, log])
      expect(text).not.toContain("pwDISTINCT7");
    expect(fs.existsSync(path.join(work, "alcove.yaml"))).toBe(false);
  },
);
