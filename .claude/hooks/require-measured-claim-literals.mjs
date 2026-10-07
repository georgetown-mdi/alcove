#!/usr/bin/env node
// PreToolUse hook on Workflow: refuse a role round whose claims quote text that
// does not occur in the tree at the ref the round reviews.
//
// The quoting rule: a double-quoted span in a claim asserts that this exact text
// occurs in the tree at the target ref, and each one is looked up with
// `git grep -F` at that ref. Anything else a claim quotes, a string the round
// feeds the surface, a paraphrase or a term of art, goes in single quotes or
// backticks, which this hook does not read; the refusal names the single-quote
// form. A message the source assembles from fragments has no contiguous
// occurrence, so a claim quotes a fragment that does occur or states the
// property. The claims read are the ones in the Workflow's `args`.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.
// Fail open: every state in which a literal cannot be confirmed absent,
// including a target that is not a single resolvable ref, allows the call.
// Rationale and limits: docs/notes/agent-hooks-and-scripts.md.

import { execFileSync } from "node:child_process";

import { eventCwd, eventForTools, workflowArgs } from "./lib/event.mjs";
import { git } from "./lib/shell.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

const QUOTED_SPAN = /"([^"]*)"/g;
const ABSENCES_SHOWN = 8;

/**
 * The double-quoted spans of one claim, in order and without repeats. A span
 * holding no letter or digit asserts nothing measurable, so it is skipped.
 */
function quotedLiterals(claim) {
  const literals = [];
  for (const [, literal] of claim.matchAll(QUOTED_SPAN)) {
    if (!/[A-Za-z0-9]/.test(literal)) continue;
    if (!literals.includes(literal)) literals.push(literal);
  }
  return literals;
}

/**
 * Whether `literal` occurs nowhere in the tree at `ref`. Only git's own "no
 * match" exit answers that: a git that failed for any other reason -- an
 * unreadable object store, no git on PATH -- leaves the question open, and an
 * open question is not an absence. `git()` from lib/shell.mjs collapses the two,
 * so this runs git itself to keep them apart.
 */
function absentAt(root, ref, literal) {
  try {
    execFileSync(
      "git",
      ["-C", root, "grep", "--fixed-strings", "--quiet", "-e", literal, ref],
      { stdio: "ignore" },
    );
    return false;
  } catch (error) {
    return error?.status === 1;
  }
}

function main() {
  const event = eventForTools("Workflow");
  if (event === null) process.exit(0); // unreadable, or another tool

  const args = workflowArgs(event.tool_input);
  if (args === null) process.exit(0);

  const claims = Array.isArray(args.claims)
    ? args.claims.filter((claim) => typeof claim === "string")
    : [];
  if (claims.length === 0) process.exit(0);

  const ref = typeof args.targetRef === "string" ? args.targetRef.trim() : "";
  if (ref.length === 0) process.exit(0);

  const cwd = eventCwd(event);
  if (cwd === null) process.exit(0);
  const root = git(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!root) process.exit(0);
  const resolved = git([
    "-C",
    root,
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (resolved === null) process.exit(0);

  const absences = [];
  for (const claim of claims) {
    for (const literal of quotedLiterals(claim)) {
      if (absentAt(root, ref, literal)) absences.push({ claim, literal });
    }
  }
  if (absences.length === 0) process.exit(0);

  const shown = absences.slice(0, ABSENCES_SHOWN);
  const more = absences.length - shown.length;
  const list =
    shown
      .map(({ claim, literal }) => `  "${literal}"\n    claimed by: ${claim}`)
      .join("\n") + (more > 0 ? `\n  ...and ${more} more` : "");
  process.stderr.write(
    "Blocked by require-measured-claim-literals hook: this round's claims quote " +
      `text that occurs nowhere in the tree at '${ref}', so the reviewer would ` +
      "measure the wording instead of the property and spend the round on it. " +
      `Absent:\n${list}\n` +
      "Quote only text you measured at that ref, and quote a contiguous " +
      "fragment of a message the source assembles from pieces. A string the " +
      "round feeds the surface, a paraphrase, or a term of art goes in single " +
      "quotes, which this gate does not read. A claim needing neither states " +
      "the property instead: refuses, does not throw, renders without " +
      "crashing.\n",
  );
  process.exit(2);
}

try {
  main();
} catch {
  // Fail open: this gate saves a role round, and wedging Workflow calls costs
  // more than the round it was saving.
  process.exit(0);
}
