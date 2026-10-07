#!/usr/bin/env node
// PreToolUse hook on Agent and Workflow: refuse a session's first Agent spawn
// or Workflow call until that session has read .claude/orchestration/ruleset.md.
// The refusal is the whole mechanism: the ruleset's text never enters a spawn's
// context. The read is keyed on the payload's session id. A call whose
// transcript path is a subagent's (<project>/<session-id>/subagents/
// agent-<agent-id>.jsonl), or that names no transcript path, passes. FAIL OPEN:
// an unreadable event, a payload naming no session, and any unexpected error
// allow the call; only a confirmed session call with no fresh read is refused.
//
// The marker path, the session key and the freshness window: lib/rulesetRead.mjs.
// The read is recorded by record-orchestration-ruleset-read.mjs.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.
// Rationale and limits: docs/notes/agent-hooks-and-scripts.md.

import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { eventForTools } from "./lib/event.mjs";
import {
  markerPath,
  READ_TTL_MS,
  recordedReadAgeMs,
  RULESET_PATH,
} from "./lib/rulesetRead.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

// The ruleset beside this hook, so the refusal names a file that exists in the
// checkout whose settings registered the hook rather than a path built from a
// directory the payload may not carry.
const RULESET_FILE = fileURLToPath(
  new URL("../orchestration/ruleset.md", import.meta.url),
);

const SUBAGENT_TRANSCRIPT_DIR = "/subagents/";
const SUBAGENT_TRANSCRIPT_PREFIX = "agent-";

function block(reason) {
  process.stderr.write(
    `Blocked by require-orchestration-ruleset-read hook: ${reason}.\n`,
  );
  process.exit(2);
}

// True only for a call the transcript path confirms is a session's own. A
// payload carrying no path confirms nothing, so it answers false and passes; an
// empty string names no transcript and counts as none, as it does in event.mjs.
function isConfirmedSessionCall(event) {
  const transcript = event?.transcript_path;
  if (typeof transcript !== "string" || transcript.length === 0) return false;
  const path = transcript.replace(/\\/g, "/");
  return !(
    path.includes(SUBAGENT_TRANSCRIPT_DIR) ||
    basename(path).startsWith(SUBAGENT_TRANSCRIPT_PREFIX)
  );
}

function describeHours(ms) {
  return `${Math.round(ms / 3600000)} hours`;
}

function readInstruction() {
  return `read it with \`cat '${RULESET_FILE}'\`, then repeat this call`;
}

function main() {
  const event = eventForTools("Agent", "Workflow");
  if (event === null) process.exit(0); // unreadable, or another tool
  if (!isConfirmedSessionCall(event)) process.exit(0);

  const path = markerPath(event.session_id);
  if (path === null) process.exit(0); // no session to key a read on

  const ageMs = recordedReadAgeMs(path);
  if (ageMs === null) {
    block(
      `this session has not read ${RULESET_PATH}, which holds the rules for ` +
        `conducting a session that spawns agents and runs review rounds -- ` +
        readInstruction(),
    );
  }
  if (ageMs >= READ_TTL_MS) {
    block(
      `this session read ${RULESET_PATH} ${describeHours(ageMs)} ago, past the ` +
        `${describeHours(READ_TTL_MS)} a recorded read stands for -- ` +
        readInstruction(),
    );
  }
  process.exit(0);
}

try {
  main();
} catch {
  // Fail open on any unexpected error; see the header. The refusals above exit
  // inside main and never reach here.
  process.exit(0);
}
