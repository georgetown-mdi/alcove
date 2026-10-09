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
// blockquote markers, the table alignment row, thematic breaks, and any file
// outside docs/spec/ or not ending in .md.
//
// The pull request body lists each unit added, dropped or reworded, one list
// item per change, each side the unit's text as above and `-` standing for
// none; a line naming both sides pairs two units of one kind:
//
//   ## Wording changes
//
//   - The sentence as it was. -> The sentence as it is.
//   - - -> A sentence the pull request adds.
//   - A sentence the pull request drops. -> -

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The directory whose Markdown files are compared. */
export const SPEC_DIRECTORY = "docs/spec/";

/** The base revision when none is given. */
export const DEFAULT_BASE = "origin/staging";

/** The pull request body heading the wording changes are listed under. */
export const WORDING_CHANGES_HEADING = "Wording changes";

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
 * The lines listed under the pull request body's `## Wording changes` heading,
 * up to the next `#` or `##` heading, each the text of one list item with its
 * marker dropped. HTML comments and fenced blocks are skipped.
 */
export function parseWordingChanges(body) {
  const lines = body
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n");
  const heading = `## ${WORDING_CHANGES_HEADING.toLowerCase()}`;
  const entries = [];
  let inSection = false;
  let fence = null;
  for (const line of lines) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opening = FENCE.exec(line.replace(BLOCKQUOTE_MARKER, ""));
    if (opening) {
      fence = opening[1];
      continue;
    }
    if (!inSection) {
      inSection = normalizeWhitespace(line).toLowerCase() === heading;
      continue;
    }
    if (/^\s{0,3}#{1,2}\s/.test(line)) break;
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) entries.push(normalizeWhitespace(item[1]));
  }
  return entries;
}

function countUnits(files) {
  const counts = new Map();
  for (const [file, markdown] of files) {
    for (const unit of specUnits(markdown)) {
      const key = `${unit.kind}\u0000${unit.text}`;
      const entry = counts.get(key) ?? { ...unit, count: 0, files: new Set() };
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
  return pool.find(
    (entry) => entry.count > 0 && entry.kind === kind && entry.text === text,
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

const PASTE_INSTRUCTION =
  "joining a dropped and an added line of one kind into one where the change rewords a unit:";

/**
 * The `## Wording changes` section listing a comparison's unlisted
 * differences, ready to paste into a pull request body. Empty when there are
 * none.
 */
export function formatWordingChanges(result) {
  if (result.dropped.length === 0 && result.added.length === 0) return [];
  return [
    `## ${WORDING_CHANGES_HEADING}`,
    "",
    ...result.dropped.map(
      (entry) => `- ${entry.text}${CHANGE_SEPARATOR}${NO_UNIT}`,
    ),
    ...result.added.map(
      (entry) => `- ${NO_UNIT}${CHANGE_SEPARATOR}${entry.text}`,
    ),
  ];
}

/**
 * Formats a comparison's failures, each unlisted difference named with its
 * files and followed by the section that would list it. Empty when it passes.
 */
export function formatFailures(result) {
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
      `To accept these, add this to the pull request body, ${PASTE_INSTRUCTION}`,
      "",
      ...formatWordingChanges(result),
    );
  }
  if (result.unmatched.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `Listed under "## ${WORDING_CHANGES_HEADING}" but matching no difference; correct or remove each:`,
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

/** The Markdown files under docs/spec/ that differ between two commits. */
export function changedSpecFiles(root, from, to) {
  return git(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    from,
    to,
    "--",
    SPEC_DIRECTORY,
  ])
    .split("\0")
    .filter((file) => file.endsWith(".md"));
}

function readAt(root, commit, file) {
  const listed = git(root, ["ls-tree", "--name-only", commit, "--", file]);
  if (listed.trim() === "") return "";
  return git(root, ["show", `${commit}:${file}`]);
}

/**
 * Runs the comparison between the merge base of `base` and `head`, and `head`.
 * Returns `{ files, result }`, or `{ error }` when a revision does not resolve.
 */
export function compareRevisions(root, base, head, wordingChanges) {
  const baseCommit = resolveCommit(root, base);
  if (baseCommit === null) return { error: `${base} does not resolve.` };
  const headCommit = resolveCommit(root, head);
  if (headCommit === null) return { error: `${head} does not resolve.` };
  let mergeBase;
  try {
    mergeBase = git(root, ["merge-base", baseCommit, headCommit]).trim();
  } catch {
    return { error: `${base} and ${head} share no history.` };
  }
  const files = changedSpecFiles(root, mergeBase, headCommit);
  const baseFiles = new Map(
    files.map((file) => [file, readAt(root, mergeBase, file)]),
  );
  const headFiles = new Map(
    files.map((file) => [file, readAt(root, headCommit, file)]),
  );
  return {
    files,
    result: compareSpecFiles(baseFiles, headFiles, wordingChanges),
  };
}

/**
 * The pull request body and where it came from, or `{ body: null }` when none
 * is given. Throws when a named source cannot be read.
 */
export function readBody(bodyFile, env) {
  if (bodyFile !== undefined) {
    return { body: readFileSync(bodyFile, "utf8"), source: bodyFile };
  }
  if (env.PR_JSON) {
    const pullRequest = JSON.parse(readFileSync(env.PR_JSON, "utf8"));
    return { body: pullRequest.body ?? "", source: "the pull request" };
  }
  if (env.PR_BODY !== undefined)
    return { body: env.PR_BODY, source: "PR_BODY" };
  return { body: null, source: null };
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
        head: { type: "string", default: "HEAD" },
        "body-file": { type: "string" },
      },
    }));
  } catch (error) {
    console.error(`${PREFIX} ${error.message}`);
    console.error(
      "usage: node scripts/check-spec-sentence-moves.mjs [--base <ref>] [--head <ref>] [--body-file <path>]",
    );
    return 2;
  }

  let body;
  let source;
  try {
    ({ body, source } = readBody(options["body-file"], env));
  } catch (error) {
    console.error(
      `${PREFIX} the pull request body could not be read: ${error.message}`,
    );
    return 2;
  }
  if (body === null && env.GITHUB_ACTIONS === "true") {
    console.log(
      `${PREFIX} skipped, no pull request body on this run; the PR Checklist workflow runs this check with the body.`,
    );
    return 0;
  }

  const root = repositoryRoot();
  const base = options.base ?? DEFAULT_BASE;
  if (options.base === undefined && resolveCommit(root, base) === null) {
    console.log(
      `${PREFIX} skipped, ${base} does not resolve in this checkout. Fetch it, or pass --base <ref>.`,
    );
    return 0;
  }

  const wordingChanges = body === null ? [] : parseWordingChanges(body);
  const comparison = compareRevisions(root, base, options.head, wordingChanges);
  if (comparison.error) {
    console.error(`${PREFIX} ${comparison.error}`);
    return 2;
  }
  const { files, result } = comparison;
  if (files.length === 0 && result.unmatched.length === 0) {
    console.log(
      `${PREFIX} no Markdown file under ${SPEC_DIRECTORY} changed since the merge base with ${base}.`,
    );
    return 0;
  }
  const failures = formatFailures(result);
  if (body === null && failures.length > 0) {
    console.log(
      `${PREFIX} the units of ${files.join(", ")} differ between the merge base with ${base} and ${options.head}. No pull request body was given (--body-file, PR_JSON or PR_BODY); list these in the pull request body, ${PASTE_INSTRUCTION}\n`,
    );
    for (const line of formatWordingChanges(result)) console.log(line);
    console.log(
      "\nThe PR Checklist workflow fails a pull request whose body does not list these.",
    );
    return 0;
  }
  if (failures.length === 0) {
    console.log(
      `${PREFIX} passed over ${files.length} changed file${files.length === 1 ? "" : "s"} under ${SPEC_DIRECTORY}.`,
    );
    return 0;
  }
  console.error(
    `${PREFIX} the units of ${files.join(", ")} differ between the merge base with ${base} and ${options.head}. Wording changes were read from ${source}.\n`,
  );
  for (const line of failures) console.error(line);
  return 1;
}

// Only runs when invoked directly, so the test can import the pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.env));
}
