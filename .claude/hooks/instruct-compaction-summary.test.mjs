import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./instruct-compaction-summary.mjs", import.meta.url),
);

// The harness cuts one PreCompact hook's instructions at this many characters.
const INSTRUCTION_LIMIT = 10_000;

function runHook(payload) {
  const { status, stdout, stderr } = spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stdout, stderr };
}

const preCompact = (extra = {}) => ({
  session_id: "8f2b1c66-0000-4000-8000-0123456789ab",
  transcript_path:
    "/home/node/.claude/projects/-workspace/8f2b1c66-0000-4000-8000-0123456789ab.jsonl",
  cwd: "/workspace",
  hook_event_name: "PreCompact",
  ...extra,
});

const AUTO = preCompact({ trigger: "auto", custom_instructions: null });

// The harness reads stdout as a decision only when it parses as JSON, so
// plain text that does not parse carries no block.
function isBlocking(result) {
  if (result.status === 2) return true;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.decision === "block" || parsed?.continue === false;
  } catch {
    return false;
  }
}

describe("instruct-compaction-summary hook", () => {
  it("prints the instructions for an automatic compaction", () => {
    const result = runHook(AUTO);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Keep, in the summary, what no file holds");
    expect(result.stdout).toContain("the continuation brief's contents");
    expect(result.stdout).toContain("by task id");
  });

  it("prints the same instructions for a manual compaction", () => {
    const manual = runHook(
      preCompact({ trigger: "manual", custom_instructions: "keep the docket" }),
    );
    expect(manual.status).toBe(0);
    expect(manual.stdout).toBe(runHook(AUTO).stdout);
  });

  it("stays under the harness's cut on one hook's instructions", () => {
    const { stdout } = runHook(AUTO);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout.length).toBeLessThan(INSTRUCTION_LIMIT);
  });

  it("never blocks, whatever arrives on stdin", () => {
    const expected = runHook(AUTO).stdout;
    const payloads = [
      "",
      "not json",
      "null",
      "[]",
      "7",
      '"auto"',
      "{",
      {},
      preCompact({
        trigger: "manual",
        custom_instructions: "x".repeat(50_000),
      }),
      preCompact({ trigger: "something new" }),
      preCompact({ trigger: null, session_id: null, transcript_path: 7 }),
      { decision: "block", trigger: "auto" },
    ];
    for (const payload of payloads) {
      const result = runHook(payload);
      const label =
        typeof payload === "string"
          ? payload
          : JSON.stringify(payload).slice(0, 60);
      expect(result.status, label).toBe(0);
      expect(isBlocking(result), label).toBe(false);
      expect(result.stdout, label).toBe(expected);
      expect(result.stderr, label).toBe("");
    }
  });
});
