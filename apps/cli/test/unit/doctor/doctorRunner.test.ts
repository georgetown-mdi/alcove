import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { MAX_DIRECTORY_ENTRIES } from "../../../src/connection/listingGuard";
import { countEntries, freeMegabytes } from "../../../src/doctor/probe";
import {
  KILL_GRACE_MS,
  MAX_CAPTURED_OUTPUT,
  nodeCommandRunner,
} from "../../../src/doctor/runner";

// Driven against a real child process rather than a mock: the properties that
// make this boundary safe -- no shell, a bounded wait, and a child environment
// with the password removed -- are properties of the spawn, so only a spawn can
// establish them.

const NODE = process.execPath;
const RUN_TIMEOUT_MS = 20_000;

function evaluate(source: string): string[] {
  return ["-e", source];
}

describe("the process runner", () => {
  test("captures stdout and stderr together with the exit status", async () => {
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate(
        "process.stdout.write('out\\n');process.stderr.write('err\\n');process.exit(3)",
      ),
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.code).toBe(3);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.timedOut).toBe(false);
    expect(result.spawnErrorCode).toBeUndefined();
  });

  test("passes arguments as an array, so shell syntax in one stays data", async () => {
    // The server, share, path, username, and domain are operator input and land
    // in these arguments; a shell-interpolated command line would execute what
    // is only meant to be a folder name.
    const hostile = "q3;touch /tmp/alcove-doctor-should-not-exist";
    const result = await nodeCommandRunner.run(
      NODE,
      [...evaluate("process.stdout.write(process.argv[1])"), hostile],
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.output).toBe(hostile);
  });

  test("reports a binary that is not installed as a spawn failure, not an exit", async () => {
    const result = await nodeCommandRunner.run(
      "alcove-no-such-binary-exists",
      [],
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.spawnErrorCode).toBe("ENOENT");
    expect(result.code).toBeNull();
  });

  test("kills a child that never answers, and says the wait ran out", async () => {
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate("setInterval(() => {}, 1000)"),
      { timeoutMs: 250 },
    );
    expect(result.timedOut).toBe(true);
  });

  test("stops a child when told to, without calling it a timeout", async () => {
    const stop = new AbortController();
    const pending = nodeCommandRunner.run(
      NODE,
      evaluate("setInterval(() => {}, 1000)"),
      { timeoutMs: RUN_TIMEOUT_MS, signal: stop.signal },
    );
    stop.abort();
    const result = await pending;
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test("follows a stop the child ignores with SIGKILL after the grace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-runner-"));
    const ready = path.join(dir, "ready");
    try {
      const stop = new AbortController();
      const pending = nodeCommandRunner.run(
        NODE,
        evaluate(
          "process.on('SIGTERM', () => {});" +
            `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '');` +
            "setInterval(() => {}, 1000)",
        ),
        { timeoutMs: RUN_TIMEOUT_MS, signal: stop.signal },
      );
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), {
        timeout: RUN_TIMEOUT_MS,
      });
      const stoppedAt = Date.now();
      stop.abort();
      const result = await pending;
      expect(result.code).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(KILL_GRACE_MS - 50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not call an aborted run a timeout that fires in the kill grace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-runner-"));
    const ready = path.join(dir, "ready");
    try {
      const stop = new AbortController();
      const pending = nodeCommandRunner.run(
        NODE,
        evaluate(
          "process.on('SIGTERM', () => {});" +
            `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '');` +
            "setInterval(() => {}, 1000)",
        ),
        { timeoutMs: KILL_GRACE_MS - 100, signal: stop.signal },
      );
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), {
        timeout: KILL_GRACE_MS - 200,
      });
      stop.abort();
      const result = await pending;
      expect(result.code).toBeNull();
      expect(result.timedOut).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawns nothing once already told to stop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-runner-"));
    const created = path.join(dir, "created");
    try {
      const stop = new AbortController();
      stop.abort();
      const result = await nodeCommandRunner.run(
        NODE,
        evaluate(
          `require('node:fs').writeFileSync(${JSON.stringify(created)}, '')`,
        ),
        { timeoutMs: RUN_TIMEOUT_MS, signal: stop.signal },
      );
      expect(result.code).toBeNull();
      expect(fs.existsSync(created)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes the password variable from the child's environment", async () => {
    process.env["SMB_PASS"] = "must-not-reach-the-child";
    try {
      const result = await nodeCommandRunner.run(
        NODE,
        evaluate(
          "process.stdout.write(String(process.env.SMB_PASS)+'|'+String(process.env.PATH !== undefined))",
        ),
        { timeoutMs: RUN_TIMEOUT_MS },
      );
      // The password is gone; the rest of the environment the child needs is not.
      expect(result.output).toBe("undefined|true");
    } finally {
      delete process.env["SMB_PASS"];
    }
  });

  test("runs the child in the working directory it is given", async () => {
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate("process.stdout.write(process.cwd())"),
      { cwd: __dirname, timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.output).toContain("unit");
  });

  test("bounds the output it captures from a torrential child", async () => {
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate(
        `for (let i = 0; i < ${Math.ceil(MAX_CAPTURED_OUTPUT / 1000) + 100}; i++) process.stdout.write('x'.repeat(1000))`,
      ),
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.output.length).toBe(MAX_CAPTURED_OUTPUT);
    expect(result.truncated).toBe(true);
  });

  test("holds a listing one entry past the directory-listing bound in full", async () => {
    // Every entry at the longest smbclient prints: a 255-character name, the
    // attributes, a 20-digit size, and the date. Modeled on smbclient's `ls`
    // line format, not captured from it.
    const entries = MAX_DIRECTORY_ENTRIES + 1;
    const result = await nodeCommandRunner.run(
      NODE,
      evaluate(
        [
          "const date = 'Mon Jan  1 00:00:00 2024';",
          `for (let i = 0; i < ${entries}; i++) {`,
          "  const name = String(i).padStart(255, 'n');",
          "  process.stdout.write('  ' + name + 'AHSRDNT'.padStart(7) + ' ' +",
          "    '18446744073709551615'.padStart(8) + '  ' + date + '\\n');",
          "}",
          "process.stdout.write('\\n\\t\\t1024 blocks of size 1048576. 512 blocks available\\n');",
        ].join("\n"),
      ),
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    expect(result.truncated).toBe(false);
    expect(countEntries(result.output)).toBe(entries);
    expect(freeMegabytes(result.output)).toBe(512);
  });
});
