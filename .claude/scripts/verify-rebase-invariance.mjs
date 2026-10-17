#!/usr/bin/env node
// Rebase-invariance verifier, run by an agent re-attesting a review across a
// rebase (.claude/commands/assess-review.md, Step 4): decides whether the rebase
// left the branch's own diff unchanged -- the same paths, each the same program
// at both ends once comments are removed and markdown and the spec wording-change
// lists (the .txt files under docs/spec/wording-changes/ and the legacy
// docs/spec/wording-changes.txt) are excluded.
//
// Usage: node .claude/scripts/verify-rebase-invariance.mjs <pre-rebase-base>
// <pre-rebase-head> <post-rebase-base> <post-rebase-head> --ledger
// <ledger.jsonl>, run from the worktree the refs belong to, naming full shas;
// the run names that worktree above its verdicts. Runs
// verify-nonexecutable-delta.mjs's comparison over the paths the branch's diff
// touches, once between the two bases and once between the two heads; a path is
// invariant when both report exempt or comment-only. A TypeScript/JavaScript
// path the staging range changed is invariant when the branch's own hunks to it
// are unchanged instead: the same `git patch-id --verbatim` over the
// comment-free canonical form of its base-to-head diff, three lines of context
// included, at both ends -- unless a claim in the ledger's rows names the path,
// or any claim names no file.
// Refuses on shape unless each base is an ancestor of its own head, the new base
// descends from the old, and the pre-rebase head is not an ancestor of the new
// head. A diff record it does not model fails the run.
//
// Exit codes: 0 the property holds; 1 it is violated or a changed path could
// not be verified; 2 usage, a shape this path does not apply to, an unreadable
// ledger, an invocation from outside a git worktree, or a git error; 3 the
// verifier failed the sibling's soundness probes. Rationale:
// docs/notes/rebase-reattestation.md; limits:
// docs/notes/agent-hooks-and-scripts.md.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  canonicalSource,
  classifyPath,
  collectVerdicts,
  parseChangedPaths,
  soundnessProbes,
} from "./verify-nonexecutable-delta.mjs";
import { parseLedger } from "./lib/reviewLedger.mjs";

/**
 * The paths one end's branch diff touches, as `{paths, unreadable}`. A record
 * whose shape `parseChangedPaths` does not model lands in `unreadable` with its
 * raw text, so the run refuses rather than comparing a path set that silently
 * lost an entry.
 */
export function branchChangedPaths({ base, head, git }) {
  const paths = [];
  const unreadable = [];
  for (const entry of parseChangedPaths(
    git(["diff", "--raw", "--no-renames", "-z", base, head]),
  )) {
    if (entry.status === null) unreadable.push(entry.record);
    else paths.push(entry.path);
  }
  return { paths, unreadable };
}

/**
 * Whether `ancestor` is an ancestor of `descendant`, which git also answers
 * true for two names of one commit. Only the documented "not an ancestor" exit
 * is read as false; any other git failure throws, so a bad ref does not pass
 * for an answered question.
 */
export function isAncestor({ ancestor, descendant, git }) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

/**
 * The reason these four refs are not a rebase of a reviewed branch, or null
 * where they are. Each check names the shape it rules out; Step 4 routes the
 * shapes ruled out here through the rules it already states.
 */
export function rebaseShapeError({ oldBase, oldHead, newBase, newHead, git }) {
  const ancestry = (ancestor, descendant) =>
    isAncestor({ ancestor, descendant, git });
  if (!ancestry(oldBase, oldHead))
    return `the pre-rebase base ${oldBase} is not an ancestor of the pre-rebase head ${oldHead}, so it is not that head's base`;
  if (!ancestry(newBase, newHead))
    return `the post-rebase base ${newBase} is not an ancestor of the post-rebase head ${newHead}, so it is not that head's base`;
  if (!ancestry(oldBase, newBase))
    return `the post-rebase base ${newBase} does not descend from the pre-rebase base ${oldBase}, so the branch was not rebased onto a moved base`;
  if (ancestry(oldHead, newHead))
    return `the pre-rebase head ${oldHead} is an ancestor of ${newHead}, so the head moved by a merge or by added work rather than by a rebase`;
  return null;
}

const RANK = {
  identical: 0,
  exempt: 1,
  "comment-only": 1,
  "same-hunks": 1,
  "claim-named": 2,
  "executable-delta": 2,
  unverifiable: 3,
};

const IDENTICAL = { verdict: "identical" };

/**
 * One result per path, rolling the two comparisons into the worst verdict
 * either of them reported. A path absent from a comparison is identical at that
 * end -- git reports no record for a blob and mode that match -- so it needs no
 * verdict of its own. `where` names the end the reported verdict came from.
 */
export function rollUpVerdicts({ paths, base, head }) {
  const byPath = (verdicts) => new Map(verdicts.map((v) => [v.path, v]));
  const ends = [
    { where: "base", verdicts: byPath(base) },
    { where: "head", verdicts: byPath(head) },
  ];
  return [...paths].sort().map((path) => {
    let worst = { path, verdict: "identical", where: null };
    for (const { where, verdicts } of ends) {
      const found = verdicts.get(path) ?? IDENTICAL;
      if (RANK[found.verdict] > RANK[worst.verdict])
        worst = { ...found, path, where };
    }
    return worst;
  });
}

const HUNK_DIFF_ARGS = [
  "diff",
  "--no-index",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--diff-algorithm=myers",
  "--unified=3",
  "--",
  "before",
  "after",
];

/**
 * The patch identity of the change from `before` to `after`, two canonical
 * texts, or "" where they are equal. Both texts are written under the same two
 * names, because `git patch-id` hashes the file names along with the hunks.
 * `--verbatim` keeps whitespace, which the default strips even inside a string
 * literal.
 */
export function hunkIdentity(before, after) {
  if (before === after) return "";
  const dir = mkdtempSync(join(tmpdir(), "rebase-hunks-"));
  try {
    writeFileSync(join(dir, "before"), before);
    writeFileSync(join(dir, "after"), after);
    const diff = spawnSync("git", HUNK_DIFF_ARGS, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (diff.status !== 1)
      throw new Error(
        `git diff --no-index exited ${diff.status} on two different texts: ${diff.stderr}`,
      );
    const [id] = execFileSync("git", ["patch-id", "--verbatim"], {
      cwd: dir,
      input: diff.stdout,
      encoding: "utf8",
    }).split(" ");
    if (!/^[0-9a-f]{40,64}$/.test(id))
      throw new Error("git patch-id printed no id for a non-empty diff");
    return id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WORKTREE_PREFIX = /^(?:.*\/)?\.claude\/worktrees\/[^/]+(?:\/|$)/;

/**
 * A claim's `file` as a repo-relative path: a prefix up to a
 * `.claude/worktrees/<name>/` directory, or one of `checkoutRoots` (absolute
 * checkout roots), is stripped, as are a leading `./` and trailing slashes. A
 * file naming a checkout root itself comes back as "".
 */
export function repoRelativeClaimFile(file, checkoutRoots = []) {
  let relative = file.trim();
  if (WORKTREE_PREFIX.test(relative)) {
    relative = relative.replace(WORKTREE_PREFIX, "");
  } else {
    const root = checkoutRoots
      .map((candidate) => candidate.replace(/\/+$/, ""))
      .find(
        (bare) =>
          bare !== "" && (relative === bare || relative.startsWith(`${bare}/`)),
      );
    if (root !== undefined) relative = relative.slice(root.length + 1);
  }
  return relative
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "")
    .replace(/^\.$/, "");
}

/**
 * The claims in a ledger's rows, as `{files, unscoped}`: `files` is each
 * claim's `file` field made repo-relative by `repoRelativeClaimFile`, and
 * `unscoped` counts the claims whose `file` is missing, not a string, or names
 * no path below a checkout root. A line that is not a JSON object throws, so a
 * ledger the run cannot read does not pass for one naming no path.
 */
export function claimFilesOf(text, { checkoutRoots = [] } = {}) {
  const { rows, unreadable } = parseLedger(text);
  if (unreadable.length > 0)
    throw new Error(
      `ledger line ${unreadable[0].lineNumber} is not a JSON object`,
    );
  const files = new Set();
  let unscoped = 0;
  for (const { row } of rows) {
    for (const claim of Array.isArray(row.claims) ? row.claims : []) {
      const relative =
        typeof claim?.file === "string"
          ? repoRelativeClaimFile(claim.file, checkoutRoots)
          : "";
      if (relative === "") unscoped += 1;
      else files.add(relative);
    }
  }
  return { files, unscoped };
}

/**
 * Whether a claim names `path`: its file is the path, a directory above it, or
 * free text containing it. Matching too much costs a round, and matching too
 * little admits a path a claim covers.
 */
export function claimNames(claims, path) {
  return [...claims.files].some(
    (file) => path.startsWith(`${file}/`) || file.includes(path),
  );
}

/**
 * A path's text at a commit, or null where the commit has no such path. Only
 * the documented "does not resolve" exit is read as absent; any other git
 * failure throws.
 */
function textAt({ ref, path, git }) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}:${path}`]);
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
  return git(["show", `${ref}:${path}`]);
}

/**
 * The result for a source path whose content the staging range changed, read
 * by comparing the branch's own hunks to it at the two ends. A side that does
 * not parse makes the path unverifiable, as in the sibling's comparison.
 */
export function sharedPathVerdict({
  path,
  oldBase,
  oldHead,
  newBase,
  newHead,
  git,
  claims,
}) {
  const sides = [oldBase, oldHead, newBase, newHead].map((ref) =>
    canonicalSource(textAt({ ref, path, git }), path),
  );
  const broken = sides.filter((side) => side.parseErrors !== 0).length;
  if (broken > 0)
    return {
      path,
      verdict: "unverifiable",
      where: "hunks",
      reason: `parse errors on ${broken} of the four sides -- the printed form of a broken parse is invented, not canonical`,
    };
  const [a, b, c, d] = sides.map((side) => side.canonical);
  if (hunkIdentity(a, b) !== hunkIdentity(c, d))
    return { path, verdict: "executable-delta", where: "hunks" };
  if (claimNames(claims, path))
    return {
      path,
      verdict: "claim-named",
      where: "base",
      reason:
        "the branch's hunks are unchanged, but a claim in the ledger names this path",
    };
  return { path, verdict: "same-hunks", where: "base" };
}

/**
 * Per-path results for the branch's diff across the rebase. `git` runs one git
 * command from an array of arguments and returns its stdout, throwing on a
 * nonzero exit; injecting it lets a test drive a fixture repository through the
 * same code the CLI runs against this one. `claims` is `claimFilesOf` the
 * branch's ledger; one claim naming no file could cover any shared path, so it
 * turns the hunk comparison off. `unreadable` holds the diff records whose
 * shape stopped the run from naming a path set at all.
 */
export function collectInvariance({
  oldBase,
  oldHead,
  newBase,
  newHead,
  git,
  claims,
}) {
  if (!(claims?.files instanceof Set) || !Number.isInteger(claims.unscoped))
    throw new TypeError("claims is the {files, unscoped} claimFilesOf returns");
  const before = branchChangedPaths({ base: oldBase, head: oldHead, git });
  const after = branchChangedPaths({ base: newBase, head: newHead, git });
  const unreadable = [...before.unreadable, ...after.unreadable];
  if (unreadable.length > 0) return { results: [], unreadable };
  const paths = new Set([...before.paths, ...after.paths]);
  const compare = (attested, head) =>
    collectVerdicts({ attested, head, git, paths: [...paths] });
  const base = compare(oldBase, newBase);
  const movedAtBase = new Set(
    base
      .filter((result) => result.verdict === "executable-delta")
      .map((result) => result.path),
  );
  const results = rollUpVerdicts({
    paths,
    base,
    head: compare(oldHead, newHead),
  }).map((result) => {
    const shared =
      result.verdict === "executable-delta" &&
      movedAtBase.has(result.path) &&
      classifyPath(result.path) === "source";
    if (!shared) return result;
    if (claims.unscoped > 0)
      return {
        ...result,
        reason:
          "a claim in the ledger names no file, so it could cover this path and the branch's hunks are not compared",
      };
    return sharedPathVerdict({
      path: result.path,
      oldBase,
      oldHead,
      newBase,
      newHead,
      git,
      claims,
    });
  });
  return { results, unreadable };
}

const END_NAMES = {
  base: "the branch's base",
  head: "the branch's head",
  hunks: "the branch's own hunks",
};

/** Overall outcome for a run's path results, with the process exit code. */
export function summarizeInvariance(results) {
  const moved = results.filter((result) => RANK[result.verdict] >= 2);
  const holds = moved.length === 0;
  return { holds, moved, first: moved[0] ?? null, exitCode: holds ? 0 : 1 };
}

const LABELS = {
  identical: "identical",
  exempt: "exempt",
  "comment-only": "comment-only",
  "same-hunks": "same hunks",
  "claim-named": "CLAIM NAMES IT",
  "executable-delta": "EXECUTABLE DELTA",
  unverifiable: "UNVERIFIABLE",
};

/** The one-line reason a violated run gives, naming the first path that moved. */
export function violationLine({ path, verdict, where }) {
  const end = END_NAMES[where] ?? "the branch's diff";
  if (verdict === "unverifiable")
    return `${path} could not be verified at ${end}`;
  if (verdict === "claim-named")
    return `${path} changed at the branch's base, outside the branch's own hunks, and a review claim names it`;
  return `${path} changed at ${end}`;
}

/**
 * The four refs and the ledger path from the command line, or null where they
 * are not exactly four refs and one `--ledger <path>`.
 */
export function parseArguments(args) {
  const at = args.indexOf("--ledger");
  if (at === -1 || at + 1 >= args.length) return null;
  const ledger = args[at + 1];
  const refs = args.filter((_, index) => index !== at && index !== at + 1);
  if (refs.length !== 4 || refs.includes("--ledger")) return null;
  const [oldBase, oldHead, newBase, newHead] = refs;
  return { oldBase, oldHead, newBase, newHead, ledger };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === null) {
    process.stderr.write(
      "Usage: node .claude/scripts/verify-rebase-invariance.mjs <pre-rebase-base> <pre-rebase-head> <post-rebase-base> <post-rebase-head> --ledger <ledger.jsonl>\n" +
        "The ledger is the branch's rounds ledger; a path a claim in it names takes a round\n" +
        "whenever the staging range changed it.\n" +
        "The pre-rebase head is the sha the checklist line attests. Where the bases were not\n" +
        "written down, derive them: the pre-rebase base is 'git merge-base <pre-rebase-head>\n" +
        "<post-rebase-head>' and the post-rebase base is 'git merge-base <post-rebase-head>\n" +
        "origin/staging'.\n" +
        "All four refs resolve in the git worktree this is run from, whatever tree holds the\n" +
        "script, and that worktree is what the verdict is about. A per-worktree ref (HEAD,\n" +
        "HEAD~n, ORIG_HEAD) means a different commit in each linked tree, so name full shas\n" +
        "unless you are running inside the tree you mean.\n",
    );
    process.exit(2);
  }

  const probes = soundnessProbes();
  const failedProbes = probes.filter((probe) => !probe.ok);
  if (failedProbes.length > 0) {
    for (const probe of failedProbes) {
      process.stderr.write(`soundness probe failed: ${probe.name}\n`);
    }
    process.stderr.write(
      `verifier is unsound on typescript ${ts.version} -- no verdict; fix .claude/scripts/verify-nonexecutable-delta.mjs before attesting anything\n`,
    );
    process.exit(3);
  }

  let worktree;
  try {
    worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    process.stderr.write(
      `error: ${process.cwd()} is not inside a git worktree -- this verifier reports on the tree it is run from, so run it inside the one whose refs you are naming (git: ${error.message ?? error})\n`,
    );
    process.exit(2);
  }

  const git = (args) =>
    execFileSync("git", args, {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });

  const { oldBase, oldHead, newBase, newHead, ledger } = parsed;
  let claims;
  try {
    const primaryCheckout = dirname(
      git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    );
    claims = claimFilesOf(readFileSync(ledger, "utf8"), {
      checkoutRoots: [worktree, primaryCheckout],
    });
  } catch (error) {
    process.stderr.write(
      `error: cannot read the claims in ${ledger}: ${error.message ?? error}\n`,
    );
    process.exit(2);
  }

  const refs = { oldBase, oldHead, newBase, newHead, git, claims };
  let collected;
  try {
    for (const ref of [oldBase, oldHead, newBase, newHead]) {
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    }
    const shape = rebaseShapeError(refs);
    if (shape !== null) {
      process.stderr.write(
        `error: ${shape} -- this path is for a rebase; take the rules \`.claude/commands/assess-review.md\`, Step 4, states for the shape you have\n`,
      );
      process.exit(2);
    }
    collected = collectInvariance(refs);
  } catch (error) {
    process.stderr.write(`error: ${error.message ?? error}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `soundness probes: ${probes.length}/${probes.length} passed on typescript ${ts.version}\n`,
  );
  process.stdout.write(`worktree: ${worktree}\n`);
  process.stdout.write(
    `ledger: ${ledger} (${claims.files.size} path(s) named by a claim${claims.unscoped > 0 ? `; ${claims.unscoped} claim(s) name no file, so no shared file is admitted by its hunks` : ""})\n`,
  );
  process.stdout.write(
    `branch diff before the rebase: ${oldBase}..${oldHead}\n`,
  );
  process.stdout.write(
    `branch diff after the rebase:  ${newBase}..${newHead}\n`,
  );

  if (collected.unreadable.length > 0) {
    for (const record of collected.unreadable) {
      process.stderr.write(
        `diff record "${record}" has a shape this verifier does not model, so the paths the branch touches cannot be listed\n`,
      );
    }
    process.stdout.write(
      "\nrebase-invariance property: VIOLATES -- the branch's changed paths could not be listed; this head takes a full review round\n",
    );
    process.exit(1);
  }

  const width = Math.max(...Object.values(LABELS).map((label) => label.length));
  process.stdout.write("paths the branch's diff touches:\n");
  if (collected.results.length === 0) process.stdout.write("  (none)\n");
  for (const { path, verdict, where, reason } of collected.results) {
    const end = where === null ? "" : ` at ${END_NAMES[where]}`;
    process.stdout.write(
      `  [${LABELS[verdict].padEnd(width)}] ${path}${end}\n`,
    );
    if (reason !== undefined)
      process.stdout.write(`   ${" ".repeat(width)} ${reason}\n`);
  }

  const { holds, moved, first, exitCode } = summarizeInvariance(
    collected.results,
  );
  process.stdout.write(
    holds
      ? "\nrebase-invariance property: HOLDS -- the branch's own change is unchanged by the rebase; this head may be re-attested, recording both heads on the checklist line\n"
      : `\nrebase-invariance property: VIOLATES -- ${violationLine(first)}${moved.length > 1 ? ` (${moved.length} paths moved in all)` : ""}; this head takes a full review round\n`,
  );
  process.exit(exitCode);
}
