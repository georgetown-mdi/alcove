// Run a board script as a child process against the GraphQL stand-in in
// lib/graphqlFetchStub.mjs, so a suite can assert a script's exit code and
// output without a network or a token. The stub is preloaded only into the
// child; importing this module changes nothing in the test process.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Number of items the stubbed board holds. */
export const STUB_ITEM_COUNT = 30;
/** Epic every stubbed item is filed under. */
export const STUB_EPIC = "Stub epic";
/** Numeric id of the first stubbed item; the rest follow it in order. */
export const STUB_FIRST_ID = 100000000;

const STUB_PRELOAD = new URL("./graphqlFetchStub.mjs", import.meta.url).href;
const SCRIPTS_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Run `script` (a file name under .claude/scripts) with `args` and resolve to
 * { code, signal, stdout, stderr }. `listing: "short"` makes the stub serve a
 * listing one item short of the count it reports. `closeStdout` closes the
 * read end of the child's stdout before it writes, as `| head -0` would, so
 * its first write fails with EPIPE.
 */
export function runBoardScript(
  script,
  args,
  { listing = "full", closeStdout = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", STUB_PRELOAD, join(SCRIPTS_DIR, script), ...args],
      {
        env: {
          ...process.env,
          GH_TOKEN: "stub-token",
          ALCOVE_STUB_LISTING: listing,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    if (closeStdout) {
      child.stdout.destroy();
    } else {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}
