// The names and anchors a Markdown heading takes, for the checks that resolve
// a link or citation against a document's headings. `slugify` follows GitHub's
// rule: `npm run linkcheck` checks every `#anchor` link against it, and the
// project site (site/.vitepress/config.mjs) gives its headings the same
// anchors, so a link that resolves on GitHub resolves on the site.

import { stripFences } from "./markdownFences.mjs";

/**
 * GitHub-style heading slug: lowercase, drop characters that are not word
 * characters (letters, digits, underscore), whitespace, or hyphen, then turn
 * each remaining whitespace character into a hyphen without collapsing runs
 * (so "ssh2 / ssh2" -> "ssh2--ssh2"). Inline links and code spans in a heading
 * are reduced to their text first.
 */
export function slugify(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) -> text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // drop punctuation; \w keeps underscores, as GitHub does
    .trim()
    .replace(/\s/g, "-"); // each whitespace char -> hyphen, runs not collapsed
}

/**
 * The anchor slugs the headings of a Markdown `source` take, with GitHub's
 * -1/-2 disambiguation suffixes for repeated headings. `file` names the source
 * in a fence error.
 */
export function headingAnchors(source, file) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of stripFences(source, file).split("\n")) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slugify(m[2]);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const SHORT_NAME_END = / -- | - |: /;

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
