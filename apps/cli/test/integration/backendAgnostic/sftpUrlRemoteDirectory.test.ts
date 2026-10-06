import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";

import { formatSftpUrl, parseExchangeSpec } from "@alcove/core";

import { describeCliRun, startCli } from "../../cliProcess";

/**
 * The remote directory the console names for a zero-setup run is the one the
 * CLI uses. The console writes its `sftp://` positional with core's
 * `formatSftpUrl` (held in apps/web's zero-setup argv unit test); each case here
 * hands that URL to a real `alcove init` process, which reads it through the
 * same URL-to-connection builder a zero-setup run uses, and checks the
 * directory the written connection names. No server is contacted.
 *
 * The console's argv builder itself cannot be driven from this project: it
 * lives in apps/web, behind that app's own module aliases.
 */

const RUN_BUDGET_MS = 60_000;
vi.setConfig({ testTimeout: 60_000 });

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-sftp-url-dir-"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

test.each([
  ["an unset", undefined],
  ["a relative", "exchanges/in"],
  ["a %-bearing", "/srv/50%25 off/in"],
])(
  "%s remote directory resolves to the same directory in the CLI",
  async (_label, remoteDirectory) => {
    const url = formatSftpUrl({
      host: "sftp.example.org",
      port: 2222,
      ...(remoteDirectory !== undefined ? { path: remoteDirectory } : {}),
    });
    const run = await startCli({
      args: ["init", url, "--config-file", "alcove.yaml"],
      cwd: work,
      stdin: "",
      timeoutMs: RUN_BUDGET_MS,
    }).finished;
    expect(run.exitCode, describeCliRun("init", run)).toBe(0);

    const written = fs.readFileSync(path.join(work, "alcove.yaml"), "utf8");
    const spec = parseExchangeSpec(YAML.parse(written));
    if (spec.connection.channel !== "sftp")
      throw new Error(`expected an sftp connection, got ${written}`);
    expect(spec.connection.server.host).toBe("sftp.example.org");
    expect(spec.connection.server.port).toBe(2222);
    expect(spec.connection.server.path).toBe(remoteDirectory);
  },
);
