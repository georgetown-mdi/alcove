#!/usr/bin/env node
// Review-ledger disposition check, run at merge-ready
// (`.claude/commands/assess-review.md`, Step 4 readiness). Usage is USAGE below.
// Tests each disposition in a rounds ledger
// (`scratch/review-rounds/<key>.jsonl`, rows in
// `.claude/commands/review-round.md`, Step 3) against the PR head, refusing:
//
// - a `fixed` entry whose `"commit": "<sha>"` is not contained in the head: not
//   an ancestor, and no head commit with the same patch identity as
//   `git cherry` decides it;
// - a `deferred` entry naming none of `"board": "<board>/<itemId>"`,
//   `"followUp": "<slug>"` (a held follow-up, `.claude/pm/ruleset.md`, Filing
//   and updating items), and
//   `"limitsLine": "docs/spec/<path>#<anchor or \"quoted phrase\">"`, a board
//   or follow-up value not of its shape, a limits file absent at the head, or a
//   quoted phrase that file does not hold (an anchor is not resolved; a board
//   item and a follow-up are checked for shape only, the follow-up because the
//   continuation brief listing it is host-local and gitignored). A follow-up
//   also needs what a `limit` entry does, `"surface": "internal"` or a
//   `limitsLine` the head holds, so a follow-up the pass declines leaves no
//   reachable limit undocumented;
// - a `limit` entry whose `"surface"` is `"reachable"` or absent and which names
//   no `limitsLine` passing the `deferred` rules, or whose `surface` is any
//   value other than those two. `"surface": "internal"` passes.
//
// It also refuses a ledger recording two or more cap raises whose second raise
// has no step-back record. The raises are every row's `capRaises` entries in
// row order; the second needs `"stepBack": {"sharedCause": "<answer>",
// "pivot": "re-scope" | "panel" | "owner"}`, and a `capRaises` that is not a
// list is refused. A raise recorded only in `capNote` prose is not counted.
//
// It also refuses product commits made after the last review with no fix review
// and no declaration, run before `gh pr ready` with the PR body (`--body`):
//
// - The last reviewed head is the last of: a round row's `"head"`, a
//   `"kind": "fix-review"` row's `"head"` when its `"from"` is the reviewed head
//   or an ancestor of it, and a `reattested` entry's `"to"` when its `"from"`
//   is the reviewed head and its `"route"` names one of REATTESTATION_ROUTES,
//   the mechanical verifiers. A row dated FIX_REVIEW_RULE_DATE or later that
//   records no head is refused; with no head recorded at all the rule is
//   reported not checked. `--print-base` prints that head, the `--base` a fix
//   review takes.
// - A product commit is one in `<reviewed head>..<PR head>`, merges excluded,
//   touching a path matching `^(apps|packages)/` and not
//   `^(apps|packages)/[^/]+/test/` (isProductPath). A base sync after the last
//   review therefore lists staging's commits too.
// - With any, the PR body's single Security review line, which must attest the
//   PR head, has to contain "not re-reviewed" in its label or resolution.
//
// Whether a fix was an exact edit or a judgment call is the session's to know:
// the declaration is accepted for either, and this check cannot tell them apart.
//
// `--remap` rewrites each `fixed` entry's commit in place to the commit a rebase
// made from it, paired by author, author date and message; a fix the rebase
// squashed or reworded stays unpaired and keeps its old id.
//
// A row is skipped as legacy when its `date` is before LEGACY_CUTOFF_DATE, no
// `fixed` entry in it has a `commit`, no `deferred` entry a `board`,
// `followUp` or `limitsLine`, no `limit` entry a `surface` or `limitsLine`, and no earlier
// row in the ledger has any of those fields. A row dated before
// LIMIT_RULE_DATE is exempt from the `limit` rule. Git runs in the worktree the
// process was invoked from; name full shas, not a per-worktree ref.
//
// Exit 0 every held entry, the cap raises and the post-review fixes pass; 1 any
// of them is refused, each reported on its own summary line, or `--print-base`
// finds no reviewed head; 2 usage, an
// unreadable ledger line or body, an invocation outside a git worktree, or a
// git error.
// Rationale: docs/notes/agent-hooks-and-scripts.md.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { securityReviewItem } from "../../scripts/check-pr-checklist.mjs";
import { parseLedger } from "./lib/reviewLedger.mjs";
import { isAncestor } from "./verify-rebase-invariance.mjs";

/** Rows dated on or after this day are never treated as legacy. */
export const LEGACY_CUTOFF_DATE = "2026-10-01";

/** Rows dated on or after this day are held to the `limit` check. */
export const LIMIT_RULE_DATE = "2026-10-07";

const dispositionsOf = (row) =>
  Array.isArray(row.dispositions) ? row.dispositions : [];

/** Whether a row records any of the fields this check reads. */
export function rowUsesDispositionFields(row) {
  return dispositionsOf(row).some(
    (entry) =>
      (entry.disposition === "fixed" && entry.commit !== undefined) ||
      (entry.disposition === "deferred" &&
        (entry.board !== undefined ||
          entry.followUp !== undefined ||
          entry.limitsLine !== undefined)) ||
      (entry.disposition === "limit" &&
        (entry.surface !== undefined || entry.limitsLine !== undefined)),
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

/** A held follow-up's slug: lowercase letter and digit runs joined by single hyphens. */
export const FOLLOW_UP_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a deferred entry names no valid home, or null where it names one. */
export function deferralHomeReason({ entry, head, git }) {
  if (entry.board !== undefined) {
    if (typeof entry.board === "string" && BOARD_SHAPE.test(entry.board))
      return null;
    return `"board" is ${JSON.stringify(entry.board)}, not "<board>/<itemId>"`;
  }
  if (entry.followUp !== undefined) {
    if (
      typeof entry.followUp === "string" &&
      FOLLOW_UP_SHAPE.test(entry.followUp)
    ) {
      const limit = limitHomeReason({ entry, head, git });
      if (limit === null) return null;
      return `held follow-up "${entry.followUp}" also needs what a limit does, in case the follow-ups pass declines it: ${limit}`;
    }
    return `"followUp" is ${JSON.stringify(entry.followUp)}, not a "<slug>" of lowercase letters and digits joined by single hyphens`;
  }
  if (entry.limitsLine === undefined)
    return 'a deferred entry names no "board" item, "followUp", or "limitsLine"';
  return limitsLineReason({ limitsLine: entry.limitsLine, head, git });
}

/**
 * Why a limit entry is refused, or null where it passes: an internal limit
 * passes, and a reachable one, the default, needs a limits line the head holds.
 */
export function limitHomeReason({ entry, head, git }) {
  const surface = entry.surface ?? "reachable";
  if (surface === "internal") return null;
  if (surface !== "reachable")
    return `"surface" is ${JSON.stringify(entry.surface)}, not "reachable" or "internal"`;
  if (entry.limitsLine === undefined)
    return 'a limit on a reachable surface names no "limitsLine"; write the spec line, or mark the entry "surface": "internal"';
  return limitsLineReason({ limitsLine: entry.limitsLine, head, git });
}

/** Why a `limitsLine` value does not name a spec line at `head`, or null. */
function limitsLineReason({ limitsLine: value, head, git }) {
  const limitsLine = String(value);
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
 * One result per `fixed`, `deferred`, or `limit` entry: `{round, item,
 * disposition, status, reason}`, where status is `ok`, `refused`, or
 * `skipped` (a legacy row). Entries of every other disposition are not this
 * check's subject.
 */
export function checkLedger({ rows, head, git }) {
  const legacy = legacyRows(rows);
  const reasonFor = {
    fixed: (entry) =>
      fixNotContainedReason({ commit: entry.commit, head, git }),
    deferred: (entry) => deferralHomeReason({ entry, head, git }),
    limit: (entry) => limitHomeReason({ entry, head, git }),
  };
  const results = [];
  for (const { row } of rows) {
    for (const entry of dispositionsOf(row)) {
      const { disposition, item } = entry;
      if (!Object.hasOwn(reasonFor, disposition)) continue;
      const base = { round: row.round, item, disposition };
      if (legacy.has(row)) {
        results.push({ ...base, status: "skipped", reason: "legacy row" });
        continue;
      }
      if (
        disposition === "limit" &&
        typeof row.date === "string" &&
        row.date < LIMIT_RULE_DATE
      ) {
        results.push({
          ...base,
          status: "pre-rule",
          reason: "limit before the limit rule",
        });
        continue;
      }
      const reason = reasonFor[disposition](entry);
      results.push({
        ...base,
        status: reason === null ? "ok" : "refused",
        reason,
      });
    }
  }
  return results;
}

/** The pivots a step-back record may name. */
export const STEP_BACK_PIVOTS = ["re-scope", "panel", "owner"];

/**
 * The last date, YYYY-MM-DD, capRaiseCheck stands before it is renewed or
 * deleted (scripts/check-expiry-dates.mjs).
 */
export const CAP_RAISE_CHECK_EXPIRES_ON = "2027-03-31";

/**
 * Why the ledger's cap raises are refused, or null where they pass, with the
 * number of raises it read: the second raise needs a step-back record stating
 * the shared-cause answer and the pivot taken.
 */
export function capRaiseCheck(rows) {
  const raises = [];
  for (const { row } of rows) {
    if (row.capRaises === undefined) continue;
    if (!Array.isArray(row.capRaises))
      return {
        count: raises.length,
        reason: `round ${row.round}'s "capRaises" is not a list`,
      };
    raises.push(...row.capRaises);
  }
  const result = (reason) => ({ count: raises.length, reason });
  if (raises.length < 2) return result(null);
  const stepBack = raises[1]?.stepBack;
  if (stepBack === null || typeof stepBack !== "object")
    return result('the second cap raise records no "stepBack"');
  if (
    typeof stepBack.sharedCause !== "string" ||
    stepBack.sharedCause.trim() === ""
  )
    return result(
      'the second cap raise\'s "stepBack" states no "sharedCause" answer',
    );
  if (!STEP_BACK_PIVOTS.includes(stepBack.pivot))
    return result(
      `the second cap raise's "stepBack" pivot is ${JSON.stringify(stepBack.pivot)}, not one of ${STEP_BACK_PIVOTS.map((pivot) => `"${pivot}"`).join(", ")}`,
    );
  return result(null);
}

/** The ledger row kind a fix review is booked under. */
export const FIX_REVIEW_KIND = "fix-review";

/** Rows dated on or after this day record the head they read. */
export const FIX_REVIEW_RULE_DATE = "2026-10-28";

/**
 * The last date, YYYY-MM-DD, fixReviewCheck stands before it is renewed or
 * deleted (scripts/check-expiry-dates.mjs).
 */
export const FIX_REVIEW_CHECK_EXPIRES_ON = "2027-03-31";

/** The declaration a Security review line makes for an unreviewed fix. */
export const NOT_RE_REVIEWED = "not re-reviewed";

/** Whether `path` is product code: under apps/ or packages/, outside a test/. */
export function isProductPath(path) {
  return (
    /^(apps|packages)\//.test(path) &&
    !/^(apps|packages)\/[^/]+\/test\//.test(path)
  );
}

/** The full sha `ref` names, or null where it names no commit. */
function resolveCommit(ref, git) {
  if (typeof ref !== "string" || ref === "") return null;
  try {
    return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    return null;
  }
}

/**
 * The `reattested` routes that advance the last reviewed head: each names the
 * `verify-<route>.mjs` verifier that re-attested the move.
 */
export const REATTESTATION_ROUTES = [
  "rebase-invariance",
  "nonexecutable-delta",
  "additive-test-delta",
];

/**
 * The last head a review read, walking rows in order: a round's `head`, a
 * fix review's `head` when its `from` is that head or an ancestor of it, and a
 * `reattested` entry's `to` when its `from` is that head and its route is in
 * REATTESTATION_ROUTES. Returns `{reviewed, problems, notes}`; `reviewed` is
 * null when no row records a head.
 */
export function lastReviewedHead({ rows, git }) {
  let reviewed = null;
  const problems = [];
  const notes = [];
  for (const { row } of rows) {
    const label =
      row.kind === FIX_REVIEW_KIND ? "a fix review" : `round ${row.round}`;
    const bound =
      typeof row.date === "string" && row.date >= FIX_REVIEW_RULE_DATE;
    if (row.kind === FIX_REVIEW_KIND) {
      const from = resolveCommit(row.from, git);
      const to = resolveCommit(row.head, git);
      if (from === null || to === null) {
        problems.push(
          `${label} names no "from" and "head" commits that resolve`,
        );
      } else if (
        reviewed === null ||
        from === reviewed ||
        isAncestor({ ancestor: from, descendant: reviewed, git })
      ) {
        reviewed = to;
      } else {
        notes.push(
          `${label} of ${from}..${to} starts after ${reviewed}, so it leaves the commits between unreviewed`,
        );
      }
    } else if (row.head !== undefined) {
      const to = resolveCommit(row.head, git);
      if (to === null) problems.push(`${label}'s "head" does not resolve`);
      else reviewed = to;
    } else if (bound) {
      problems.push(`${label} records no "head"`);
    }
    for (const entry of Array.isArray(row.reattested) ? row.reattested : []) {
      if (!REATTESTATION_ROUTES.includes(entry?.route) || reviewed === null)
        continue;
      const to = resolveCommit(entry.to, git);
      if (resolveCommit(entry.from, git) === reviewed && to !== null)
        reviewed = to;
    }
  }
  return { reviewed, problems, notes };
}

/** The commits in `reviewed..head` touching a product path, newest first. */
export function postReviewProductCommits({ reviewed, head, git }) {
  const commits = [];
  const log = git([
    "log",
    "--no-merges",
    "--format=%H %s",
    `${reviewed}..${head}`,
  ]).trim();
  for (const line of log === "" ? [] : log.split("\n")) {
    const space = line.indexOf(" ");
    const sha = line.slice(0, space);
    const paths = git([
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "--no-renames",
      "-r",
      "--root",
      sha,
    ])
      .split("\n")
      .filter(isProductPath);
    if (paths.length > 0)
      commits.push({ sha, subject: line.slice(space + 1), paths });
  }
  return commits;
}

/**
 * The post-review fix rule, as `{status, reason, commits}`: status `ok`,
 * `refused`, or `not-checked` (no row records a head). `body` is the PR body
 * whose Security review line must attest `head`.
 */
export function fixReviewCheck({ rows, head, body, git }) {
  const result = (status, reason, commits = []) => ({
    status,
    reason,
    commits,
  });
  const item = securityReviewItem(body);
  if (item === null)
    return result(
      "refused",
      "the PR body holds no single Security review line",
    );
  if (
    item.attested === null ||
    !head.toLowerCase().startsWith(item.attested.toLowerCase())
  )
    return result(
      "refused",
      `the Security review line attests ${item.attested ?? "no sha"}, not the head ${head}`,
    );
  const { reviewed, problems, notes } = lastReviewedHead({ rows, git });
  if (problems.length > 0) return result("refused", problems.join("; "));
  if (reviewed === null)
    return result(
      "not-checked",
      `no ledger row records the head it read (rows dated before ${FIX_REVIEW_RULE_DATE} need not)`,
    );
  if (!isAncestor({ ancestor: reviewed, descendant: head, git }))
    return result(
      "refused",
      `the last reviewed head ${reviewed} is not an ancestor of ${head}; record the rebase re-attestation, or review the fix range`,
    );
  const commits = postReviewProductCommits({ reviewed, head, git });
  if (commits.length === 0)
    return result("ok", `no product commit after ${reviewed}`);
  const declared = `${item.label} -- ${item.clause}`
    .toLowerCase()
    .includes(NOT_RE_REVIEWED);
  if (declared)
    return result(
      "ok",
      `${commits.length} product commit(s) after ${reviewed}, declared "${NOT_RE_REVIEWED}"`,
      commits,
    );
  return result(
    "refused",
    [
      `${commits.length} product commit(s) after the last reviewed head ${reviewed} have no fix review`,
      ...notes,
    ].join("; "),
    commits,
  );
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
  "Usage: node .claude/scripts/check-review-ledger-dispositions.mjs <ledger.jsonl> <head-sha> --body <pr-body-file | ->\n" +
  "       node .claude/scripts/check-review-ledger-dispositions.mjs --remap <ledger.jsonl> <pre-rebase-base> <pre-rebase-head> <post-rebase-base> <post-rebase-head>\n" +
  "       node .claude/scripts/check-review-ledger-dispositions.mjs --print-base <ledger.jsonl>\n" +
  "The first form checks every fixed, deferred and limit entry against the PR head, and the\n" +
  "product commits after the last reviewed head against the PR body's Security review line\n" +
  "(`-` reads the body from stdin: gh pr view <n> --json body --jq .body | ... --body -). The second,\n" +
  "run at a rebase re-attestation with the four shas given to verify-rebase-invariance.mjs,\n" +
  "rewrites each fixed entry's commit in the ledger to the commit the rebase made from it.\n" +
  "The third prints the last reviewed head, the sha a fix review's --base takes, or exits 1\n" +
  "naming why the ledger records none.\n" +
  "Refs resolve in the git worktree this is run from; name full shas.\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const remap = args[0] === "--remap";
  const printBase = args[0] === "--print-base";
  const bodyAt = args.indexOf("--body");
  const bodyPath = bodyAt === -1 ? undefined : args[bodyAt + 1];
  const positional =
    remap || printBase
      ? args.slice(1)
      : bodyAt === -1
        ? args
        : args.filter((_, i) => i !== bodyAt && i !== bodyAt + 1);
  if (
    positional.length !== (remap ? 5 : printBase ? 1 : 2) ||
    (remap || printBase ? bodyAt !== -1 : bodyPath === undefined)
  ) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const [ledgerPath, ...refs] = positional;
  let body;
  if (!remap && !printBase) {
    try {
      body = readFileSync(bodyPath === "-" ? 0 : bodyPath, "utf8");
    } catch (error) {
      process.stderr.write(
        `error: cannot read the PR body from ${bodyPath}: ${error.message}\n`,
      );
      process.exit(2);
    }
  }

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
    if (printBase) {
      const { reviewed, problems } = lastReviewedHead({ rows, git });
      if (problems.length > 0 || reviewed === null) {
        process.stderr.write(
          `no reviewed head: ${problems.length > 0 ? problems.join("; ") : "no ledger row records the head it read"}\n`,
        );
        process.exit(1);
      }
      process.stdout.write(`${reviewed}\n`);
      process.exit(0);
    }
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
        `  [${status.toUpperCase().padEnd(7)}] ${round === undefined ? "a fix review" : `round ${round}`} ${disposition}: ${item}\n`,
      );
      if (status !== "ok") process.stdout.write(`            ${reason}\n`);
    }
    const caps = capRaiseCheck(rows);
    const refused = results.filter((r) => r.status === "refused").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const preRule = results.filter((r) => r.status === "pre-rule").length;
    process.stdout.write(
      refused === 0
        ? `\ndispositions: PASS -- ${results.length - skipped - preRule} checked, ${skipped} skipped as legacy${preRule === 0 ? "" : `, ${preRule} limits before the limit rule`}\n`
        : `\ndispositions: REFUSED -- ${refused} entr${refused === 1 ? "y" : "ies"} fail; record the fix commit that reached the head; give a deferral a board item, held follow-up, or limits line, or record it as a limit; write a reachable limit's spec limits line, or mark it "surface": "internal"\n`,
    );
    process.stdout.write(
      caps.reason === null
        ? `cap raises: PASS -- ${caps.count} recorded\n`
        : `cap raises: REFUSED -- ${caps.reason}; record each raise in a "capRaises" list, and a "stepBack" on the second\n`,
    );
    const fixes = fixReviewCheck({
      rows,
      head: resolveCommit(head, git),
      body,
      git,
    });
    for (const { sha, subject } of fixes.commits)
      process.stdout.write(`  ${sha}  ${subject}\n`);
    process.stdout.write(
      fixes.status === "refused"
        ? `post-review fixes: REFUSED -- ${fixes.reason}${fixes.commits.length > 0 ? `; run a fix review (/review-round --base), or, for an exact edit, write "${NOT_RE_REVIEWED}" on the Security review line` : ""}\n`
        : `post-review fixes: ${fixes.status === "ok" ? "PASS" : "NOT CHECKED"} -- ${fixes.reason}\n`,
    );
    process.exit(
      refused === 0 && caps.reason === null && fixes.status !== "refused"
        ? 0
        : 1,
    );
  } catch (error) {
    process.stderr.write(`error: ${error.message ?? error}\n`);
    process.exit(2);
  }
}
