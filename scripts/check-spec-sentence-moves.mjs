#!/usr/bin/env node
// Spec sentence comparison: `npm run check:spec-sentences`.
//
// The units compared, across the changed Markdown files under docs/spec/
// together, so a unit moved from one file to another is unchanged:
//   - a prose sentence: paragraphs and list items are joined across their line
//     breaks, whitespace is collapsed, and the text is split after a `.`, `!`
//     or `?` (and any closing quote, bracket or emphasis) followed by
//     whitespace;
//   - a heading, by its text;
//   - a table row, its cells trimmed;
//   - a fenced code line and a front-matter line, each trimmed.
//
// Not compared: line breaks and indentation, a heading's `#` level, list and
// blockquote markers, the table alignment row, thematic breaks, the target of
// an inline Markdown link outside a code span (its text is compared), and any
// file outside docs/spec/ or not ending in .md.
//
// A pull request changing docs/spec/ writes its own list file,
// docs/spec/wording-changes/<branch>.txt, listing each unit added, dropped or
// reworded, one `- ` line per change and per occurrence, each side the unit's
// text as above and `-` standing for none; a line naming both sides pairs two
// units of one kind. Lines starting with `#` are comments:
//
//   - The sentence as it was. -> The sentence as it is.
//   - - -> A sentence the pull request adds.
//   - A sentence the pull request drops. -> -
//
// The branch's list is every file under docs/spec/wording-changes/ it added or
// modified since the merge base, apart from README.txt; a file it did not
// touch or deleted is not read. A file the branch added is read whole; a file
// it modified is read only for the lines the branch added, so a branch name
// that reuses a merged pull request's file appends to it and the earlier
// entries are never matched. Each branch name maps to one file.
//
// With no --head, the head side is the working tree: tracked files modified or
// deleted, staged or not, and untracked files not ignored, are read from disk,
// so a spec edit or list file not yet committed is checked as it will be
// committed. With --head <ref>, the head side is that committed revision and
// uncommitted edits are ignored.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The directory whose Markdown files are compared. */
export const SPEC_DIRECTORY = "docs/spec/";

/** The only pull request base branch whose changes the comparison checks. */
const STAGING_BRANCH = "staging";

/** The base revision when none is given. */
export const DEFAULT_BASE = "origin/staging";

/** The directory holding one wording-change list file per branch. */
export const WORDING_CHANGES_DIRECTORY = "docs/spec/wording-changes/";

/** The file in that directory describing it, never read as a list. */
export const WORDING_CHANGES_README = `${WORDING_CHANGES_DIRECTORY}README.txt`;

/** The file name stem a branch named README maps to, README.txt being skipped. */
const README_BRANCH = "README-branch";

/** The file name a branch name maps to when it cannot be determined. */
const UNKNOWN_BRANCH = "<branch>";

/** The separator between the old and the new side of a listed change. */
export const CHANGE_SEPARATOR = " -> ";

/** The side of a listed change standing for no unit. */
export const NO_UNIT = "-";

const FENCE = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const HEADING = /^\s{0,3}#{1,6}(?:\s+(.*?))?\s*$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_ALIGNMENT = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BLOCKQUOTE_MARKER = /^\s*(?:>\s?)+/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const SENTENCE_END = /(?<=[.!?]["'`)\]*_]*)\s+/;
const CODE_SPAN_OR_LINK =
  /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|(!?\[(?:[^[\]`]|`[^`]*`|\[[^[\]]*\])*\])\((?:<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;

/** Collapses every run of whitespace to one space and trims the ends. */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** Splits joined prose into sentences after terminal punctuation. */
export function splitSentences(text) {
  const normalized = normalizeWhitespace(text);
  if (normalized === "") return [];
  return normalized.split(SENTENCE_END).filter((sentence) => sentence !== "");
}

/**
 * The text with each inline link's target emptied, `[text](target)` becoming
 * `[text]()`; a code span is left whole.
 */
export function withoutLinkTargets(text) {
  return text.replace(CODE_SPAN_OR_LINK, (match, codeTicks, linkText) =>
    codeTicks === undefined ? `${linkText}()` : match,
  );
}

/** The text two units of one kind are compared by. */
function comparedText(kind, text) {
  return kind === "code line" || kind === "front matter"
    ? text
    : withoutLinkTargets(text);
}

function closesFence(line, fence) {
  const closing = FENCE_CLOSE.exec(line.replace(BLOCKQUOTE_MARKER, ""));
  return (
    closing !== null &&
    closing[1][0] === fence[0] &&
    closing[1].length >= fence.length
  );
}

function tableRowText(line) {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => normalizeWhitespace(cell));
  return cells.join(" | ");
}

/**
 * The comparison units of one Markdown document, in document order, each
 * `{ kind, text }` with kind one of "sentence", "heading", "table row",
 * "code line" or "front matter".
 */
export function specUnits(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const units = [];
  let block = [];
  const flush = () => {
    for (const text of splitSentences(block.join(" "))) {
      units.push({ kind: "sentence", text });
    }
    block = [];
  };

  let index = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, at) => at > 0 && line.trim() === "---");
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const text = normalizeWhitespace(line);
        if (text !== "") units.push({ kind: "front matter", text });
      }
      index = end + 1;
    }
  }

  let fence = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence !== null) {
      if (closesFence(line, fence)) {
        fence = null;
        continue;
      }
      const text = normalizeWhitespace(line);
      if (text !== "") units.push({ kind: "code line", text });
      continue;
    }
    const opening = FENCE.exec(line.replace(BLOCKQUOTE_MARKER, ""));
    if (opening) {
      flush();
      fence = opening[1];
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const text = normalizeWhitespace((heading[1] ?? "").replace(/\s#+$/, ""));
      if (text !== "") units.push({ kind: "heading", text });
      continue;
    }
    if (TABLE_ROW.test(line)) {
      flush();
      if (!TABLE_ALIGNMENT.test(line)) {
        units.push({ kind: "table row", text: tableRowText(line) });
      }
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      flush();
      continue;
    }
    let content = line.replace(BLOCKQUOTE_MARKER, "");
    if (LIST_MARKER.test(content)) {
      flush();
      content = content.replace(LIST_MARKER, "");
    }
    block.push(content.trim());
  }
  flush();
  return units;
}

/**
 * The changes listed in a wording-change list file, one per line: a `- ` line
 * gives its text after the marker, a blank line or one starting with `#` gives
 * none, and any other line is returned whole and read like a `- ` line's text.
 */
export function parseWordingChanges(list) {
  const entries = [];
  for (const line of list.replace(/\r\n?/g, "\n").split("\n")) {
    const text = normalizeWhitespace(line);
    if (text === "" || text.startsWith("#")) continue;
    const item = /^-\s+(.*)$/.exec(text);
    entries.push(item ? item[1] : text);
  }
  return entries;
}

function countUnits(files) {
  const counts = new Map();
  for (const [file, markdown] of files) {
    for (const unit of specUnits(markdown)) {
      const compared = comparedText(unit.kind, unit.text);
      const key = `${unit.kind}\u0000${compared}`;
      const entry = counts.get(key) ?? {
        ...unit,
        compared,
        count: 0,
        files: new Set(),
      };
      entry.count += 1;
      entry.files.add(file);
      counts.set(key, entry);
    }
  }
  return counts;
}

function surplus(from, against) {
  const left = [];
  for (const [key, entry] of from) {
    const extra = entry.count - (against.get(key)?.count ?? 0);
    if (extra > 0) left.push({ ...entry, count: extra });
  }
  return left;
}

function remaining(pool, kind, text) {
  const compared = comparedText(kind, text);
  return pool.find(
    (entry) =>
      entry.count > 0 && entry.kind === kind && entry.compared === compared,
  );
}

function available(pool, kind, text) {
  return text === NO_UNIT || remaining(pool, kind, text) !== undefined;
}

function take(pool, kind, text) {
  if (text !== NO_UNIT) remaining(pool, kind, text).count -= 1;
}

/**
 * The kind under which both sides of a listed change name an outstanding
 * difference (a `-` side names none), or null when no kind does.
 */
function listedKind(dropped, added, old, replacement) {
  if (old === NO_UNIT && replacement === NO_UNIT) return null;
  const kinds = new Set([...dropped, ...added].map((entry) => entry.kind));
  for (const kind of kinds) {
    if (available(dropped, kind, old) && available(added, kind, replacement)) {
      return kind;
    }
  }
  return null;
}

/**
 * Compares the units of the base and head files, each a Map of path to
 * Markdown text, and matches the differences against the listed wording
 * changes. Returns the dropped and added units no listed line accounts for,
 * each `{ kind, text, count, files }`, and the listed lines matching no
 * difference.
 */
export function compareSpecFiles(baseFiles, headFiles, wordingChanges = []) {
  const base = countUnits(baseFiles);
  const head = countUnits(headFiles);
  const dropped = surplus(base, head);
  const added = surplus(head, base);
  const unmatched = [];
  for (const line of wordingChanges) {
    let matched = false;
    let at = line.indexOf(CHANGE_SEPARATOR);
    while (at >= 0 && !matched) {
      const old = line.slice(0, at).trim();
      const replacement = line.slice(at + CHANGE_SEPARATOR.length).trim();
      const kind = listedKind(dropped, added, old, replacement);
      if (kind !== null) {
        take(dropped, kind, old);
        take(added, kind, replacement);
        matched = true;
      }
      at = line.indexOf(CHANGE_SEPARATOR, at + 1);
    }
    if (!matched) unmatched.push(line);
  }
  return {
    dropped: dropped.filter((entry) => entry.count > 0),
    added: added.filter((entry) => entry.count > 0),
    unmatched,
  };
}

/**
 * The list file a branch writes: its name with every character outside
 * `A-Za-z0-9._-` replaced by `-` (`README-branch` for a branch named
 * README), or a `<branch>` placeholder when the name is unknown.
 */
export function listFileFor(branch) {
  const name =
    branch === null || branch === undefined || branch === ""
      ? UNKNOWN_BRANCH
      : branch.replace(/[^A-Za-z0-9._-]/g, "-");
  if (name === "README")
    return `${WORDING_CHANGES_DIRECTORY}${README_BRANCH}.txt`;
  return `${WORDING_CHANGES_DIRECTORY}${name}.txt`;
}

/**
 * The lines listing a comparison's unlisted differences, one per occurrence,
 * ready to paste into a list file. Empty when there are none.
 */
export function formatWordingChanges(result) {
  const lines = [];
  for (const entry of result.dropped) {
    for (let at = 0; at < entry.count; at += 1) {
      lines.push(`- ${entry.text}${CHANGE_SEPARATOR}${NO_UNIT}`);
    }
  }
  for (const entry of result.added) {
    for (let at = 0; at < entry.count; at += 1) {
      lines.push(`- ${NO_UNIT}${CHANGE_SEPARATOR}${entry.text}`);
    }
  }
  return lines;
}

/**
 * Formats a comparison's failures, each unlisted difference named with its
 * files and followed by the lines to write to `listFile`; an unmatched listed
 * line is named with `readFrom`, the list files read. Empty when it passes.
 */
export function formatFailures(
  result,
  { listFile = listFileFor(null), readFrom = [] } = {},
) {
  const lines = [];
  const differences = [
    ...result.dropped.map((entry) => ({ ...entry, side: "dropped" })),
    ...result.added.map((entry) => ({ ...entry, side: "added" })),
  ];
  for (const entry of differences) {
    const files = [...entry.files].sort().join(", ");
    const times = entry.count > 1 ? ` (${entry.count} times)` : "";
    lines.push(`  ${entry.side} ${entry.kind}${times} in ${files}:`);
    lines.push(`    ${entry.text}`);
  }
  if (differences.length > 0) {
    lines.push(
      "",
      `To accept these, list them in ${listFile}, joining a dropped and an added line of one kind into one where the change rewords a unit:`,
      "",
      ...formatWordingChanges(result),
    );
  }
  if (result.unmatched.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `Listed in ${readFrom.length > 0 ? readFrom.join(", ") : WORDING_CHANGES_DIRECTORY} but matching no difference; correct or remove each:`,
    );
    for (const line of result.unmatched) lines.push(`  - ${line}`);
  }
  return lines;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The commit a revision names, or null when it does not resolve. */
export function resolveCommit(root, revision) {
  try {
    return git(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${revision}^{commit}`,
    ]).trim();
  } catch {
    return null;
  }
}

/** The revisions a diff compares: `to` null means the working tree. */
function diffRange(from, to) {
  return to === null ? [from] : [from, to];
}

/** The untracked files, ignored ones aside, under a directory. */
function untrackedFiles(root, directory) {
  return git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    directory,
  ])
    .split("\0")
    .filter((file) => file !== "");
}

/**
 * The Markdown files under docs/spec/ that differ between a commit and another
 * commit, or the working tree when `to` is null.
 */
export function changedSpecFiles(root, from, to) {
  const files = git(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    ...diffRange(from, to),
    "--",
    SPEC_DIRECTORY,
  ]).split("\0");
  if (to === null) files.push(...untrackedFiles(root, SPEC_DIRECTORY));
  return [...new Set(files)].filter((file) => file.endsWith(".md"));
}

function readAt(root, commit, file) {
  if (commit === null) {
    try {
      return readFileSync(resolve(root, file), "utf8");
    } catch {
      return "";
    }
  }
  const listed = git(root, ["ls-tree", "--name-only", commit, "--", file]);
  if (listed.trim() === "") return "";
  return git(root, ["show", `${commit}:${file}`]);
}

/**
 * The list files a range added or modified under the wording-changes
 * directory, README.txt aside, sorted, each `{ path, added }` with `added`
 * true when the range created the file.
 */
function branchListChanges(root, from, to) {
  const fields = git(root, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    ...diffRange(from, to),
    "--",
    WORDING_CHANGES_DIRECTORY,
  ]).split("\0");
  const listFiles = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [status, path] = [fields[at], fields[at + 1]];
    if (status !== "D" && path !== WORDING_CHANGES_README) {
      listFiles.push({ path, added: status === "A" });
    }
  }
  if (to === null) {
    for (const path of untrackedFiles(root, WORDING_CHANGES_DIRECTORY)) {
      if (path !== WORDING_CHANGES_README)
        listFiles.push({ path, added: true });
    }
  }
  return listFiles.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** The paths of the list files a range added or modified. */
export function branchListFiles(root, from, to) {
  return branchListChanges(root, from, to).map((change) => change.path);
}

/**
 * The text of a list file the range changed that counts as the branch's: the
 * whole file when the range added it, otherwise only the lines it added.
 */
function branchListText(root, from, to, { path, added }) {
  if (added) return readAt(root, to, path);
  const diff = git(root, [
    "diff",
    "--no-renames",
    "-U0",
    ...diffRange(from, to),
    "--",
    path,
  ]);
  const lines = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) lines.push(line.slice(1));
  }
  return lines.join("\n");
}

/**
 * Runs the comparison between the merge base of `base` and `head`, and `head`,
 * against the entries of the list files the range added (whole) or modified
 * (the added lines only), read at `head`. With `head` null the head side is
 * the working tree, and the merge base is taken with HEAD. Returns
 * `{ files, listFiles, result }`, or `{ error }` when a revision does not resolve.
 */
export function compareRevisions(root, base, head) {
  const baseCommit = resolveCommit(root, base);
  if (baseCommit === null) return { error: `${base} does not resolve.` };
  const headName = head ?? "HEAD";
  const headCommit = resolveCommit(root, headName);
  if (headCommit === null) return { error: `${headName} does not resolve.` };
  let mergeBase;
  try {
    mergeBase = git(root, ["merge-base", baseCommit, headCommit]).trim();
  } catch {
    return { error: `${base} and ${headName} share no history.` };
  }
  const headSide = head === null ? null : headCommit;
  const files = changedSpecFiles(root, mergeBase, headSide);
  const baseFiles = new Map(
    files.map((file) => [file, readAt(root, mergeBase, file)]),
  );
  const headFiles = new Map(
    files.map((file) => [file, readAt(root, headSide, file)]),
  );
  const changes = branchListChanges(root, mergeBase, headSide);
  const listFiles = changes.map((change) => change.path);
  const wordingChanges = changes.flatMap((change) =>
    parseWordingChanges(branchListText(root, mergeBase, headSide, change)),
  );
  return {
    files,
    listFiles,
    result: compareSpecFiles(baseFiles, headFiles, wordingChanges),
  };
}

/**
 * The branch the list file is named for: the pull request's head branch on
 * the runner, otherwise `head` when it names a local branch or is `HEAD` on
 * one (null, the working tree, is taken as `HEAD`), otherwise null.
 */
export function currentBranch(root, head, env) {
  if (head === null) head = "HEAD";
  if (head === "HEAD" && env.GITHUB_HEAD_REF) return env.GITHUB_HEAD_REF;
  try {
    if (head === "HEAD") {
      return git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
    }
    git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${head}`]);
    return head;
  } catch {
    return null;
  }
}

/**
 * The base revision when none is given: on the runner, the pull request's
 * base branch.
 */
export function defaultBase(env) {
  return env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : DEFAULT_BASE;
}

/** The top level of the repository holding the working directory. */
function repositoryRoot() {
  return git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
}

const PREFIX = "spec sentence comparison:";

function main(argv, env) {
  let options;
  try {
    ({ values: options } = parseArgs({
      args: argv,
      options: {
        base: { type: "string" },
        head: { type: "string" },
      },
    }));
  } catch (error) {
    console.error(`${PREFIX} ${error.message}`);
    console.error(
      "usage: node scripts/check-spec-sentence-moves.mjs [--base <ref>] [--head <ref>]  (without --head, the working tree)",
    );
    return 2;
  }

  if (
    options.base === undefined &&
    env.GITHUB_BASE_REF &&
    env.GITHUB_BASE_REF !== STAGING_BRANCH
  ) {
    console.log(
      `${PREFIX} skipped on a pull request into ${env.GITHUB_BASE_REF}, because the per-pull-request lists were checked as each pull request entered ${STAGING_BRANCH}.`,
    );
    return 0;
  }

  const root = repositoryRoot();
  const base = options.base ?? defaultBase(env);
  if (options.base === undefined && resolveCommit(root, base) === null) {
    console.log(
      `${PREFIX} skipped, ${base} does not resolve in this checkout. Fetch it, or pass --base <ref>.`,
    );
    return 0;
  }

  const head = options.head ?? null;
  const headLabel = head ?? "the working tree";
  const comparison = compareRevisions(root, base, head);
  if (comparison.error) {
    console.error(`${PREFIX} ${comparison.error}`);
    return 2;
  }
  const { files, listFiles, result } = comparison;
  if (files.length === 0 && result.unmatched.length === 0) {
    console.log(
      `${PREFIX} no Markdown file under ${SPEC_DIRECTORY} changed since the merge base with ${base}.`,
    );
    return 0;
  }
  const listFile = listFileFor(currentBranch(root, head, env));
  const failures = formatFailures(result, { listFile, readFrom: listFiles });
  if (failures.length === 0) {
    console.log(
      `${PREFIX} passed over ${files.length} changed file${files.length === 1 ? "" : "s"} under ${SPEC_DIRECTORY}.`,
    );
    return 0;
  }
  const compared =
    files.length === 0
      ? `no Markdown file under ${SPEC_DIRECTORY} changed between the merge base with ${base} and ${headLabel}.`
      : `the units of ${files.join(", ")} differ between the merge base with ${base} and ${headLabel}.`;
  const read =
    listFiles.length > 0
      ? `Wording changes were read from ${listFiles.join(", ")} ${head === null ? "in" : "at"} ${headLabel}.`
      : `No file under ${WORDING_CHANGES_DIRECTORY} was added or modified since the merge base, so this branch lists no change; write its list to ${listFile}.`;
  console.error(`${PREFIX} ${compared} ${read}\n`);
  for (const line of failures) console.error(line);
  return 1;
}

// Only runs when invoked directly, so the test can import the pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.env));
}
