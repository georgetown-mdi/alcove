import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Starting the child and transpiling what it imports takes seconds on a loaded
// machine.
const CHILD_KILL_MS = 30_000;
const TEST_TIMEOUT_MS = 40_000;

const LINE = "  matched on (enforced): consent-probe-marker";

const PROBE = fileURLToPath(
  new URL("../consentSurfaceLogCopyProbe.ts", import.meta.url),
);
const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-consent-log-copy-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The probe with `--log-file` set to `$2`, as a command inside a `sh -c` script.
const PROBE_COMMAND = `"$0" --import=tsx "$1" "$2" "$3"`;

/**
 * Run `script` through `sh` with the probe's arguments in place (`$4` is
 * `pathArgument`), and return the shell's exit status and its own stdout and
 * stderr.
 */
function runProbe(
  logFile: string,
  script: string,
  pathArgument: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "sh",
    ["-c", script, process.execPath, PROBE, logFile, LINE, pathArgument],
    {
      cwd: CLI_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: CHILD_KILL_MS,
      killSignal: "SIGKILL",
    },
  );
  if (result.error !== undefined) throw result.error;
  return result;
}

/**
 * The probe's stderr on a shell pipe, as a scheduler capturing it gives it.
 * Node's own `"pipe"` stdio is a socket, which `/dev/stderr` cannot reopen.
 * A pipeline exits with `cat`'s status, so the probe's own is kept in a file.
 */
function printedThroughPipe(logFile: string): string {
  const statusPath = path.join(dir, "probe-status");
  const result = runProbe(
    logFile,
    `{ ${PROBE_COMMAND} 2>&1 >/dev/null; echo "$?" >"$4"; } | cat`,
    statusPath,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(statusPath, "utf8").trim(), result.stdout).toBe("0");
  return result.stdout;
}

/** The probe's stderr appended to `stderrPath`, read back. */
function writtenToFile(logFile: string, stderrPath: string): string {
  const result = runProbe(
    logFile,
    `${PROBE_COMMAND} >/dev/null 2>>"$4"`,
    stderrPath,
  );
  const written = fs.readFileSync(stderrPath, "utf8");
  expect(result.status, written).toBe(0);
  return written;
}

function occurrences(text: string): number {
  return text.split(LINE).length - 1;
}

// `/dev/stderr` and descriptor identity are POSIX; Windows has neither.
describe.skipIf(process.platform === "win32")(
  "a consent line on the prompt stream under --log-file",
  () => {
    test(
      "is printed once when the log file is /dev/stderr on a pipe",
      { timeout: TEST_TIMEOUT_MS },
      () => {
        expect(occurrences(printedThroughPipe("/dev/stderr"))).toBe(1);
      },
    );

    test(
      "is written once when the log file is /dev/stderr redirected to a file",
      { timeout: TEST_TIMEOUT_MS },
      () => {
        const stderrPath = path.join(dir, "stderr.txt");
        expect(occurrences(writtenToFile("/dev/stderr", stderrPath))).toBe(1);
      },
    );

    test(
      "is written once when the log file is the file stderr is redirected to",
      { timeout: TEST_TIMEOUT_MS },
      () => {
        const stderrPath = path.join(dir, "run.log");
        expect(occurrences(writtenToFile(stderrPath, stderrPath))).toBe(1);
      },
    );

    test(
      "is printed once on stderr and copied once to a separate log file",
      { timeout: TEST_TIMEOUT_MS },
      () => {
        const logFile = path.join(dir, "run.log");
        expect(printedThroughPipe(logFile)).toBe(`${LINE}\n`);
        const kept = fs.readFileSync(logFile, "utf8");
        expect(occurrences(kept)).toBe(1);
        expect(kept).toContain(`[INFO] [consent-probe] ${LINE}\n`);
      },
    );
  },
);
