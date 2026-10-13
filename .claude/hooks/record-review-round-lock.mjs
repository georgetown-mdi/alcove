#!/usr/bin/env node
// PostToolUse hook on Workflow: write the in-flight round lock
// (lib/reviewLock.mjs) for each ref a review round names, once the harness has
// run the call. require-clean-tree-for-review.mjs refuses the next round
// against a ref while its lock is young, and light-review's Step 3 deletes it
// when the round is booked.
//
// Written here rather than in the PreToolUse gate because PostToolUse fires
// only for a call the harness ran: a call any PreToolUse hook or a permission
// prompt refused writes no lock, so its retry is not refused as a round in
// flight.
//
// Probe: record-review-round-lock.probe.md beside this file, last run
// 2026-10-12 on Claude Code 2.1.296: PostToolUse fired at the launch of an
// async Workflow, with the call's own tool_input.
//
// Limits. Two Workflow calls against the same ref in one message both pass the
// PreToolUse check before either lock is written, so both rounds run. Whether
// PostToolUse fires for a Workflow that fails to launch was not probed; if it
// does, the lock refuses the retry until it is deleted by the path the refusal
// names, or ages out.
//
// PostToolUse cannot block, since the call has already run. When a lock cannot
// be written this hook exits 2, which feeds stderr back to Claude as a warning
// that nothing will refuse a second round; every other outcome exits 0.
// Rationale: docs/notes/agent-hooks-and-scripts.md.

import { eventCwd, eventForTools, workflowArgs } from "./lib/event.mjs";
import {
  lockPath,
  namesLightReview,
  targetRefs,
  writeLock,
} from "./lib/reviewLock.mjs";
import { worktreeRecords } from "./lib/worktrees.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2027-06-30";

function warn(reason) {
  process.stderr.write(
    `record-review-round-lock hook: ${reason}; start no other review round ` +
      "against the same ref until this round is booked.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Workflow");
  if (event === null) process.exit(0); // unreadable, or another tool
  const toolInput = event.tool_input;
  if (!namesLightReview(toolInput)) process.exit(0);
  const args = workflowArgs(toolInput);
  const refs = args === null ? null : targetRefs(args);
  // The gate refused a round naming no readable ref before it could run.
  if (refs === null || refs.length === 0) process.exit(0);

  const named = refs.map((ref) => `'${ref}'`).join(", ");
  const cwd = eventCwd(event);
  const records = cwd === null ? null : worktreeRecords(cwd);
  if (records === null) {
    warn(
      `could not locate the primary checkout to write the in-flight round lock ` +
        `for the round against ${named}, so a second round will not be refused`,
    );
  }
  const unwritten = refs
    .map((ref) => lockPath(records[0].path, ref))
    .filter((path, i) => !writeLock(path, refs[i]));
  if (unwritten.length > 0) {
    warn(
      `could not write the in-flight round lock ${unwritten.map((p) => `'${p}'`).join(", ")} ` +
        `for the round against ${named}, so a second round will not be refused`,
    );
  }
  process.exit(0);
}

try {
  main();
} catch {
  warn(
    "an unexpected error stopped the in-flight round lock being written, so a " +
      "second round against this round's refs will not be refused",
  );
}
