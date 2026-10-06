#!/usr/bin/env node
// Review-ledger disposition check, run by the session at merge-ready
// (`.claude/commands/assess-review.md`, Step 4 readiness).
//
// A branch's rounds ledger (`scratch/review-rounds/<key>.jsonl`, row shape in
// `.claude/commands/light-review.md`, Step 3) records how each finding was
// disposed of. Two of those dispositions assert something outside the ledger,
// and this check tests both against the PR head:
//
// - A `fixed` entry names its fix commit as `"commit": "<sha>"`. It is refused
//   when that fix is not contained in the head. Contained means the commit is
//   an ancestor of the head, or the head holds a commit with the same patch
//   identity, as `git cherry` decides it (`git patch-id --stable` over each
//   commit reachable from the head but not from the fix). Patch identity is
//   what lets a fix survive a rebase, which re-authors every commit id.
// - A `deferred` entry names a home: `"board": "<board>/<itemId>"`, or
//   `"limitsLine": "docs/spec/<path>#<anchor or \"quoted phrase\">"`. It is
//   refused when it names neither, when the board value is not of that shape,
//   or when the limits file does not exist at the head. A quoted phrase must
//   appear in that file at the head; an anchor is not resolved, and a board
//   item is checked for shape only, since the boards are not reachable offline.
//
// A conflict resolution that edits a fix's hunk changes its patch identity, so
// patch identity alone would refuse a correct fix after such a rebase. The
// rebase re-attestation step closes that: `--remap` rewrites each `fixed`
// entry's commit in place to the commit the rebase made from it, paired by
// author, author date, and message, which a rebase preserves and a conflict
// resolution does not touch. A rebase that squashes or rewords the fix commit
// leaves it unpaired, and its entry keeps the old id for the check to refuse.
//
// Legacy rows. Rows written before these fields existed name no commit and no
// home, so the check skips a row, reporting it as skipped, when all three
// hold: its `date` is before LEGACY_CUTOFF_DATE; no `fixed` entry in it has a
// `commit` and no `deferred` entry has a `board` or `limitsLine`; and no
// earlier row in the same ledger has any of those fields. A row that fails any
// of the three is held to the rules above.
//
// Which tree the verdict is about: git runs in the worktree the process was
// invoked from, never the one holding this file. Name full shas -- a
// per-worktree ref (`HEAD`, `ORIG_HEAD`) means a different commit in each
// linked tree.
//
// Exit codes: 0 every held entry passes (legacy rows skipped); 1 an entry is
// refused; 2 usage, an unreadable ledger line, an invocation from outside a
// git worktree, or a git error.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAncestor } from "./verify-rebase-invariance.mjs";

/** Rows dated on or after this day are never treated as legacy. */
export const LEGACY_CUTOFF_DATE = "2026-10-01";

/**
 * The ledger's rows as `{rows, unreadable}`. Each row keeps the index of the
 * line it came from so `--remap` can rewrite that line alone; a line that is
 * not a JSON object lands in `unreadable`.
 */
export function parseLedger(text) {
  const rows = [];
  const unreadable = [];
  text.split("\n").forEach((line, lineIndex) => {
    if (line.trim() === "") return;
    try {
      const row = JSON.parse(line);
      if (row === null || typeof row !== "object" || Array.isArray(row))
        throw new Error("not a JSON object");
      rows.push({ lineIndex, row });
    } catch (error) {
      unreadable.push({ lineNumber: lineIndex + 1, reason: error.message });
    }
  });
  return { rows, unreadable };
}

const dispositionsOf = (row) =>
  Array.isArray(row.dispositions) ? row.dispositions : [];

/** Whether a row records any of the fields this check reads. */
export function rowUsesDispositionFields(row) {
  return dispositionsOf(row).some(
    (entry) =>
      (entry.disposition === "fixed" && entry.commit !== undefined) ||
      (entry.disposition === "deferred" &&
        (entry.board !== undefined || entry.limitsLine !== undefined)),
  );
}

/**
 * The rows the legacy rule in this file's header exempts, as a Set of row
 * objects.
 */
export function legacyRows(rows) {
  const legacy = new Set();
  let fieldsSeen = false;
  for (const { row } of rows) {
    if (rowUsesDispositionFields(row)) fieldsSeen = true;
    const datedBeforeCutoff =
      typeof row.date === "string" && row.date < LEGACY_CUTOFF_DATE;
    if (!fieldsSeen && datedBeforeCutoff) legacy.add(row);
  }
  return legacy;
}

/**
 * Why the fix commit is not contained in `head`, or null where it is. A
 * commit that does not resolve, or that has no parent to bound `git cherry`
 * by and is not an ancestor, is refused rather than guessed about.
 */
export function fixNotContainedReason({ commit, head, git }) {
  if (typeof commit !== "string" || commit === "")
    return 'a fixed entry names no "commit"';
  let fix;
  try {
    fix = git([
      "rev-parse",
      "--verify",
      "--quiet",
      `${commit}^{commit}`,
    ]).trim();
  } catch {
    return `fix commit ${commit} does not resolve in this repository`;
  }
  if (isAncestor({ ancestor: fix, descendant: head, git })) return null;
  let parent;
  try {
    parent = git(["rev-parse", "--verify", "--quiet", `${fix}^`]).trim();
  } catch {
    return `fix commit ${commit} is a root commit and not an ancestor of ${head}`;
  }
  const cherry = git(["cherry", head, fix, parent]).trim();
  if (cherry === `- ${fix}`) return null;
  return `fix commit ${commit} is not an ancestor of ${head}, and no commit in ${head} has its patch`;
}

const BOARD_SHAPE = /^[^/\s]+\/[^/\s]+$/;

/** Why a deferred entry names no valid home, or null where it names one. */
export function deferralHomeReason({ entry, head, git }) {
  if (entry.board !== undefined) {
    if (typeof entry.board === "string" && BOARD_SHAPE.test(entry.board))
      return null;
    return `"board" is ${JSON.stringify(entry.board)}, not "<board>/<itemId>"`;
  }
  if (entry.limitsLine === undefined)
    return 'a deferred entry names neither a "board" item nor a "limitsLine"';
  const limitsLine = String(entry.limitsLine);
  const hash = limitsLine.indexOf("#");
  const path = hash === -1 ? limitsLine : limitsLine.slice(0, hash);
  const locator = hash === -1 ? "" : limitsLine.slice(hash + 1);
  if (!path.startsWith("docs/spec/") || locator === "")
    return `"limitsLine" is ${JSON.stringify(limitsLine)}, not "docs/spec/<path>#<anchor or quoted phrase>"`;
  let text;
  try {
    text = git(["show", `${head}:${path}`]);
  } catch {
    return `"limitsLine" names ${path}, which does not exist at ${head}`;
  }
  const quoted = /^"(.+)"$/.exec(locator);
  if (quoted !== null && !text.includes(quoted[1]))
    return `"limitsLine" quotes a phrase ${path} does not hold at ${head}`;
  return null;
}

/**
 * One result per `fixed` or `deferred` entry: `{round, item, disposition,
 * status, reason}`, where status is `ok`, `refused`, or `skipped` (a legacy
 * row). Entries of every other disposition are not this check's subject.
 */
export function checkLedger({ rows, head, git }) {
  const legacy = legacyRows(rows);
  const results = [];
  for (const { row } of rows) {
    for (const entry of dispositionsOf(row)) {
      const { disposition, item } = entry;
      if (disposition !== "fixed" && disposition !== "deferred") continue;
      const base = { round: row.round, item, disposition };
      if (legacy.has(row)) {
        results.push({ ...base, status: "skipped", reason: "legacy row" });
        continue;
      }
      const reason =
        disposition === "fixed"
          ? fixNotContainedReason({ commit: entry.commit, head, git })
          : deferralHomeReason({ entry, head, git });
      results.push({
        ...base,
        status: reason === null ? "ok" : "refused",
        reason,
      });
    }
  }
  return results;
}

/** Commits in `base..head`, keyed by author, author date, and message. */
function commitsByAuthorship({ base, head, git }) {
  const byKey = new Map();
  const log = git([
    "log",
    "--no-merges",
    "-z",
    "--format=%H%x00%an <%ae> %ad%x00%B",
    "--date=raw",
    `${base}..${head}`,
  ]);
  const fields = log.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const sha = fields[i];
    const key = `${fields[i + 1]}\n${fields[i + 2].trimEnd()}`;
    byKey.set(key, byKey.has(key) ? null : sha);
  }
  return byKey;
}

/**
 * The ledger text with each `fixed` entry's commit re-recorded as the commit
 * the rebase made from it, and the list of `{from, to}` rewrites. Only the
 * lines holding a rewritten entry change. An old commit outside the pre-rebase
 * range, or whose authorship key is not unique on both sides, is left as is.
 */
export function remapFixCommits({
  text,
  oldBase,
  oldHead,
  newBase,
  newHead,
  git,
}) {
  const before = commitsByAuthorship({ base: oldBase, head: oldHead, git });
  const after = commitsByAuthorship({ base: newBase, head: newHead, git });
  const oldToNew = new Map();
  for (const [key, sha] of before) {
    const mapped = after.get(key);
    if (sha !== null && typeof mapped === "string") oldToNew.set(sha, mapped);
  }
  const lines = text.split("\n");
  const remapped = [];
  for (const { lineIndex, row } of parseLedger(text).rows) {
    let changed = false;
    for (const entry of dispositionsOf(row)) {
      if (entry.disposition !== "fixed" || typeof entry.commit !== "string")
        continue;
      let full;
      try {
        full = git([
          "rev-parse",
          "--verify",
          "--quiet",
          `${entry.commit}^{commit}`,
        ]).trim();
      } catch {
        continue;
      }
      const to = oldToNew.get(full);
      if (to === undefined) continue;
      remapped.push({ item: entry.item, from: entry.commit, to });
      entry.commit = to;
      changed = true;
    }
    if (changed) lines[lineIndex] = JSON.stringify(row);
  }
  return { text: lines.join("\n"), remapped };
}

const USAGE =
  "Usage: node .claude/scripts/check-review-ledger-dispositions.mjs <ledger.jsonl> <head-sha>\n" +
  "       node .claude/scripts/check-review-ledger-dispositions.mjs --remap <ledger.jsonl> <pre-rebase-base> <pre-rebase-head> <post-rebase-base> <post-rebase-head>\n" +
  "The first form checks every fixed and deferred entry against the PR head. The second,\n" +
  "run at a rebase re-attestation with the four shas given to verify-rebase-invariance.mjs,\n" +
  "rewrites each fixed entry's commit in the ledger to the commit the rebase made from it.\n" +
  "Refs resolve in the git worktree this is run from; name full shas.\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const remap = args[0] === "--remap";
  const positional = remap ? args.slice(1) : args;
  if (positional.length !== (remap ? 5 : 2)) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const [ledgerPath, ...refs] = positional;

  let worktree;
  try {
    worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    process.stderr.write(
      `error: ${process.cwd()} is not inside a git worktree -- run this inside the one whose refs you are naming (git: ${error.message ?? error})\n`,
    );
    process.exit(2);
  }
  const git = (gitArgs) =>
    execFileSync("git", gitArgs, {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });

  let text;
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch (error) {
    process.stderr.write(
      `error: cannot read ${ledgerPath}: ${error.message}\n`,
    );
    process.exit(2);
  }
  const { rows, unreadable } = parseLedger(text);
  if (unreadable.length > 0) {
    for (const { lineNumber, reason } of unreadable)
      process.stderr.write(
        `error: ${ledgerPath} line ${lineNumber} is not a ledger row (${reason})\n`,
      );
    process.exit(2);
  }

  try {
    for (const ref of refs)
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (remap) {
      const [oldBase, oldHead, newBase, newHead] = refs;
      const result = remapFixCommits({
        text,
        oldBase,
        oldHead,
        newBase,
        newHead,
        git,
      });
      if (result.remapped.length > 0) writeFileSync(ledgerPath, result.text);
      process.stdout.write(`worktree: ${worktree}\n`);
      for (const { item, from, to } of result.remapped)
        process.stdout.write(`  ${from} -> ${to}  ${item}\n`);
      process.stdout.write(
        `re-recorded ${result.remapped.length} fixed commit(s) in ${ledgerPath}\n`,
      );
      process.exit(0);
    }
    const [head] = refs;
    const results = checkLedger({ rows, head, git });
    process.stdout.write(`worktree: ${worktree}\nhead: ${head}\n`);
    for (const { round, item, disposition, status, reason } of results) {
      process.stdout.write(
        `  [${status.toUpperCase().padEnd(7)}] round ${round} ${disposition}: ${item}\n`,
      );
      if (status !== "ok") process.stdout.write(`            ${reason}\n`);
    }
    const refused = results.filter((r) => r.status === "refused").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    process.stdout.write(
      refused === 0
        ? `\ndispositions: PASS -- ${results.length - skipped} checked, ${skipped} skipped as legacy\n`
        : `\ndispositions: REFUSED -- ${refused} entr${refused === 1 ? "y" : "ies"} fail; record the fix commit that reached the head, or give the deferral a board item or limits line, or record it as limit with a note\n`,
    );
    process.exit(refused === 0 ? 0 : 1);
  } catch (error) {
    process.stderr.write(`error: ${error.message ?? error}\n`);
    process.exit(2);
  }
}
