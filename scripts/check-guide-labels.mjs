#!/usr/bin/env node
// Guide UI label check; scripts/run-checks.mjs lists it.
//
// WHAT IS HELD. Every bold span in a Markdown file under docs/guides/ names a
// label the reader finds on screen, so each one must match a string in the
// TypeScript sources of the web app, the console server, the CLI, or core
// (LABEL_SOURCE_DIRS). Every string literal and JSX text there counts: shown
// copy, aria labels, CLI help and prompts, and core's messages the apps show.
// A label matches when it is a run of whole words in one string, or when it
// fills a template literal, a `+` concatenation or a JSX element's children
// whole, each interpolated value standing for any text. Case and runs of
// whitespace are ignored, since the app may set a label in capitals by style.
//
// WHAT IS NOT A LABEL: a bold span ending in `.`, `:` or `,` (a lead-in), one
// holding inline code (a file or a value), and the entries of NOT_LABELS, each
// with why. An entry no guide uses fails, so the list cannot outlive the
// guides.
//
// WHAT IT DOES NOT COVER: a label written in plain text or in a heading, a
// string the app builds by a call rather than a literal, and whether the
// matched string is the one shown where the guide says. A label that matches
// any string passes, a log line or an internal key included, so this
// is a safety check against drift, not proof the label is on screen.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { stripCodeSpans, stripFences } from "./lib/markdownFences.mjs";
import {
  descendants,
  filesUnder,
  parseSource,
} from "./lib/typeScriptSources.mjs";
import { lineOf } from "./lib/text.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

/** The guides whose bold spans are held. */
export const GUIDES_DIR = "docs/guides";

/** The trees a label may come from, read for their TypeScript sources. */
export const LABEL_SOURCE_DIRS = [
  "apps/web/src",
  "apps/web/server",
  "apps/cli/src",
  "packages/core/src",
];

const LEAD_IN = "the lead-in of a list item";

/**
 * Bold spans in the guides that are not Alcove's UI labels, each with why. A
 * span is listed by its text as written between the `**` marks.
 */
export const NOT_LABELS = [
  { text: "The invitation, as a file", reason: LEAD_IN },
  { text: "When you both run", reason: LEAD_IN },
  { text: "Any other failure", reason: LEAD_IN },
  { text: "When you save the output to a file", reason: LEAD_IN },
  { text: "A run by hand succeeded", reason: LEAD_IN },
  { text: "This machine must be", reason: LEAD_IN },
  { text: "The scheduling account", reason: LEAD_IN },
  { text: "The shared secret does not expire between runs", reason: LEAD_IN },
  { text: "If the machine cannot be on at that hour", reason: LEAD_IN },
  { text: "Keep the interval longer than a run", reason: LEAD_IN },
  { text: "On Linux, skip a start while a run is going", reason: LEAD_IN },
  { text: "Set any outer timeout above the run's length", reason: LEAD_IN },
  { text: "An SFTP password or key file", reason: LEAD_IN },
  {
    text: "A list or only a count",
    reason: "a paragraph's lead-in naming a section of Agree on terms",
  },
  { text: "All files", reason: "a label in Notepad's save dialog" },
  { text: "Last Run Result", reason: "a column in Windows Task Scheduler" },
];

const ENTITIES = {
  amp: "&",
  apos: "'",
  quot: '"',
  nbsp: " ",
  lt: "<",
  gt: ">",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "...",
  mdash: "-",
  ndash: "-",
};

/** Text compared as a reader sees it: one space, ASCII quotes, any case. */
export function normalize(text) {
  return text
    .replace(/&(\w+);/g, (entity, name) => ENTITIES[name] ?? entity)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The bold spans of a guide's Markdown that name a UI label, as `{text, line}`
 * in source order. Fenced code is skipped; a span holding inline code, or
 * ending in `.`, `:` or `,`, is not a label.
 */
export function boldLabels(markdown, file) {
  const prose = stripFences(markdown, file);
  const code = stripCodeSpans(prose);
  const found = [];
  for (const match of code.matchAll(/\*\*(?=\S)([^*]*?\S)\*\*/g)) {
    const text = prose.slice(
      match.index + 2,
      match.index + 2 + match[1].length,
    );
    if (text.includes("`")) continue;
    if (/[.:,]$/.test(text)) continue;
    found.push({ text, line: lineOf(prose, match.index) });
  }
  return found;
}

const HOLE = null;

/** A string literal's text, or undefined for any other expression. */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  return undefined;
}

/** An expression's text pieces in order, with HOLE for each computed value. */
function expressionPieces(node) {
  const literal = literalText(node);
  if (literal !== undefined) return [literal];
  if (ts.isParenthesizedExpression(node))
    return expressionPieces(node.expression);
  if (ts.isTemplateExpression(node)) {
    const pieces = [node.head.text];
    for (const span of node.templateSpans) pieces.push(HOLE, span.literal.text);
    return pieces;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return [...expressionPieces(node.left), ...expressionPieces(node.right)];
  return [HOLE];
}

/** A JSX element's children as text pieces, with HOLE for each other child. */
function jsxPieces(children) {
  const pieces = [];
  for (const child of children) {
    if (ts.isJsxText(child)) pieces.push(child.text);
    else if (ts.isJsxExpression(child) && child.expression)
      pieces.push(...expressionPieces(child.expression));
    else if (!ts.isJsxExpression(child)) pieces.push(HOLE);
  }
  return pieces;
}

/**
 * The strings of a TypeScript source a label can match, each as its text
 * pieces with HOLE where a value is interpolated.
 */
export function sourceStrings(sourceFile) {
  const strings = [];
  for (const node of descendants(sourceFile)) {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      strings.push(jsxPieces(node.children));
      continue;
    }
    const isPlus =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken;
    const parentIsPlus =
      node.parent &&
      ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
    if (isPlus && !parentIsPlus) strings.push(expressionPieces(node));
    else if (ts.isTemplateExpression(node))
      strings.push(expressionPieces(node));
    else if (literalText(node) !== undefined) strings.push([literalText(node)]);
  }
  return strings;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A matcher over every string of `strings`: `has(label)` is true when the
 * label is a run of whole words in one piece, or fills one string whole with
 * each HOLE standing for any text. A string with holes must hold two words of
 * its own and a third of the label's length, so a bare `${n} files` matches
 * nothing.
 */
export function labelIndex(strings) {
  const texts = [];
  const patterns = [];
  for (const pieces of strings) {
    const merged = [];
    for (const piece of pieces) {
      const last = merged.length - 1;
      if (piece !== HOLE && last >= 0 && merged[last] !== HOLE)
        merged[last] += piece;
      else merged.push(piece);
    }
    const parts = merged.map((piece) =>
      piece === HOLE ? HOLE : normalize(piece),
    );
    const literal = parts.filter((part) => part !== HOLE && part !== "");
    texts.push(...literal);
    if (!parts.includes(HOLE)) continue;
    if (literal.join(" ").split(" ").length < 2) continue;
    const source = parts
      .filter((part) => part !== "")
      .map((part) => (part === HOLE ? ".*?" : escapeRegExp(part)))
      .join(" ?");
    patterns.push({
      regExp: new RegExp(`^${source}$`),
      literalLength: literal.join("").length,
    });
  }
  const joined = texts.join("\n");
  return {
    has(label) {
      const wanted = normalize(label);
      const words = new RegExp(
        `(?<![a-z0-9])${escapeRegExp(wanted)}(?![a-z0-9])`,
      );
      if (words.test(joined)) return true;
      return patterns.some(
        ({ regExp, literalLength }) =>
          literalLength * 3 >= wanted.length && regExp.test(wanted),
      );
    },
    size: texts.length,
  };
}

/** Every TypeScript source under `dirs`, resolved against `root`, tests excluded. */
export function labelSources(root, dirs = LABEL_SOURCE_DIRS) {
  return dirs
    .flatMap((dir) => filesUnder(resolve(root, dir)))
    .filter(
      (file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file),
    )
    .filter((file) => !file.endsWith(".d.ts"));
}

/**
 * The failures for the guides `guides` (`{file, text}` pairs) against the
 * strings `index` matches: one per bold label that matches nothing, and one
 * per NOT_LABELS entry no guide uses.
 */
export function guideLabelFailures(guides, index, notLabels = NOT_LABELS) {
  const failures = [];
  const excused = new Map(notLabels.map((entry) => [entry.text, false]));
  for (const { file, text } of guides)
    for (const label of boldLabels(text, file)) {
      if (excused.has(label.text)) {
        excused.set(label.text, true);
        continue;
      }
      if (index.has(label.text)) continue;
      failures.push(
        `${file}:${label.line}: **${label.text}** matches no string in ${LABEL_SOURCE_DIRS.join(", ")}. Use the label as the app shows it; if this text is not a UI label, write it without bold or add it to NOT_LABELS in scripts/check-guide-labels.mjs with why.`,
      );
    }
  for (const [text, used] of excused)
    if (!used)
      failures.push(
        `NOT_LABELS lists **${text}**, but no guide under ${GUIDES_DIR} sets it in bold. Delete the entry from scripts/check-guide-labels.mjs.`,
      );
  return failures;
}

/** Read the guides and label sources under `root` and return the failures. */
export function checkTree(root, notLabels = NOT_LABELS) {
  const guides = filesUnder(resolve(root, GUIDES_DIR))
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({
      file: file.slice(root.length + 1),
      text: readFileSync(file, "utf8"),
    }));
  const strings = labelSources(root).flatMap((file) =>
    sourceStrings(parseSource(file, readFileSync(file, "utf8"))),
  );
  const index = labelIndex(strings);
  const labels = guides.reduce(
    (sum, { file, text }) => sum + boldLabels(text, file).length,
    0,
  );
  const failures = guideLabelFailures(guides, index, notLabels);
  if (labels === 0)
    failures.push(
      `No bold label was found under ${GUIDES_DIR}, so scripts/check-guide-labels.mjs checks nothing. If the guides moved or mark labels another way, update the check to match.`,
    );
  if (index.size === 0)
    failures.push(
      `No string was read from ${LABEL_SOURCE_DIRS.join(", ")}, so every label would fail. Update LABEL_SOURCE_DIRS in scripts/check-guide-labels.mjs.`,
    );
  return { failures, guides: guides.length, labels, strings: index.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag === -1 ? repoRoot : resolve(process.argv[rootFlag + 1]);
  const { failures, guides, labels, strings } = checkTree(root);
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log(
    `Guide label check passed: ${labels} bold label(s) across ${guides} guide(s), matched against ${strings} app string(s); ${NOT_LABELS.length} listed as not labels.`,
  );
}
