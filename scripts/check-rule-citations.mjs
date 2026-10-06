#!/usr/bin/env node
// Rule citation check, run by static_checks.yaml through check:all.
//
// Agent rules point at each other as `<file>, <section>`, and a rule that moves
// leaves every pointer to its old section naming a heading that no longer
// exists. This check resolves each such citation against the headings of the
// file it names and fails on one that names no heading there.
//
// THE CITATION SYNTAX it reads, and nothing wider:
//
//   `<path>.md`, <Section>
//
// a backtick-quoted path (a backslash before either backtick, as a JavaScript
// template literal spells it, is allowed), then a comma and one space or a line
// break, then section text beginning with a capital letter or a digit. The path is
// repository-relative and names an instruction file: CLAUDE.md,
// CONTRIBUTING.md, or a Markdown file under .claude/ or docs/. A path
// written without backticks, a link, or a backticked path followed by anything
// else is prose that mentions a file, and is not read.
//
// A citation resolves when one of the file's headings is a prefix of the section
// text, ending at a word boundary. A heading's name is its whole text and, for a
// heading such as "Step 5 -- Recommend the review tier" or "The width bound: a
// per-key cap", the part before the first " -- ", " - " or ": ". So
// "`CONTRIBUTING.md`, Code Conventions, Plain language" resolves on the "Code
// Conventions" heading; the text after it is not checked. Section text wrapped
// onto the next line is joined to it first, so a citation may wrap.
//
// Where it reads: CLAUDE.md, CONTRIBUTING.md, and every Markdown and .mjs file
// under .claude/ apart from tests, which hold broken citations on purpose.
// Fenced code blocks in Markdown are skipped.
//
// What it cannot see: a citation in another form ("CLAUDE.md's X rule"), and a
// citation that resolves to the right file's wrong heading.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stripFences } from "./lib/markdownFences.mjs";

const CITATION =
  /\\?`((?:CLAUDE|CONTRIBUTING)\.md|(?:\.claude|docs)\/[\w./-]+\.md)\\?`,(?: |$)/g;
const SECTION_START = /^[A-Z0-9]/;

// Section text that opens with a path is a list of files, not a section.
const PATH_LIKE = /^[\w./-]+\.\w+\b/;

// The leaders a wrapped continuation line opens with: a comment's `//` or `*`,
// a concatenated string's opening quote.
const CONTINUATION_LEADER = /^\s*(?:\/\/|\*|["'`])?\s*/;

const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const SHORT_NAME_END = / -- | - |: /;

/** Whether `path` is a file whose rules other files cite by section. */
export function isInstructionFile(path) {
  return (
    path === "CLAUDE.md" ||
    path === "CONTRIBUTING.md" ||
    /^(?:\.claude|docs)\/.+\.md$/.test(path)
  );
}

/** Whether `path` is read for citations. */
export function isCitingFile(path) {
  if (path === "CLAUDE.md" || path === "CONTRIBUTING.md") return true;
  return /^\.claude\/.+\.(?:md|mjs)$/.test(path) && !/\.test\.mjs$/.test(path);
}

/**
 * The names a citation may give each heading of a Markdown `source`: the
 * heading's whole text, and the part before its first " -- ", " - " or ": ".
 */
export function headingNames(source, file = "<source>") {
  const names = new Set();
  for (const line of stripFences(source, file).split("\n")) {
    const match = HEADING.exec(line);
    if (!match) continue;
    const text = match[1];
    names.add(text);
    const end = text.search(SHORT_NAME_END);
    if (end > 0) names.add(text.slice(0, end));
  }
  return names;
}

/**
 * Every citation in a citing `source`, as `{line, target, section}`: `line` is
 * 1-based, `target` the cited path, and `section` the text after the comma with
 * the next line joined on.
 */
export function citations(source, file = "<source>") {
  const text = file.endsWith(".md") ? stripFences(source, file) : source;
  const lines = text.split("\n");
  const found = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(CITATION)) {
      const rest = line.slice(match.index + match[0].length);
      const next = (lines[index + 1] ?? "").replace(CONTINUATION_LEADER, "");
      const section = `${rest.trimEnd()} ${next}`.trim();
      if (!SECTION_START.test(section) || PATH_LIKE.test(section)) continue;
      found.push({ line: index + 1, target: match[1], section });
    }
  });
  return found;
}

/** Whether `section` opens with `name` and a word boundary after it. */
export function opensWith(section, name) {
  if (!section.startsWith(name)) return false;
  const after = section.charAt(name.length);
  return after === "" || !/[\w-]/.test(after);
}

/**
 * The citations in `citing` (an array of `{file, source}`) that do not resolve,
 * as problem strings, and the count that do. `readTarget(path)` returns a cited
 * file's source, or null when the file does not exist.
 */
export function citationProblems(citing, readTarget) {
  const problems = [];
  const namesByTarget = new Map();
  let resolved = 0;
  for (const { file, source } of citing) {
    for (const { line, target, section } of citations(source, file)) {
      if (!namesByTarget.has(target)) {
        const targetSource = readTarget(target);
        namesByTarget.set(
          target,
          targetSource === null ? null : headingNames(targetSource, target),
        );
      }
      const names = namesByTarget.get(target);
      const quoted =
        section.length > 60 ? `${section.slice(0, 60)}...` : section;
      if (names === null) {
        problems.push(
          `${file}:${line}: cites \`${target}\`, which does not exist. Point the citation at the file that holds the rule.`,
        );
        continue;
      }
      if ([...names].some((name) => opensWith(section, name))) {
        resolved += 1;
        continue;
      }
      problems.push(
        `${file}:${line}: cites \`${target}\`, "${quoted}", but no heading in ${target} opens that text. Name the heading that holds the rule, as it is written there, or point the citation at the file the rule moved to.`,
      );
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

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const citing = repositoryFiles(root)
    .filter(isCitingFile)
    .filter((file) => existsSync(resolve(root, file)))
    .map((file) => ({
      file,
      source: readFileSync(resolve(root, file), "utf8"),
    }));
  const readTarget = (path) => {
    const absolute = resolve(root, path);
    return isInstructionFile(path) && existsSync(absolute)
      ? readFileSync(absolute, "utf8")
      : null;
  };
  const { problems, resolved } = citationProblems(citing, readTarget);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(
      `\n${problems.length} rule citation(s) name a section that does not exist.`,
    );
    process.exit(1);
  }
  if (resolved === 0) {
    console.error(
      "No `<file>, <section>` citation was found in CLAUDE.md, CONTRIBUTING.md or .claude/. If the citation form changed, update CITATION in scripts/check-rule-citations.mjs to read it.",
    );
    process.exit(1);
  }
  console.log(
    `Rule citation check passed: ${resolved} citations across ${citing.length} files resolve to a heading.`,
  );
}
