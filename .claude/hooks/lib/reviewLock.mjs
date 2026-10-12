// The in-flight review-round lock: which Workflow calls are review rounds, the
// refs one names, and the lock file kept for each ref while its round runs.
//
// Two hooks share it. require-clean-tree-for-review.mjs (PreToolUse) refuses a
// round against a ref whose lock is younger than ROUND_LOCK_TTL_MS, and
// record-review-round-lock.mjs (PostToolUse) writes the lock once the harness
// has run the call. light-review's Step 3 deletes it when the round is booked.
// The lock lives under the primary checkout's `scratch/review-rounds/`, keyed by
// the transform light-review's Step 1 uses to name the round's artifacts.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How long a lock refuses its ref before it is treated as stale. */
export const ROUND_LOCK_TTL_MS = 90 * 60 * 1000;

const ROUNDS_DIR = join("scratch", "review-rounds");
const LOCK_SUFFIX = ".lock";
const LIGHT_REVIEW_MARKER = "light-review";

/**
 * Whether this Workflow call is a review round, which is what makes a named
 * target mandatory and puts the call under the in-flight lock: the light-review
 * script named in scriptPath, workflow or `name`.
 */
export function namesLightReview(toolInput) {
  return [toolInput?.scriptPath, toolInput?.workflow, toolInput?.name].some(
    (field) => typeof field === "string" && field.includes(LIGHT_REVIEW_MARKER),
  );
}

/**
 * The refs a call's args review: none, one, or several. Null when `targetRef`
 * is present but not readable as refs, which the gate blocks rather than
 * reviewing nothing.
 */
export function targetRefs(args) {
  const target = args.targetRef;
  if (target === undefined || target === null) return [];
  const refs = Array.isArray(target) ? target : [target];
  if (refs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) {
    return null;
  }
  return refs.map((ref) => ref.trim());
}

/** A ref with any `refs/heads/` prefix removed. */
export function branchName(ref) {
  return ref.replace(/^refs\/heads\//, "");
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

/** The lock file for a round against `ref`, under the primary checkout. */
export function lockPath(mainRoot, ref) {
  return join(mainRoot, ROUNDS_DIR, `${refKey(ref)}${LOCK_SUFFIX}`);
}

/**
 * How long ago the round holding this lock started, or null when no lock is
 * there. The recorded timestamp is authoritative; a lock whose contents cannot
 * be read as one falls back to its mtime, so a corrupt lock still expires
 * rather than wedging its branch forever.
 */
export function lockAgeMs(path) {
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

/** Write the lock for a round against `ref` started now; false when it fails. */
export function writeLock(path, ref) {
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
