#!/usr/bin/env node
// SessionStart hook on the `compact` source: after a compaction of an
// orchestrating session's context, add a line to the compacted context naming
// .claude/orchestration/ruleset.md and the newest continuation brief by path,
// and remove the session's record of having read the ruleset, so
// require-orchestration-ruleset-read.mjs refuses its next Agent or Workflow
// call until the ruleset is read again. A compaction keeps the session id, so
// without the removal the earlier read would stand for a context that no
// longer holds the ruleset.
//
// WHICH SESSIONS. A session counts as orchestrating when the ruleset-read
// record for its id exists, at any age: only an orchestrating session reads
// the ruleset. Any other session, and a payload naming no session, gets no
// line. The record is removed in either case, which for a session holding
// none removes nothing.
//
// A SPAWNED AGENT'S COMPACTION fires this hook too, with a payload the session's
// own cannot be told from: the same session id, the session's transcript path,
// no agent field. So the line goes into that agent's context as well, which is
// why it tells a spawned agent to ignore it, and the session's record is
// removed, which costs the session one read of the ruleset before its next
// spawn.
//
// PATHS, NEVER CONTENT. The line names both files by absolute path and quotes
// neither: the session reads them, and text added here is billed on every call
// for the rest of the context. The brief is the newest `continuation-*.md` by
// modification time in the primary checkout's `scratch/`, the rule
// .claude/commands/orchestrate.md, First, states; a newest brief whose first
// line begins `Closed out` is history, so the line then names no brief.
//
// The output is `hookSpecificOutput.additionalContext`, which the harness adds
// to the compacted context. A SessionStart hook cannot block; this one fails
// open, emitting nothing on an unreadable event or an unexpected error.
// What was driven, and how: docs/notes/agent-hooks-and-scripts.md, Compaction
// hooks.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eventCwd, readEvent, NOT_AN_EVENT } from "./lib/event.mjs";
import {
  clearRead,
  markerPath,
  recordedReadAgeMs,
} from "./lib/rulesetRead.mjs";
import { worktreeRecords } from "./lib/worktrees.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2027-05-31";

const RULESET_FILE = fileURLToPath(
  new URL("../orchestration/ruleset.md", import.meta.url),
);
const OWN_CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));

const BRIEF_NAME = /^continuation-.*\.md$/;
const CLOSED_PREFIX = "Closed out";

// The main worktree, which git lists first from any of a repository's
// worktrees; the directory itself when git gives no answer.
function primaryCheckout(directory) {
  return worktreeRecords(directory)?.[0]?.path ?? directory;
}

function startsClosed(path) {
  const buffer = Buffer.alloc(CLOSED_PREFIX.length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8") === CLOSED_PREFIX;
}

// The newest continuation brief in `scratchDir` by modification time, or null
// when the directory holds none or the newest is closed.
function newestOpenBrief(scratchDir) {
  let entries;
  try {
    entries = readdirSync(scratchDir);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of entries) {
    if (!BRIEF_NAME.test(name)) continue;
    const path = join(scratchDir, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (newest === null || stats.mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs: stats.mtimeMs };
    }
  }
  if (newest === null) return null;
  try {
    return startsClosed(newest.path) ? null : newest.path;
  } catch {
    return null;
  }
}

function reminder(briefPath, scratchDir) {
  const rules =
    "This context was just compacted. For the orchestrating session: read " +
    `${RULESET_FILE} again before the next Agent or Workflow call, which is ` +
    "refused until you do.";
  const brief =
    briefPath === null
      ? ` No open continuation brief is in ${scratchDir}: start one as ` +
        ".claude/commands/orchestrate.md, First, sets out, in the Working state."
      : ` Then read the continuation brief ${briefPath} and carry on in the ` +
        "state it records, Working when it records none.";
  const spawned =
    " A spawned agent ignores this line and carries on with its own task.";
  return rules + brief + spawned;
}

function main() {
  const event = readEvent();
  if (event === null || event === NOT_AN_EVENT) process.exit(0);
  if (event.source !== "compact") process.exit(0);

  const marker = markerPath(event.session_id);
  if (marker === null) process.exit(0);
  const orchestrating = recordedReadAgeMs(marker) !== null;
  clearRead(marker);
  if (!orchestrating) process.exit(0);

  const scratchDir = join(
    primaryCheckout(eventCwd(event) ?? OWN_CHECKOUT),
    "scratch",
  );
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: reminder(newestOpenBrief(scratchDir), scratchDir),
      },
    }),
  );
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0);
}
