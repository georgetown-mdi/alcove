#!/usr/bin/env node
// PreToolUse hook on Workflow: refuse a call whose review target has
// uncommitted work, and a second concurrent round against a target one is
// already running against. Reviewers diff by ref and see only commits, so a
// round over a dirty tree would return a false clean.
//
// Trees inspected: the caller's cwd tree, the whole check for a call naming no
// `args.targetRef`, and every worktree holding a named target, matched by branch
// name or by HEAD sha. A target ref no worktree holds passes; one that does not
// resolve blocks. A call naming the light-review script in scriptPath,
// workflow or `name` must name its targets; any other form gets the cwd check.
// `scratch/` is gitignored, so a round's own artifacts never dirty a tree.
//
// Round lock: a review round against a ref whose lock (lib/reviewLock.mjs)
// is younger than ROUND_LOCK_TTL_MS is refused; an older one is stale and
// ignored. This hook only reads the lock. record-review-round-lock.mjs writes
// it after the harness has run the call, so a call any hook or permission
// prompt refused leaves none behind, and light-review's Step 3 deletes it when
// the round is booked. The lock bounds concurrent rounds, not commits into the
// target tree.
//
// Fails closed: every state where a target cannot be confirmed clean blocks (a
// non-git or missing cwd, a git error, unreadable `args`, an unresolvable ref, a
// dirty status, a non-object payload). Only an unparseable event or one naming
// another tool passes. Exit 0 allows the call; exit 2 blocks it and feeds
// stderr back to Claude. Rationale: docs/notes/agent-hooks-and-scripts.md.

import {
  eventCwd,
  NOT_AN_EVENT,
  readEvent,
  workflowArgs,
} from "./lib/event.mjs";
import {
  branchName,
  lockAgeMs,
  lockPath,
  namesLightReview,
  ROUND_LOCK_TTL_MS,
  targetRefs,
} from "./lib/reviewLock.mjs";
import { git } from "./lib/shell.mjs";
import { worktreeRecords } from "./lib/worktrees.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2027-06-30";

const DIRTY_ENTRIES_SHOWN = 10;
const UNCONFIRMED = "could not confirm a clean tree; commit and retry";

function block(reason) {
  // A multi-line reason (the dirty-entry list) is self-terminating; only a
  // single-line reason takes a trailing period, so the period never glues onto
  // the last listed entry.
  const suffix = reason.includes("\n") ? "\n" : ".\n";
  process.stderr.write(
    `Blocked by require-clean-tree-for-review hook: ${reason}${suffix}`,
  );
  process.exit(2);
}

function treesHolding(records, ref, sha) {
  const name = branchName(ref);
  return records.filter(
    (record) =>
      (record.branch !== null && branchName(record.branch) === name) ||
      record.head === sha,
  );
}

function describeMinutes(ms) {
  return `${Math.round(ms / 60000)} minutes`;
}

// Block unless `path` is a working tree with nothing uncommitted in it.
function requireClean(path, subject) {
  const status = git(["-C", path, "status", "--porcelain"]);
  if (status === null) {
    block(
      `could not read git status in '${path}' to confirm ${subject} is clean; commit and retry`,
    );
  }
  if (status.length === 0) return;
  const entries = status.split("\n");
  const shown = entries.slice(0, DIRTY_ENTRIES_SHOWN);
  const more = entries.length - shown.length;
  const list =
    shown.map((entry) => `  ${entry}`).join("\n") +
    (more > 0 ? `\n  ...and ${more} more` : "");
  block(
    `${subject} is not clean at '${path}'; reviewers diff origin/staging...<ref> and see only ` +
      "commits, so commit or stash there first. Uncommitted entries:\n" +
      list,
  );
}

function main() {
  const event = readEvent();
  if (event === NOT_AN_EVENT) block(UNCONFIRMED);
  if (event === null || event.tool_name !== "Workflow") process.exit(0);

  // From here every path fails CLOSED. An event naming no directory is a
  // fail-closed case, not a crash: without a directory to inspect the tree cannot
  // be confirmed clean.
  const cwd = eventCwd(event);
  if (cwd === null) {
    block(
      "could not locate a git repo to confirm a clean tree; commit and retry",
    );
  }

  const root = git(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!root) {
    block(
      "could not locate a git repo to confirm a clean tree; commit and retry",
    );
  }
  requireClean(root, "the calling session's own working tree");

  const toolInput = event.tool_input;
  const args = workflowArgs(toolInput);
  if (args === null) {
    block(
      "the Workflow's args could not be read as named arguments, so the ref this " +
        "round reviews could not be confirmed clean; pass args as an object and retry",
    );
  }
  const refs = targetRefs(args);
  if (refs === null) {
    block(
      "targetRef must be a ref name, or a list of them, so the tree holding each " +
        "can be confirmed clean; fix the Workflow args and retry",
    );
  }
  if (refs.length === 0) {
    if (namesLightReview(toolInput)) {
      block(
        "a review round must name the ref it reviews in args.targetRef -- without " +
          "one this gate could only status the caller's own directory, which says " +
          "nothing about the tree holding the branch under review",
      );
    }
    process.exit(0);
  }

  const records = worktreeRecords(root);
  if (records === null) {
    block(
      "could not list this repository's worktrees to locate the tree holding each " +
        "target ref; commit and retry",
    );
  }
  const mainRoot = records[0].path;
  const locked = namesLightReview(toolInput);

  for (const ref of refs) {
    const sha = git([
      "-C",
      root,
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (sha === null) {
      block(
        `'${ref}' does not resolve to a commit in this repository, so nothing about ` +
          "it can be confirmed clean; name the branch under review and retry",
      );
    }
    for (const tree of treesHolding(records, ref, sha)) {
      if (tree.path === root) continue; // already statused as the caller's tree
      requireClean(tree.path, `the tree holding '${ref}'`);
    }
    if (!locked) continue;
    const path = lockPath(mainRoot, ref);
    const ageMs = lockAgeMs(path);
    if (ageMs !== null && ageMs < ROUND_LOCK_TTL_MS) {
      block(
        `a review round against '${ref}' started ${describeMinutes(ageMs)} ago and ` +
          "has not booked its result yet; wait for it, or delete " +
          `'${path}' if you know that round is gone (this lock expires on its own ` +
          `after ${describeMinutes(ROUND_LOCK_TTL_MS)})`,
      );
    }
  }
  process.exit(0);
}

try {
  main();
} catch {
  // Structural fail-closed safety check: the two exit-0 cases (unparseable event,
  // non-Workflow tool) are decided before any throwing code, so any error that
  // reaches here is on a path that must block, not allow.
  block(UNCONFIRMED);
}
