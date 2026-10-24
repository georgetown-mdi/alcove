import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  NOT_WRITTEN_EXIT,
  USAGE,
  isWritten,
  parseArgs,
} from "./wait-handoff-result.mjs";

const SCRIPT = fileURLToPath(
  new URL("./wait-handoff-result.mjs", import.meta.url),
);
const SLEEP_POLL_HOOK = fileURLToPath(
  new URL("../hooks/block-sleep-poll.mjs", import.meta.url),
);

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function handoffsDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "wait-handoff-result-"));
  directories.push(directory);
  return directory;
}

// Starts the watcher and resolves with its exit status and output. A watcher
// still running after stopAfterMs gets SIGTERM, as `timeout` sends it.
function runWatcher(args, { stopAfterMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT, ...args], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const started = Date.now();
    const stopper = setTimeout(() => child.kill("SIGTERM"), stopAfterMs);
    child.on("close", (status) => {
      clearTimeout(stopper);
      resolve({ status, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

describe("wait-handoff-result.mjs", () => {
  it("exits 0 at once when the result file is already written", async () => {
    const result = join(handoffsDirectory(), "2026-10-24-x.result.md");
    writeFileSync(result, "## Run\n");
    const { status, stdout, elapsedMs } = await runWatcher([
      result,
      "--interval",
      "0.1",
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain(`${result} is written (7 bytes)`);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("keeps waiting while the file is absent, and exits 124 when stopped", async () => {
    const result = join(handoffsDirectory(), "2026-10-24-x.result.md");
    const { status, stdout } = await runWatcher([result, "--interval", "0.1"], {
      stopAfterMs: 1_500,
    });
    expect(status).toBe(NOT_WRITTEN_EXIT);
    expect(stdout).toContain(`${result} is not written yet`);
    expect(stdout).not.toContain("is written (");
  });

  it("exits 0 once a result written after it started stops changing", async () => {
    const result = join(handoffsDirectory(), "2026-10-24-x.result.md");
    const running = runWatcher([result, "--interval", "0.1"]);
    setTimeout(() => writeFileSync(result, ""), 300);
    setTimeout(() => writeFileSync(result, "## Run\nhost\n"), 600);
    const { status, stdout, elapsedMs } = await running;
    expect(status).toBe(0);
    expect(stdout).toContain(`${result} is written (12 bytes)`);
    expect(elapsedMs).toBeGreaterThanOrEqual(600);
  });

  it("refuses a directory that does not exist on this machine", () => {
    const missing = join(
      handoffsDirectory(),
      "no-such-dir",
      "2026-10-24-x.result.md",
    );
    const { status, stderr } = spawnSync("node", [SCRIPT, missing], {
      encoding: "utf8",
    });
    expect(status).toBe(2);
    expect(stderr).toContain("does not exist");
    expect(stderr).toContain("/workspace/scratch/handoffs/");
  });

  it("is admitted by block-sleep-poll in the background form its usage gives", () => {
    const line = USAGE.split("\n").find((text) =>
      text.trim().startsWith("timeout "),
    );
    expect(line).toBeDefined();
    const { status, stderr } = spawnSync("node", [SLEEP_POLL_HOOK], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: line.trim(), run_in_background: true },
      }),
      encoding: "utf8",
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });
});

describe("parseArgs", () => {
  it("reads the result file and the interval", () => {
    expect(parseArgs(["a/b.result.md", "--interval", "2"])).toEqual({
      path: "a/b.result.md",
      intervalSeconds: 2,
    });
  });

  it("refuses a path that is not a result file", () => {
    expect(parseArgs(["scratch/handoffs/2026-10-24-x.md"]).error).toContain(
      "ends in .result.md",
    );
  });

  it("refuses a missing, zero or unbounded interval", () => {
    for (const value of [undefined, "0", "-1", "abc", "601"]) {
      const argv = ["a.result.md", "--interval"];
      if (value !== undefined) argv.push(value);
      expect(parseArgs(argv).error, String(value)).toContain("--interval");
    }
  });

  it("refuses no path, two paths, and an unknown option", () => {
    expect(parseArgs([]).error).toContain("name the result file");
    expect(parseArgs(["a.result.md", "b.result.md"]).error).toContain(
      "one result file only",
    );
    expect(parseArgs(["--wait", "a.result.md"]).error).toContain(
      "unknown option",
    );
  });
});

describe("isWritten", () => {
  const state = (size, mtimeMs = 1) => ({ size, mtimeMs });

  it("needs the same non-empty file on two checks", () => {
    expect(isWritten(state(5), state(5))).toBe(true);
    expect(isWritten(null, state(5))).toBe(false);
    expect(isWritten(state(0), state(0))).toBe(false);
    expect(isWritten(state(3), state(5))).toBe(false);
    expect(isWritten(state(5, 1), state(5, 2))).toBe(false);
    expect(isWritten(state(5), null)).toBe(false);
  });
});
