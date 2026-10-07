#!/usr/bin/env node
// Squash-message body normalizer:
// `node .claude/scripts/format-squash-message.mjs [<draft-path>] [--fenced]`.
// Reads a draft body from the path or stdin (`-` or no path) and prints it
// normalized to stdout: paragraphs rewrapped at BODY_WRAP_COLUMNS, markdown
// markers dropped with their text kept, list items turned into paragraphs.
// A block holding an indented line is left verbatim. What cannot be fixed
// without changing the words, `refusals` below, is refused, and so is output
// that fails `violations`, the check squash-message.mjs also runs. `--fenced`
// wraps the body in a code fence, the form posted as a pull-request comment.
// The draft is the body alone; GitHub takes the subject from the PR title.
//
// Exit 0 printed, 1 the draft could not be read, 2 on a usage error or a
// refusal, with nothing printed. Rationale and limits:
// docs/notes/agent-hooks-and-scripts.md.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** CONTRIBUTING.md's body wrap: the widest a body line may be. */
export const BODY_WRAP_COLUMNS = 70;

/** A fenced-code delimiter, whose line is dropped whole. */
const CODE_FENCE = /^\s*(?:```|~~~)/;

/** A heading marker, whose line becomes a paragraph of its own. */
const HEADING = /^\s{0,3}#{1,6}\s+/;

/** A blockquote marker, dropped from the front of the line. */
const BLOCKQUOTE = /^\s*>\s?/;

// A bullet or numbered item starting at column 0. A numbered marker runs to two
// digits: a longer run of digits before a period at the start of a line is
// prose, a year most often.
const TOP_LEVEL_LIST = /^(?:[-*+]|\d{1,2}[.)])\s+/;

/** The same item indented under another one. */
const NESTED_LIST = /^\s+(?:[-*+]|\d{1,2}[.)])\s+/;

/** A markdown link, as text and url. */
const LINK = /\[([^\]]*)\]\(([^)\s]*)\)/g;

/**
 * Markdown a commit message does not take, each with the name of what it is.
 * This names what a report says; what normalizing does with each is
 * `plainText` and `paragraphsOf` below.
 */
const MARKDOWN_MARKERS = [
  { pattern: HEADING, name: "a markdown heading" },
  { pattern: BLOCKQUOTE, name: "a blockquote marker" },
  {
    pattern: /\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|(?<!\w)_[^_]+_(?!\w)/,
    name: "markdown emphasis",
  },
  { pattern: /`[^`]+`/, name: "an inline code span" },
  { pattern: /\[[^\]]*\]\([^)\s]*\)/, name: "a markdown link" },
];

/**
 * The draft as body lines: line endings normalized, trailing whitespace
 * dropped, code fence lines removed, and the blank lines around the whole body
 * removed.
 */
export function bodyLinesOf(draft) {
  const lines = String(draft ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !CODE_FENCE.test(line));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** The body's blank-line-separated blocks, blank lines dropped. */
function blocksOf(body) {
  const blocks = [];
  let block = [];
  for (const line of body) {
    if (line === "") {
      if (block.length > 0) blocks.push(block);
      block = [];
    } else {
      block.push(line);
    }
  }
  if (block.length > 0) blocks.push(block);
  return blocks;
}

/**
 * Whether a line a marker sits under is a line a list is written below: a
 * heading, which normalizing gives a paragraph of its own, or a lead-in ending
 * in a colon once its own markers are stripped, so that "The points:" opens one
 * however it was emphasized.
 */
function opensList(above) {
  return HEADING.test(above) || plainText(above).endsWith(":");
}

/**
 * Which lines of the block start a list item. A marker at column 0 starts one
 * where the block opens on it, where an item is already open, or where the line
 * above opens a list; anywhere else it is a word that happens to sit at the
 * front of a wrapped line, and splitting there would lose it.
 */
function itemStarts(block) {
  const starts = [];
  let open = false;
  for (const [index, raw] of block.entries()) {
    const line = raw.replace(BLOCKQUOTE, "");
    const above = index === 0 ? "" : block[index - 1].replace(BLOCKQUOTE, "");
    const item =
      TOP_LEVEL_LIST.test(line) && (index === 0 || open || opensList(above));
    starts.push(item);
    open ||= item;
  }
  return starts;
}

/** Whether the block is indented text, which is copied through as it stands. */
function isVerbatim(block) {
  return (
    block.some((line) => /^\s/.test(line)) && !itemStarts(block).some(Boolean)
  );
}

/** One line with its inline markdown markers removed. */
function plainText(line) {
  return line
    .replace(LINK, (_match, text, url) =>
      text.includes(url) ? text : `${text} (${url})`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** A non-verbatim block as the paragraphs it normalizes to, markers removed. */
function paragraphsOf(block) {
  const paragraphs = [];
  const starts = itemStarts(block);
  let current = [];
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text !== "") paragraphs.push(text);
    current = [];
  };
  for (const [index, raw] of block.entries()) {
    const line = raw.replace(BLOCKQUOTE, "");
    if (HEADING.test(line)) {
      flush();
      current.push(plainText(line.replace(HEADING, "")));
      flush();
    } else if (starts[index]) {
      flush();
      current.push(plainText(line.replace(TOP_LEVEL_LIST, "")));
    } else {
      current.push(plainText(line.replace(NESTED_LIST, "")));
    }
  }
  flush();
  return paragraphs;
}

/** One paragraph greedily wrapped, as lines. */
export function wrapParagraph(text, columns = BODY_WRAP_COLUMNS) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((word) => word !== "")) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= columns) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * The body with its markdown and its lists turned into paragraphs, every
 * paragraph rewrapped, and one blank line between blocks. Indented blocks are
 * copied through.
 */
export function normalizeDraft(draft) {
  const blocks = blocksOf(bodyLinesOf(draft)).flatMap((block) =>
    isVerbatim(block)
      ? [block]
      : paragraphsOf(block).map((paragraph) => wrapParagraph(paragraph)),
  );
  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

/** A line quoted in a report, shortened so the report stays readable. */
function quoted(line) {
  return line.length <= 60 ? line : `${line.slice(0, 57)}...`;
}

/**
 * What is wrong with the body that normalizing cannot fix: an empty body, or an
 * over-wide line inside an indented block. Empty means the body is ready once it
 * is normalized.
 */
export function refusals(draft) {
  const blocks = blocksOf(bodyLinesOf(draft));
  if (blocks.length === 0) {
    return ["The draft is empty; a squash message needs a body."];
  }

  const found = [];
  for (const block of blocks.filter(isVerbatim)) {
    for (const line of block.filter(
      (line) => line.length > BODY_WRAP_COLUMNS,
    )) {
      found.push(
        `An indented line is ${line.length} columns: "${quoted(line)}". ` +
          "Indented text is left as it was written, so wrap it by hand at " +
          `${BODY_WRAP_COLUMNS}.`,
      );
    }
  }
  return found;
}

/**
 * Body lines the normalizer would rewrap: over the column budget with more than
 * one word in them. A line holding a single long word is left out, there being
 * no way to wrap it that does not change the text.
 */
export function overlongBodyLines(draft) {
  return blocksOf(bodyLinesOf(draft))
    .filter((block) => !isVerbatim(block))
    .flat()
    .filter(
      (line) => line.length > BODY_WRAP_COLUMNS && /\s/.test(line.trim()),
    );
}

/**
 * What normalizing would change about the draft, named rule by rule where a rule
 * names it. The list is empty exactly when the draft is already what the
 * normalizer produces, so a caller that cannot rewrite the draft can gate on it;
 * the names are a report, and anything they miss is reported as the difference
 * it is.
 */
function unnormalized(draft) {
  if (normalizeDraft(draft) === draft) return [];

  const found = [];
  if (/^\s*(?:```|~~~)/m.test(String(draft ?? ""))) {
    found.push(
      "A commit message takes no markdown, and this draft holds a code fence. " +
        "Normalizing drops the fence line.",
    );
  }

  const listed = (line) =>
    `A commit message body is prose, not a list: "${quoted(line)}". ` +
    "Normalizing drops the marker and makes the item a paragraph.";
  const marked = (line) => {
    const marker = MARKDOWN_MARKERS.find(({ pattern }) => pattern.test(line));
    return marker === undefined
      ? null
      : `A commit message takes no markdown, and this line holds ${marker.name}: ` +
          `"${quoted(line)}". Normalizing drops the marker and keeps the text.`;
  };

  for (const block of blocksOf(bodyLinesOf(draft)).filter(
    (block) => !isVerbatim(block),
  )) {
    const starts = itemStarts(block);
    const isList = starts.some(Boolean);
    for (const [index, line] of block.entries()) {
      if (starts[index] || (isList && NESTED_LIST.test(line))) {
        found.push(listed(line));
        continue;
      }
      const message = marked(line);
      if (message !== null) found.push(message);
    }
  }

  found.push(
    ...overlongBodyLines(draft).map(
      (line) =>
        `A body line is ${line.length} columns and CONTRIBUTING.md wraps at ` +
        `${BODY_WRAP_COLUMNS}: "${quoted(line)}".`,
    ),
  );

  if (found.length === 0) {
    found.push(
      "The draft is not what the normalizer produces from it: the blank lines, " +
        "the trailing whitespace, or the final newline differ.",
    );
  }
  return found;
}

/**
 * Every Commit Messages rule the body breaks as written, the ones normalizing
 * fixes included. This is what a check over an already-written body asks; a
 * producer that can still normalize the body asks `refusals` instead.
 */
export function violations(draft) {
  return [...refusals(draft), ...unnormalized(draft)];
}

/** The normalized body and what it still breaks, in one call. */
export function formatDraft(draft) {
  return { text: normalizeDraft(draft), refusals: refusals(draft) };
}

/**
 * The body inside a code fence one backtick longer than the longest run of
 * backticks it holds, and never shorter than three.
 */
export function fenced(text) {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map(([run]) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}${fence}\n`;
}

/**
 * The arguments in `argv`, or null when they are not at most one draft path
 * and an optional `--fenced`. A path of `-` is stdin.
 */
export function parseArgs(argv) {
  const positional = [];
  let fence = false;
  for (const argument of argv) {
    if (argument === "--fenced") {
      if (fence) return null;
      fence = true;
    } else if (argument.startsWith("-") && argument !== "-") {
      return null;
    } else {
      positional.push(argument);
    }
  }
  if (positional.length > 1) return null;
  const input = positional[0] ?? null;
  return { input: input === "-" ? null : input, fenced: fence };
}

/** How the script is called, printed on an unusable argument list. */
export const USAGE =
  "Usage: node format-squash-message.mjs [<draft-path>] [--fenced]\n";

/** The refusal report, for a caller that prints it rather than throwing. */
export function refusalReport(broken) {
  return (
    "This draft breaks the rules in `CONTRIBUTING.md`, Commit Messages, and " +
    "nothing here can fix it without rewriting the message:\n" +
    broken.map((problem) => `  - ${problem}\n`).join("")
  );
}

/**
 * The report for output `violations` still rejects: normalizing produced a
 * message its own check refuses, which is a bug here rather than something the
 * draft's author can reword around.
 */
export function selfCheckReport(broken) {
  return (
    "format-squash-message.mjs produced a message that breaks the rules it " +
    "checks for, which is a bug in the script:\n" +
    broken.map((problem) => `  - ${problem}\n`).join("") +
    "Write the message by hand under `CONTRIBUTING.md`, Commit Messages.\n"
  );
}

// CLI entry: only runs when invoked directly, so squash-message.mjs and the
// tests can import the functions above without reading stdin.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  let draft;
  try {
    draft = readFileSync(args.input ?? 0, "utf8");
  } catch (error) {
    process.stderr.write(`could not read the draft: ${error.message}\n`);
    process.exit(1);
  }
  const { text, refusals: broken } = formatDraft(draft);
  if (broken.length > 0) {
    process.stderr.write(`${refusalReport(broken)}Nothing was printed.\n`);
    process.exit(2);
  }
  const remaining = violations(text);
  if (remaining.length > 0) {
    process.stderr.write(`${selfCheckReport(remaining)}Nothing was printed.\n`);
    process.exit(2);
  }
  process.stdout.write(args.fenced ? fenced(text) : text);
  process.exit(0);
}
