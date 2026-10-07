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
// Round lock: a target that passes gets a branch-keyed lock file under the
// primary checkout's `scratch/review-rounds/`, keyed by the transform
// light-review's Step 1 uses to name the round's artifacts, and deleted by
// light-review's Step 3 when the round is booked. A lock younger than
// ROUND_LOCK_TTL_MS refuses the target; an older one is stale and ignored. The
// lock bounds concurrent rounds, not commits into the target tree.
//
// Fails closed: every state where a target cannot be confirmed clean blocks (a
// non-git or missing cwd, a git error, unreadable `args`, an unresolvable ref, a
// dirty status, an unwritable lock, a non-object payload). Only an unparseable
// event or one naming another tool passes. Exit 0 allows the call; exit 2
// blocks it and feeds stderr back to Claude. Rationale:
// docs/notes/agent-hooks-and-scripts.md.

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  eventCwd,
  NOT_AN_EVENT,
  readEvent,
  workflowArgs,
} from "./lib/event.mjs";
import { git } from "./lib/shell.mjs";
import { worktreeRecords } from "./lib/worktrees.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

const DIRTY_ENTRIES_SHOWN = 10;
const ROUNDS_DIR = join("scratch", "review-rounds");
const LOCK_SUFFIX = ".lock";
const ROUND_LOCK_TTL_MS = 90 * 60 * 1000;
const LIGHT_REVIEW_MARKER = "light-review";
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

// The refs this call reviews: none, one, or several. Null when `targetRef` is
// present but not readable as refs, which blocks rather than reviewing nothing.
function targetRefs(args) {
  const target = args.targetRef;
  if (target === undefined || target === null) return [];
  const refs = Array.isArray(target) ? target : [target];
  if (refs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) {
    return null;
  }
  return refs.map((ref) => ref.trim());
}

// Whether this Workflow call is a review round, which is what makes a named
// target mandatory and puts the call under the in-flight lock.
function namesLightReview(toolInput) {
  return [toolInput?.scriptPath, toolInput?.workflow, toolInput?.name].some(
    (field) => typeof field === "string" && field.includes(LIGHT_REVIEW_MARKER),
  );
}

function branchName(ref) {
  return ref.replace(/^refs\/heads\//, "");
}

function treesHolding(records, ref, sha) {
  const name = branchName(ref);
  return records.filter(
    (record) =>
      (record.branch !== null && branchName(record.branch) === name) ||
      record.head === sha,
  );
}

// A filename-safe key for a ref. Branch names contain no `/` by repo convention;
// this sanitizes anyway, and strips leading dots so no key can name a directory
// component of its own.
function refKey(ref) {
  const key = branchName(ref)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "");
  return key.length === 0 ? "ref" : key;
}

function lockPath(mainRoot, ref) {
  return join(mainRoot, ROUNDS_DIR, `${refKey(ref)}${LOCK_SUFFIX}`);
}

// How long ago the round holding this lock started, or null when no lock is
// there. The recorded timestamp is authoritative; a lock whose contents cannot
// be read as one falls back to its mtime, so a corrupt lock still expires
// rather than wedging its branch forever.
function lockAgeMs(path) {
  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  let startedAt = NaN;
  try {
    startedAt = Date.parse(JSON.parse(readFileSync(path, "utf8"))?.startedAt);
  } catch {
    startedAt = NaN;
  }
  return Date.now() - (Number.isFinite(startedAt) ? startedAt : mtimeMs);
}

function writeLock(path, ref) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ ref, startedAt: new Date().toISOString() })}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

function removeLock(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // A lock that cannot be removed expires on its TTL, which is the same
    // outcome the roll-back is avoiding, only slower.
  }
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
  const locks = [];

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
    locks.push({ path, ref });
  }

  // Locks are written only once every target has passed, and a write that fails
  // part-way through rolls back the ones already written, so a refused call
  // leaves none of them behind to expire.
  const written = [];
  for (const { path, ref } of locks) {
    if (writeLock(path, ref)) {
      written.push(path);
      continue;
    }
    for (const done of written) removeLock(done);
    block(
      `could not write the in-flight round lock '${path}', so a second concurrent ` +
        `round against '${ref}' could not be refused; fix the path and retry`,
    );
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
