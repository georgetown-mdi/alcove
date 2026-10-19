#!/usr/bin/env node
//
// Search every place a standing owner ruling can live, so a session runs one
// command before it files or presents a decision. A question a ruling already
// answers is not filed and not docketed: the ruling is cited instead.
//
// Usage:
//   node find-rulings.mjs <word> [word ...]
//
// A hit holds every given word, case-insensitively, each starting at a word
// start: `identifier` matches `identifiers`, and `sent` does not match
// `consent`. Pass the decision's 2-3 most specific subject words. Sections, in
// order:
//
//   - Board items: every item on boards 9 and 10, Done included, whose title or
//     body holds every word, printed as `board/itemId [status] title`, then each
//     body line holding a ruling marker ("ruling", "ruled", "decided",
//     "settled", "ratified", "not to be re-raised", or "owner" followed on the
//     line by a date or a quotation mark), trimmed to about 240 characters.
//     Items whose title holds the words come first, then items whose ruling
//     lines do.
//   - Cited rulings: items those ruling lines name by id that hold ruling lines
//     of their own, so an earlier ruling worded differently is still found.
//   - Documented behavior: lines in docs/ and docs/spec/ at origin/staging that
//     hold every word. A default or behavior the user docs state was ratified
//     in PR review, so it is a ruling, not an open question.
//   - Design records and agent rules: the same over docs/notes/,
//     CONTRIBUTING.md, CLAUDE.md, and the markdown under .claude/.
//   - Commits: the 10 most recent origin/staging commits whose message holds
//     every word.
//   - scratch/ session records (gitignored, host-local), when the directory
//     exists: the paths of the markdown files holding every word.
//
// origin/staging is fetched first; when the fetch fails the local ref is
// searched and a note says so. Exits 0 whether or not anything matched, and 1
// when a source could not be searched, so a partial search is not mistaken for
// an empty one.
//
// Worked example, the question of whether an inferred identifier column is sent
// by default, which the owner had already ruled twice:
//
//   node .claude/scripts/find-rulings.mjs identifier sent
//
// lists the Done item "Send non-key and identifier columns by default in direct
// mode" among the first board items, with its Ruling lines (owner,
// 2026-10-13); the Done item "Disclose what a zero-setup run transmits before it
// runs" under the cited rulings, with its 2026-09-12 ruling "Not to be
// re-raised as a default change" (its body says "transmit", not "sent");
// docs/CLI.md and docs/EXCHANGE_REFERENCE.md among the documented behavior; and
// docs/notes/payload-as-agreed-terms.md among the design records.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllItems } from "./lib/projectItems.mjs";

const USAGE =
  "Usage: node find-rulings.mjs <word> [word ...]\n" +
  "       (searches both boards in every status, docs, rules, the staging log, and scratch/)\n";

const BOARDS = [9, 10];
const STAGING_REF = "origin/staging";
const LINE_LIMIT = 240;
const COMMIT_LIMIT = 10;

const RULING_MARKERS = [
  /\brul(?:ing|ings|ed)\b/i,
  /\bdecided\b/i,
  /\bsettled\b/i,
  /\bratified\b/i,
  /not to be re-?raised/i,
  /\bowner\b.*?(?:\d{4}-\d{2}-\d{2}|["\u201c])/i,
];

/**
 * A case-insensitive pattern for `word` starting at a word start, so a suffix
 * still matches (`identifier` in `identifiers`) while a word ending in it does
 * not (`sent` in `consent`).
 */
function wordStartPattern(word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}`, "iu");
}

/**
 * Whether `text` holds every word in `words`, case-insensitively, each starting
 * at a word start. An empty word list matches nothing.
 */
export function holdsAllWords(text, words) {
  if (words.length === 0 || typeof text !== "string") return false;
  return words.every((word) => wordStartPattern(word).test(text));
}

/**
 * The numeric board item ids (8 digits or more, so a PR number is not one)
 * named in `lines`, as a set of numbers.
 */
export function citedItemIds(lines) {
  const ids = new Set();
  for (const line of lines) {
    for (const match of line.matchAll(/(?<!\d)\d{8,10}(?!\d)/g)) {
      ids.add(Number(match[0]));
    }
  }
  return ids;
}

/**
 * The index of the first ruling marker in `line`, or -1 when it holds none.
 */
export function rulingMarkerIndex(line) {
  let first = -1;
  for (const marker of RULING_MARKERS) {
    const match = marker.exec(line);
    if (match && (first === -1 || match.index < first)) first = match.index;
  }
  return first;
}

/**
 * A window of at most `limit` characters of `line`, trimmed, starting a little
 * before `index` so a match deep in a long soft-wrapped paragraph stays visible.
 */
export function excerpt(line, index = 0, limit = LINE_LIMIT) {
  const text = line.trim();
  if (text.length <= limit) return text;
  const offset = Math.max(0, index - (line.length - line.trimStart().length));
  const start = Math.max(0, Math.min(offset - 60, text.length - limit));
  const head = start > 0 ? "..." : "";
  const tail = start + limit < text.length ? "..." : "";
  return head + text.slice(start, start + limit) + tail;
}

const SECTION_LINE_LIMIT = 8;
const HEADING = /^\s*#{1,6}\s/;

/**
 * The body lines holding a ruling marker, each as an excerpt around it. A
 * marker heading also brings the first lines of its section, and a marker line
 * ending in a colon the line after it, since a hard-wrapped body puts the
 * ruling's own words there.
 */
export function rulingLines(body) {
  if (typeof body !== "string") return [];
  const lines = body.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const index = rulingMarkerIndex(line);
    i += 1;
    if (index === -1) continue;
    out.push(excerpt(line, index));
    if (HEADING.test(line)) {
      let taken = 0;
      while (
        i < lines.length &&
        !HEADING.test(lines[i]) &&
        taken < SECTION_LINE_LIMIT
      ) {
        if (lines[i].trim() !== "") {
          out.push(excerpt(lines[i]));
          taken += 1;
        }
        i += 1;
      }
    } else if (line.trimEnd().endsWith(":")) {
      while (i < lines.length && lines[i].trim() === "") i += 1;
      if (i < lines.length && !HEADING.test(lines[i])) {
        out.push(excerpt(lines[i]));
        i += 1;
      }
    }
  }
  return out;
}

/** The index of the first of `words` in `line`, for centering its excerpt. */
function firstWordIndex(line, words) {
  const indices = words
    .map((word) => line.search(wordStartPattern(word)))
    .filter((index) => index !== -1);
  return indices.length === 0 ? 0 : Math.min(...indices);
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Lines at origin/staging holding every word, as { path, line, text }. One git
 * grep with --all-match narrows to files holding every word; it prints lines
 * holding any of them, so each line is filtered again here.
 */
function grepStaging(words, root) {
  const args = ["grep", "-n", "-i", "-F", "--full-name", "--all-match"];
  for (const word of words) args.push("-e", word);
  args.push(
    STAGING_REF,
    "--",
    "docs",
    ":(exclude)docs/spec/wording-changes",
    "CONTRIBUTING.md",
    "CLAUDE.md",
    ":(glob).claude/**/*.md",
  );
  let output;
  try {
    output = git(args, root);
  } catch (err) {
    // git grep exits 1 when nothing matched.
    if (err.status === 1) return [];
    throw err;
  }
  const prefix = `${STAGING_REF}:`;
  const hits = [];
  for (const raw of output.split("\n")) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    const match = /^(.*?):(\d+):(.*)$/.exec(rest);
    if (!match) continue;
    const [, path, line, text] = match;
    if (holdsAllWords(text, words)) hits.push({ path, line, text });
  }
  return hits;
}

/**
 * The most recent origin/staging commits whose message holds every word, as
 * "sha subject". git log --grep matches anywhere in a word, so its result is
 * filtered again with the word-start match the other sources use.
 */
function stagingCommits(words, root) {
  const args = ["log", STAGING_REF, "--all-match", "-i", "-F"];
  for (const word of words) args.push(`--grep=${word}`);
  args.push("--format=%h %s%x00%B%x1e");
  return git(args, root)
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => holdsAllWords(record.replace("\0", "\n"), words))
    .slice(0, COMMIT_LIMIT)
    .map((record) => record.slice(0, record.indexOf("\0")));
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

/**
 * The scratch/ directories to search: this checkout's and the main checkout's,
 * since a linked worktree has no scratch/ of its own.
 */
function scratchDirs(root) {
  const commonDir = resolve(
    root,
    git(["rev-parse", "--git-common-dir"], root).trim(),
  );
  const candidates = [
    join(root, "scratch"),
    join(dirname(commonDir), "scratch"),
  ];
  return [...new Set(candidates)].filter(
    (dir) => existsSync(dir) && statSync(dir).isDirectory(),
  );
}

async function boardHits(words) {
  const results = await Promise.allSettled(
    BOARDS.map((board) => fetchAllItems(board, { withBody: true })),
  );
  const items = [];
  const failures = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      failures.push(
        `board ${BOARDS[i]}: ${result.reason?.message ?? result.reason}`,
      );
      return;
    }
    for (const item of result.value) {
      items.push({
        board: BOARDS[i],
        id: item.id,
        status: item.fields.Status ?? "-",
        title: item.title,
        body: item.body,
        lines: rulingLines(item.body),
      });
    }
  });
  const hits = items.filter((item) =>
    holdsAllWords(`${item.title ?? ""}\n${item.body ?? ""}`, words),
  );
  hits.sort((a, b) => hitRank(b, words) - hitRank(a, words));
  return { hits, cited: citedRulings(hits, items), failures };
}

/**
 * Sort weight for a board hit, highest first: a title holding every word, then
 * a ruling line holding one of them, then any ruling line at all.
 */
export function hitRank(hit, words) {
  const titleWords = words.filter((word) => holdsAllWords(hit.title, [word]));
  const lineHoldsWord = hit.lines.some((line) =>
    words.some((word) => holdsAllWords(line, [word])),
  );
  return (
    (titleWords.length === words.length ? 8 : titleWords.length > 0 ? 4 : 0) +
    (lineHoldsWord ? 2 : 0) +
    (hit.lines.length > 0 ? 1 : 0)
  );
}

/**
 * Items a hit's ruling lines name that are not hits themselves and hold ruling
 * lines of their own: an earlier ruling worded without the search words is
 * found through the later one that cites it. One level deep.
 */
export function citedRulings(hits, items) {
  const hitIds = new Set(hits.map((hit) => hit.id));
  const byId = new Map(items.map((item) => [item.id, item]));
  const cited = new Map();
  for (const hit of hits) {
    for (const id of citedItemIds(hit.lines)) {
      const item = byId.get(id);
      if (!item || hitIds.has(id) || item.lines.length === 0) continue;
      const entry = cited.get(id) ?? { ...item, citedBy: [] };
      entry.citedBy.push(`${hit.board}/${hit.id}`);
      cited.set(id, entry);
    }
  }
  return [...cited.values()];
}

function heading(text) {
  process.stdout.write(`\n== ${text} ==\n`);
}

async function main() {
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  const words = process.argv.slice(2).filter((word) => word.trim() !== "");
  if (words.length === 0) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  let incomplete = false;

  const boards = boardHits(words);
  try {
    git(["fetch", "--quiet", "origin", "staging"], root);
  } catch {
    process.stdout.write(
      `note: could not fetch ${STAGING_REF}; searching the local ref\n`,
    );
  }

  const { hits, cited, failures } = await boards;
  const printItem = (item, suffix = "") => {
    process.stdout.write(
      `${item.board}/${item.id} [${item.status}] ${item.title}${suffix}\n`,
    );
    for (const line of item.lines) process.stdout.write(`    ${line}\n`);
  };
  heading(
    `Board items holding every word (boards ${BOARDS.join(", ")}, every status)`,
  );
  for (const failure of failures) {
    process.stdout.write(`could not search ${failure}\n`);
    incomplete = true;
  }
  if (hits.length === 0 && failures.length === 0)
    process.stdout.write("none\n");
  for (const hit of hits) printItem(hit);
  if (cited.length > 0) {
    heading("Rulings those items' ruling lines cite");
    for (const item of cited) {
      printItem(item, ` (cited by ${item.citedBy.join(", ")})`);
    }
  }

  let repoHits = [];
  try {
    repoHits = grepStaging(words, root);
  } catch (err) {
    process.stdout.write(`could not search ${STAGING_REF}: ${err.message}\n`);
    incomplete = true;
  }
  const isRecord = (hit) =>
    !hit.path.startsWith("docs/") || hit.path.startsWith("docs/notes/");
  const printRepo = (list) => {
    if (list.length === 0) process.stdout.write("none\n");
    for (const hit of list) {
      process.stdout.write(
        `${hit.path}:${hit.line}: ${excerpt(hit.text, firstWordIndex(hit.text, words))}\n`,
      );
    }
  };
  heading(
    `Documented behavior in docs/ and docs/spec/ at ${STAGING_REF}: ratified rulings (PR review ratified them)`,
  );
  printRepo(repoHits.filter((hit) => !isRecord(hit)));
  heading(
    "Design records and agent rules (docs/notes/, CONTRIBUTING.md, CLAUDE.md, .claude/)",
  );
  printRepo(repoHits.filter(isRecord));

  heading(`Commits on ${STAGING_REF} (${COMMIT_LIMIT} most recent)`);
  try {
    const commits = stagingCommits(words, root);
    process.stdout.write(
      commits.length === 0 ? "none\n" : `${commits.join("\n")}\n`,
    );
  } catch (err) {
    process.stdout.write(`could not search the log: ${err.message}\n`);
    incomplete = true;
  }

  const dirs = scratchDirs(root);
  if (dirs.length > 0) {
    heading("scratch/ session records (paths only)");
    const paths = dirs
      .flatMap((dir) => markdownFiles(dir))
      .filter((path) => holdsAllWords(readFileSync(path, "utf8"), words))
      .map((path) => relative(process.cwd(), path) || path);
    process.stdout.write(
      paths.length === 0 ? "none\n" : `${paths.join("\n")}\n`,
    );
  }

  process.exit(incomplete ? 1 : 0);
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message ?? err}\n`);
    process.exit(1);
  });
}
