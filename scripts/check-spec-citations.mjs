#!/usr/bin/env node
// Spec citation check, run by static_checks.yaml through check:all.
//
// Source, tests and scripts cite a section of a docs/spec/ file by name, and
// a heading renamed or moved leaves those citations naming a section that no
// longer exists. linkcheck resolves Markdown links only; this check resolves
// the citations in every other tracked text file against the cited spec file.
//
// THE FORMS it reads, after a reference to a spec file -- `docs/spec/<name>.md`
// with any leading path, or a bare `<name>.md` naming a file in docs/spec/ (bare
// README.md excluded), each optionally in backticks:
//
//   anchored        <name>.md#some-slug
//   quoted heading  <name>.md, "Heading text"   <name>.md "Heading text"
//                   <name>.md ("Heading text")  <name>.md's "Heading text"
//   heading prefix  <name>.md, Heading text ...  <name>.md (Heading text ...)
//
// The heading-prefix form needs text that opens with a capital letter, a digit
// or a backtick. A citation wrapped onto the next line or two is joined first:
// a comment leader (`//`, `*`, `#`, `--`, `;`) is dropped from the continuation
// line, a line ending in a word and a hyphen joins without a space, and a
// string literal closed at the line end joins the one the next line opens.
//
// RESOLVING. An anchor resolves when a heading of the file takes that slug
// (slugify and headingAnchors in check-doc-links.mjs). Quoted and prefix text
// is compared by slug against the file's citable names: each heading's whole
// text and its part before the first " -- ", " - " or ": " (headingNames in
// check-rule-citations.mjs), and each bold paragraph label -- a `**...**` span
// opening a line or list item, or one ending in a period or colon. Quoted
// text resolves when it equals a name; when it is two or more words that
// open a name, the section's leading words; or when a label opens it, since
// a label leads its paragraph and the quote may run on into the sentence.
// Prefix text resolves when a name opens it, or when its words up to the
// first punctuation, two or more of them, open a name. Every comparison is
// made at a word boundary.
// A reference to a file that does not exist fails whatever form follows: a
// `docs/spec/` path naming no file, or a bare capitalized `<name>.md` naming no
// tracked Markdown file anywhere.
//
// NOT RESOLVED, and passed without a check:
//   - text after the comma or parenthesis that opens with a lowercase letter
//     ("<name>.md, the `expires` row"), which is how prose names a table row;
//   - a section named before the file ("the Budgets section of <name>.md");
//   - every quoted heading after the first in a list ("<name>.md, "A" and "B"");
//   - a citation that resolves to the right file's wrong section.
// A spec file mentioned with none of the forms above is prose and is not read.
//
// Where it reads: every tracked or untracked-but-not-ignored file that is not
// Markdown and holds no NUL byte, apart from FIXTURE_FILES below.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { headingAnchors, slugify } from "./check-doc-links.mjs";
import { headingNames } from "./check-rule-citations.mjs";
import { stripFences } from "./lib/markdownFences.mjs";

export const SPEC_DIRECTORY = "docs/spec/";

/** Files whose spec citations are test fixtures, dead on purpose. */
export const FIXTURE_FILES = new Map([
  [
    ".claude/scripts/check-review-ledger-dispositions.test.mjs",
    "Its ledger fixtures cite anchors in a spec file that does not exist.",
  ],
]);

const REFERENCE = /(?<![\w./-])((?:[\w.-]+\/)*)([\w-]+\.md)\\?`?/g;
const BARE_CAPITALIZED = /^[A-Z][A-Z0-9_]*\.md$/;

const ANCHORED = /^#([\w-]+)/;
const QUOTED = /^(?:,\s*|\s+\(?|'s\s+)"([^"]+)"/;
const PREFIX = /^(?:,\s+|\s+\()([A-Z0-9`].*)$/;
const PREFIX_LEAD_END = /[,.;:()"]| -- /;

const COMMENT_LEADER = /^\s*(?:\/\/+|\/?\*+\/?|#+|--|;+)?\s*/;
const STRING_CLOSE = /(["'`])\s*[,+]?\s*$/;
const CONTINUATION_LINES = 2;

const HEADING_LINE = /^ {0,3}#{1,6}\s/;
const LEADING_LABEL = /^\s*(?:[-*+]\s+|\d+\.\s+)?\*\*([^*]+?)\*\*/;
const PUNCTUATED_LABEL = /\*\*([^*]+?)[.:]\*\*/g;

/** The bold paragraph labels of a spec file's Markdown `source`, as slugs. */
export function paragraphLabels(source, file = "<source>") {
  const labels = new Set();
  for (const line of stripFences(source, file).split("\n")) {
    if (HEADING_LINE.test(line)) continue;
    const leading = LEADING_LABEL.exec(line);
    if (leading) labels.add(slugify(leading[1].replace(/[.:]$/, "")));
    for (const match of line.matchAll(PUNCTUATED_LABEL)) {
      labels.add(slugify(match[1]));
    }
  }
  labels.delete("");
  return labels;
}

/**
 * The citable names of a spec file's Markdown `source`: its heading names and
 * its bold paragraph labels, as slugs.
 */
export function citableNames(source, file = "<source>") {
  const names = new Set(paragraphLabels(source, file));
  for (const name of headingNames(source, file)) names.add(slugify(name));
  names.delete("");
  return names;
}

/** Whether slug `text` equals slug `name` or opens with it at a word boundary. */
function slugOpensWith(text, name) {
  return text === name || text.startsWith(`${name}-`);
}

/**
 * The text of `lines[index]` from `start`, with the continuation lines after
 * it joined on, as a wrapped citation is read.
 */
export function joinedText(lines, index, start) {
  let text = lines[index].slice(start);
  for (let offset = 1; offset <= CONTINUATION_LINES; offset += 1) {
    const next = lines[index + offset];
    if (next === undefined) break;
    const close = STRING_CLOSE.exec(text);
    const reopen = close && new RegExp(`^\\s*\\+?\\s*\\${close[1]}`).exec(next);
    if (reopen) {
      text = text.slice(0, close.index);
      text += ` ${next.slice(reopen[0].length).replace(COMMENT_LEADER, "")}`;
      continue;
    }
    const continuation = next.replace(COMMENT_LEADER, "");
    text = /\w-$/.test(text.trimEnd())
      ? text.trimEnd() + continuation
      : `${text} ${continuation}`;
  }
  return text.replace(/\\(["'`])/g, "$1").replace(/\s+/g, " ");
}

/**
 * The spec file a reference names, or null when it names none. `directory`
 * is the path before the file name; `isTrackedName` says whether a bare
 * name is some tracked Markdown file's.
 */
export function citedSpecFile(directory, name, specNames, isTrackedName) {
  if (directory.endsWith(SPEC_DIRECTORY)) return `${SPEC_DIRECTORY}${name}`;
  if (directory !== "" || name === "README.md") return null;
  if (specNames.has(name)) return `${SPEC_DIRECTORY}${name}`;
  if (BARE_CAPITALIZED.test(name) && !isTrackedName(name)) {
    return `${SPEC_DIRECTORY}${name}`;
  }
  return null;
}

/**
 * Every citation in `source`, as `{line, target, form, text}`: `line` is
 * 1-based, `form` one of "anchored", "quoted" and "prefix", and `text` the
 * anchor, the quoted text, or the text after the separator.
 */
export function citations(source, specNames, isTrackedName = () => true) {
  const lines = source.split("\n");
  const found = [];
  lines.forEach((line, index) => {
    if (!line.includes(".md")) return;
    for (const match of line.matchAll(REFERENCE)) {
      const target = citedSpecFile(
        match[1],
        match[2],
        specNames,
        isTrackedName,
      );
      if (target === null) continue;
      const after = joinedText(lines, index, match.index + match[0].length);
      const anchored = ANCHORED.exec(after);
      const quoted = QUOTED.exec(after);
      const prefix = PREFIX.exec(after);
      const [form, text] = anchored
        ? ["anchored", anchored[1]]
        : quoted
          ? ["quoted", quoted[1]]
          : prefix
            ? ["prefix", prefix[1]]
            : [null, null];
      if (form !== null) found.push({ line: index + 1, target, form, text });
    }
  });
  return found;
}

/** Prefix text up to its first punctuation, the part a reader cites. */
const prefixLead = (text) => text.split(PREFIX_LEAD_END)[0].trim();

/** Whether a citation of `form` and `text` resolves against `spec`. */
export function resolves(form, text, spec) {
  if (form === "anchored") return spec.anchors.has(text.toLowerCase());
  const slug = slugify(text);
  if (form === "quoted") {
    if (spec.names.has(slug)) return true;
    if (
      text.trim().split(/\s+/).length >= 2 &&
      [...spec.names].some((name) => slugOpensWith(name, slug))
    ) {
      return true;
    }
    return [...spec.labels].some((label) => slugOpensWith(slug, label));
  }
  if ([...spec.names].some((name) => slugOpensWith(slug, name))) return true;
  const lead = prefixLead(text);
  if (lead.split(/\s+/).length < 2) return false;
  const leadSlug = slugify(lead);
  return [...spec.names].some((name) => slugOpensWith(name, leadSlug));
}

const shorten = (text) => (text.length > 60 ? `${text.slice(0, 60)}...` : text);

/**
 * The citations in `citing` (an array of `{file, source}`) that do not
 * resolve, as problem strings, and the count that do. `readSpec(path)` returns
 * a spec file's source, or null when the file does not exist.
 */
export function citationProblems(
  citing,
  readSpec,
  specNames,
  isTrackedName = () => true,
) {
  const problems = [];
  const specs = new Map();
  let resolved = 0;
  for (const { file, source } of citing) {
    for (const citation of citations(source, specNames, isTrackedName)) {
      const { line, target, form, text } = citation;
      if (!specs.has(target)) {
        const specSource = readSpec(target);
        specs.set(
          target,
          specSource === null
            ? null
            : {
                anchors: headingAnchors(specSource, target),
                names: citableNames(specSource, target),
                labels: paragraphLabels(specSource, target),
              },
        );
      }
      const spec = specs.get(target);
      if (spec === null) {
        problems.push(
          `${file}:${line}: cites ${target}, which does not exist. Point the citation at the spec file that holds the section.`,
        );
      } else if (resolves(form, text, spec)) {
        resolved += 1;
      } else if (form === "anchored") {
        problems.push(
          `${file}:${line}: cites ${target}#${text}, but no heading in ${target} takes that anchor. Use the anchor of the heading that holds the section, or point the citation at the file it moved to.`,
        );
      } else {
        problems.push(
          `${file}:${line}: cites ${target}, "${shorten(form === "prefix" ? prefixLead(text) : text)}", but no heading or bold paragraph label in ${target} opens or matches that text. Name the section as it is written there, or point the citation at the file it moved to.`,
        );
      }
    }
  }
  return { problems, resolved };
}

/** The tracked and untracked-but-not-ignored files under `root`. */
function repositoryFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
}

/** Runs the check over the repository at `root`; returns the exit code. */
export function main(root) {
  const files = repositoryFiles(root).filter((file) =>
    existsSync(resolve(root, file)),
  );
  const specNames = new Set(
    readdirSync(resolve(root, SPEC_DIRECTORY)).filter((name) =>
      name.endsWith(".md"),
    ),
  );
  const trackedNames = new Set(
    files
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(file.lastIndexOf("/") + 1)),
  );
  const citing = [];
  for (const file of files) {
    if (file.endsWith(".md") || FIXTURE_FILES.has(file)) continue;
    const source = readFileSync(resolve(root, file), "utf8");
    if (!source.includes("\0")) citing.push({ file, source });
  }
  const readSpec = (path) => {
    const absolute = resolve(root, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  };
  const { problems, resolved } = citationProblems(
    citing,
    readSpec,
    specNames,
    (name) => trackedNames.has(name),
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(
      `\n${problems.length} spec citation(s) name a section that does not exist.`,
    );
    return 1;
  }
  if (resolved === 0) {
    console.error(
      "No docs/spec/ citation was found. If the citation forms changed, update the patterns in scripts/check-spec-citations.mjs to read them.",
    );
    return 1;
  }
  console.log(
    `Spec citation check passed: ${resolved} citations across ${citing.length} files resolve to a section.`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n")
      .slice(1);
    const header = lines.slice(
      0,
      lines.findIndex((line) => line === ""),
    );
    console.log(header.map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
  } else {
    process.exit(main(resolve(dirname(fileURLToPath(import.meta.url)), "..")));
  }
}
