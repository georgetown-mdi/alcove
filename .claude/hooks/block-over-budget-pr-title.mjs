#!/usr/bin/env node
// PreToolUse hook on Bash: refuse a `gh pr create` or `gh pr edit` call whose
// `--title` is longer than the squash-merge subject budget. A pull request's
// title becomes the commit subject with GitHub's " (#NNNN)" appended, and the
// subject limit in `CONTRIBUTING.md`, Commit Messages, counts that suffix.
//
// THE BUDGET IS NOT A NUMBER HERE. `subjectBudget` in
// ../../scripts/lib/squashSubjectBudget.mjs is the one source, so the suffix
// width, the limit it is subtracted from, and the digits assumed for an unknown
// pull request move together with the checklist check that fails the open
// pull request. A number or pull-request URL as `gh pr edit`'s first argument
// gives the exact suffix; any other `gh pr edit` and every `gh pr create`
// assume a four-digit number. The flag is read as `--title V`, `--title=V`,
// `-t V`, `-t=V` or `-tV`, with quotes removed and nothing expanded.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure falls through to exit 0 (fail open). Rationale and limits:
// docs/notes/agent-hooks-and-scripts.md.

import {
  SUBJECT_LIMIT,
  squashSuffix,
  subjectBudget,
} from "../../scripts/lib/squashSubjectBudget.mjs";
import { commandOf, eventForTools } from "./lib/event.mjs";
import { splitSegments, tokenize, tokenizeRaw } from "./lib/shell.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

/** The `gh pr` subcommands that take a title. `new` is an alias of `create`. */
const TITLED_SUBCOMMANDS = new Set(["create", "new", "edit"]);

const LONG_FLAG = "--title";
const SHORT_FLAG = "-t";

/**
 * A word with its quote characters removed the way a shell removes them: a pair
 * is dropped and whatever the pair held is kept, so an apostrophe inside a
 * double-quoted title survives to be counted.
 */
function unquote(word) {
  let text = "";
  let open = null;
  for (const character of word) {
    if (open === null && (character === '"' || character === "'")) {
      open = character;
    } else if (character === open) {
      open = null;
    } else {
      text += character;
    }
  }
  return text;
}

/**
 * A segment's words, each read two ways: `text` has every quote character
 * stripped, so a structural word matches whether or not it was written quoted,
 * and `written` keeps them, so a title is still counted at the length it was
 * written. `tokenize` is defined over `tokenizeRaw`, so the two split alike;
 * were that ever to stop holding, read no words rather than pair the wrong two.
 */
function wordsOf(segment) {
  const written = tokenizeRaw(segment);
  const stripped = tokenize(segment);
  if (stripped.length !== written.length) return [];
  return stripped.map((text, index) => ({ text, written: written[index] }));
}

/** The title a single word carries, or null when it carries none of its own. */
function attachedTitle({ text, written }) {
  const value = unquote(written);
  if (text.startsWith(`${LONG_FLAG}=`)) {
    return value.slice(LONG_FLAG.length + 1);
  }
  if (!text.startsWith(SHORT_FLAG) || text.length === SHORT_FLAG.length) {
    return null;
  }
  const attached = value.slice(SHORT_FLAG.length);
  return attached.startsWith("=") ? attached.slice(1) : attached;
}

/** Every title the words set, in the order they were written. */
function titlesIn(words) {
  const titles = [];
  for (const [index, word] of words.entries()) {
    if (word.text === LONG_FLAG || word.text === SHORT_FLAG) {
      const value = words[index + 1];
      if (value !== undefined) titles.push(unquote(value.written));
      continue;
    }
    const attached = attachedTitle(word);
    if (attached !== null) titles.push(attached);
  }
  return titles;
}

/** The pull request a word names, or null when it names none as a number. */
function prNumberOf(word) {
  if (word === undefined) return null;
  const match =
    /^#?(\d+)$/.exec(word.text) ?? /\/pull\/(\d+)(?:\/[^/]*)?$/.exec(word.text);
  return match === null ? null : Number(match[1]);
}

/**
 * Where a `gh pr create` or `gh pr edit` invocation starts in the words, and the
 * pull request it names, or null when the segment holds no such invocation. A
 * quoted span is one word, so the command quoted inside a `--body` is not one.
 */
function invocationIn(words) {
  for (let index = 0; index + 2 < words.length; index++) {
    const namesInvocation =
      words[index].text === "gh" &&
      words[index + 1].text === "pr" &&
      TITLED_SUBCOMMANDS.has(words[index + 2].text);
    if (namesInvocation) {
      return { from: index + 3, prNumber: prNumberOf(words[index + 3]) };
    }
  }
  return null;
}

function block(title, prNumber) {
  const budget = subjectBudget(prNumber);
  const estimate =
    prNumber === null
      ? " The pull request has no number yet, so the four-digit suffix every pull request here has is assumed."
      : "";
  process.stderr.write(
    `Blocked by block-over-budget-pr-title hook: the title is ${title.length} characters ` +
      `and the budget is ${budget}: "${title}".\n` +
      `GitHub squash-merges, so this title becomes the commit subject with "${squashSuffix(prNumber)}" ` +
      `appended, and the limit in \`CONTRIBUTING.md\`, Commit Messages, of ${SUBJECT_LIMIT} counts that suffix.` +
      `${estimate}\n` +
      `Shorten the title to ${budget} characters or fewer; a board item's own title is usually longer ` +
      "than that, so write a shorter one for the pull request.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);

  for (const segment of splitSegments(command)) {
    const words = wordsOf(segment);
    const invocation = invocationIn(words);
    if (invocation === null) continue;
    const budget = subjectBudget(invocation.prNumber);
    for (const title of titlesIn(words.slice(invocation.from))) {
      if (title.length > budget) block(title, invocation.prNumber);
    }
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
