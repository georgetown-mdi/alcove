#!/usr/bin/env node
// PreToolUse hook: route any Agent spawn on the Fable tier to a user-approval
// prompt. Fable is the most expensive tier, reserved for deliberate hard cases (a
// complicated plan, a high-stakes security/protocol review); the owner approves
// each such spawn rather than letting the agent choose it autonomously. This hook
// returns permissionDecision "ask" for a Fable spawn so the harness prompts the
// owner; every other tier passes through untouched.
//
// Detection covers both Fable spellings the Agent tool admits: an explicit
// `model: "fable"`, and a bare spawn whose subagent_type's .claude/agents/*.md
// pins `model: fable`. The full id "claude-fable-5" is not a concern here -- the
// sibling require-agent-model hook blocks any model outside the {opus, sonnet,
// haiku, fable} alias set, so "fable" is the only spelling that reaches a spawn.
//
// This gates the Agent tool. Fable requested inside a Workflow script's own
// agent() call is buried in the script rather than a top-level tool input, so it
// is out of reach here; require-workflow-fable-approval.mjs covers that vector.
//
// Fail-open on any error EXCEPT the directly-detected explicit Fable model, which
// needs no filesystem and always asks. The pinned-Fable path reads the agents dir
// and fails open on an I/O error, because require-agent-model already fails CLOSED
// on an unverifiable bare spawn, so an unresolvable pin is blocked upstream before
// it could reach a live spawn.

import { join } from "node:path";

import { agentDefinitions } from "./lib/agentDefinitions.mjs";
import { eventForTools } from "./lib/event.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

const ASK_REASON =
  "This spawn runs on the Fable tier, which requires your explicit approval " +
  "(per `.claude/orchestration/ruleset.md`, Models and spawns): " +
  "Fable is reserved for deliberate hard cases and is never chosen " +
  "autonomously. Approve to run it on Fable, or deny and it will be re-issued " +
  "on a cheaper tier.";

function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// Return the pinned `model:` value of the .claude/agents/<name>.md whose leading
// frontmatter names `subagentType`, or null.
function pinnedModelFor(agentsDir, subagentType) {
  const definition = agentDefinitions(agentsDir).find(
    ({ name }) => name === subagentType,
  );
  return definition?.model ?? null;
}

function main() {
  const event = eventForTools("Agent");
  if (event === null) process.exit(0); // unreadable, or another tool

  // Explicit-model path: no filesystem, always decisive.
  const model = event?.tool_input?.model;
  if (model === "fable") ask(ASK_REASON);
  if (typeof model === "string" && model.length > 0) process.exit(0);

  // Bare spawn: catch a subagent_type that pins Fable. Fail open on a read error
  // -- require-agent-model fails closed on an unverifiable bare spawn, so an
  // unresolvable pin never reaches a live spawn.
  const subagentType = event?.tool_input?.subagent_type;
  if (typeof subagentType !== "string" || subagentType.length === 0) {
    process.exit(0);
  }
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || event.cwd;
    const agentsDir = join(projectDir, ".claude", "agents");
    if (pinnedModelFor(agentsDir, subagentType) === "fable") ask(ASK_REASON);
  } catch {
    process.exit(0); // fail open; require-agent-model catches unverifiable pins
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge a spawn on an unexpected error
}
