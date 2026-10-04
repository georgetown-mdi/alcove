import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { buildCli } from "../../../src/cliParser";
import { captureProcessExit } from "../../exitCapture";
import { captureStdio } from "../../loggingTestSupport";

// A filedrop directory that is not there is the likeliest filedrop
// misconfiguration. The run refuses it on the first attempt, with exit 66 (an
// input that is not there yet) and the shared folder sentence plus the CLI's
// remedy, and reports no connection retries: there were none.
//
// Driven through the real parser (buildCli, the zero-setup command as `$0`)
// rather than runProtocol, because the operator's reading of it comes off the
// command line: the argv, the connection options it resolves, and the stderr
// the run leaves behind.

// Recognizable linkage columns, so the terms infer a linkage key and the run
// reaches the connection rather than being refused before it.
const INPUT_CSV = "FirstName,LastName,DOB\nJames,Heard,7/16/1975\n";

// A retry budget the run must not spend on a missing folder.
const MAX_RECONNECT_ATTEMPTS = "3";

let work: string;
let exitSpy: ReturnType<typeof captureProcessExit> | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-missing-drop-"));
  exitSpy = captureProcessExit();
});

afterEach(() => {
  exitSpy?.mockRestore();
  exitSpy = undefined;
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

test("a run whose shared folder does not exist fails at once with exit 66", async () => {
  const input = path.join(work, "in.csv");
  fs.writeFileSync(input, INPUT_CSV);
  // Never created: the directory the URL names must not exist when the run
  // opens it.
  const missing = path.join(work, "not-a-directory");

  const stdio = captureStdio();
  // The trapped exit unwinds through yargs, which reports an escaping error by
  // printing the usage banner and the throw itself to console.error; capture
  // both console halves so that harness noise stays out of the suite's output
  // and off the summary this test reads from the log sink.
  const consoleSpies = (["error", "log"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  let exit = "";
  try {
    await buildCli([
      pathToFileURL(missing).href,
      input,
      path.join(work, "out.csv"),
      "--max-reconnect-attempts",
      MAX_RECONNECT_ATTEMPTS,
    ]).parseAsync();
  } catch (err) {
    exit = err instanceof Error ? err.message : String(err);
  } finally {
    for (const spy of consoleSpies) spy.mockRestore();
    stdio.restore();
  }

  const stderr = stdio.stderrWrites.join("");
  expect(exit).toBe("exit:66");
  expect(stderr).toContain(
    `The shared folder ${missing} does not exist (ENOENT).\n` +
      "Create or mount the folder, or correct its path, then run again.",
  );
  expect(stderr).not.toContain("connecting was retried");
  expect(stderr).not.toContain("re-established");
});
