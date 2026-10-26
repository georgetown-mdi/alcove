#!/usr/bin/env node
// CLAUDE.md byte budget, run by static_checks.yaml on every PR.
//
// Fails when CLAUDE.md is over BUDGET_BYTES. CLAUDE.md is loaded into every
// agent session, so its size is its cost: this bounds size, where
// check-contributing-scope.mjs checks CONTRIBUTING.md by section heading. The
// ceiling is the size the last strip pass reached.
//
// To add a rule past the budget, keep the one-line rule and a pointer in
// CLAUDE.md and move the mechanics to where they are enforced:
// `.claude/commands/` for the review and panel flows, the hook's own header for
// what a hook does, `docs/` for anything a human reader also needs. Do not
// delete a rule to make room. Rationale: docs/notes/claude-md-spawn-cost.md.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Ceiling in bytes. Raising it is a deliberate edit a reviewer sees. */
export const BUDGET_BYTES = 14400;

/**
 * The budget violation for a CLAUDE.md of `byteLength` bytes, or null when it
 * fits. Bytes rather than characters or lines: the size of the file on disk is
 * what a session pays for, and it is what a strip pass is measured against.
 */
export function budgetViolation(byteLength) {
  if (byteLength <= BUDGET_BYTES) return null;
  return `CLAUDE.md is ${byteLength} bytes, over the ${BUDGET_BYTES}-byte budget by ${byteLength - BUDGET_BYTES}. Relocate that much detail into the file that owns the mechanism -- a command file under .claude/commands/, the header of the hook that enforces it, or the matching docs/ tier -- keeping the one-line rule and a pointer here. Do not delete a rule to make room.`;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// function without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abs = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "CLAUDE.md",
  );
  const bytes = Buffer.byteLength(readFileSync(abs));
  const violation = budgetViolation(bytes);
  if (violation) {
    console.error(violation);
    process.exit(1);
  }
  console.log(
    `CLAUDE.md budget check passed: ${bytes} of ${BUDGET_BYTES} bytes.`,
  );
}
