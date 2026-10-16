import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("./block-subagent-short-background.mjs", import.meta.url),
);
const AGENT_ID = "a0123456789abcdef";

// Run the hook as a real subprocess with a synthesized PreToolUse payload on
// stdin, the way Claude Code invokes it. Exit 0 allows the Bash call, exit 2
// blocks it and feeds stderr back to Claude.
function runHook(payload) {
  const { status, stderr } = spawnSync("node", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, stderr };
}

function subagentBackground(command) {
  return runHook({
    tool_name: "Bash",
    agent_id: AGENT_ID,
    tool_input: { command, run_in_background: true },
  });
}

function expectBlocked(commands) {
  for (const command of commands) {
    const { status, stderr } = subagentBackground(command);
    expect(status, command).toBe(2);
    expect(stderr, command).toContain("block-subagent-short-background");
    expect(stderr, command).toContain("foreground");
    expect(stderr, command).toContain("600000 ms");
  }
}

function expectAllowed(commands) {
  for (const command of commands) {
    expect(subagentBackground(command).status, command).toBe(0);
  }
}

describe("block-subagent-short-background hook", () => {
  it("blocks a subagent's background command wrapped at or under 600 s", () => {
    expectBlocked([
      "timeout 600 npm run lint > /tmp/lint.log 2>&1; echo exit=$?",
      "timeout 300 npm test",
      "timeout 10m npm test",
      "timeout 599.9s npm test",
      "cd apps/cli && timeout 480 npm run test:integration -w apps/cli",
      "timeout 400 npm run build && timeout 400 npm test",
      "timeout -s KILL 120 npm test",
      "timeout 0 npm test",
    ]);
  });

  it("blocks a subagent's background command with no wrapper", () => {
    expectBlocked(["npm run test:integration -w apps/cli", "sleep 900"]);
  });

  it("blocks a wrapper over 600 s that wraps nothing", () => {
    expectBlocked(["timeout 900"]);
  });

  it("does not read a timeout outside command position as a wrapper", () => {
    expectBlocked([
      "echo timeout 900 npm test",
      "timeout 300 sh -c 'timeout 900 npm test'",
      'timeout 300 sh -c "npm run build; timeout 900 npm test"',
      "grep -r 'timeout 3600' scripts",
    ]);
  });

  it("allows a subagent's background command wrapped over 600 s", () => {
    expectAllowed([
      "timeout 601 npm test",
      "timeout 1800 sh -c 'npm run build && npm test' > /tmp/run.log 2>&1; echo exit=$?",
      "timeout 11m npm test",
      "timeout 1h npm run test:browser -w apps/web",
      "gtimeout 900 npm test",
      "timeout -k 30 --signal=TERM 900 npm test",
      "cd apps/web && timeout 1200 npm run test:browser -w apps/web",
      "CI=1 env -C apps/web timeout 900 npm test | tail -5",
      "timeout 300 npm run build && timeout 900 npm test",
    ]);
  });

  it("allows an orchestrator's background call, which has no agent_id", () => {
    for (const agentId of [undefined, ""]) {
      const payload = {
        tool_name: "Bash",
        tool_input: {
          command: "timeout 300 npm test",
          run_in_background: true,
        },
      };
      if (agentId !== undefined) payload.agent_id = agentId;
      expect(runHook(payload).status, String(agentId)).toBe(0);
    }
  });

  it("allows a subagent's foreground call however it is wrapped", () => {
    for (const run_in_background of [undefined, false]) {
      const { status } = runHook({
        tool_name: "Bash",
        agent_id: AGENT_ID,
        tool_input: { command: "timeout 300 npm test", run_in_background },
      });
      expect(status).toBe(0);
    }
  });

  it("ignores tools other than Bash and an unreadable event", () => {
    expect(
      runHook({
        tool_name: "Agent",
        agent_id: AGENT_ID,
        tool_input: { prompt: "x", run_in_background: true },
      }).status,
    ).toBe(0);
    expect(runHook("not json").status).toBe(0);
    expect(runHook("[]").status).toBe(0);
  });
});
