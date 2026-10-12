#!/usr/bin/env node
// PreToolUse hook on Bash: refuse a wait that can run forever, and a call that
// is nothing but a long `sleep`, the shapes a session takes when it polls for
// a background run to finish. Three shapes are refused:
//
// - A naked sleep: a command that is exactly `sleep <duration>`, when the
//   duration is at least MINIMUM_BLOCKED_SECONDS. A sleep inside a larger
//   command line is judged by the two rules below.
// - An unbounded wait loop: an `until` or `while` loop that sleeps, in its
//   condition or its body. It is bounded when a `timeout ... sh -c` wrapper
//   encloses it, or when its condition or body does shell arithmetic
//   (`$((n+=1))`, `((...))`, `let`, `expr`), reads `SECONDS`, or reads
//   `date +%s`. A `for` loop over a finite list is not read.
// - An unbounded background command: split on `;`, `&&`, `||` and newline
//   outside quotes, every element of a `run_in_background` call must be one
//   of: setup (`cd DIR`, bare or exported assignments); a read-only pipeline
//   (`echo`, `tail -5 log`, `grep -c x log | wc -l`) that does not follow a
//   file or read a device; or a command opening with `timeout <N>` or
//   `gtimeout <N>`, N not zero, after optional assignments and `env -C DIR`,
//   each later pipe stage of which is bounded the same way or read-only. At
//   least one element must be bounded. A lone `&`, a heredoc, or a command or
//   process substitution outside single quotes refuses wherever it appears. A
//   word is read with its quotes removed; a path with any `dev` component other
//   than `/dev/null` is a device, and a FIFO or a symlink to a device is not
//   seen. Any non-zero N is accepted.
//
// Probes: block-sleep-poll.probe.md beside this file. The background-resume
// probe last ran 2026-09-25 on Claude Code 2.1.282 (macOS host), and a
// `Workflow` `agent()` call was not probed; the background-stdin probe, which
// the read-only allowance rests on, last ran 2026-10-12 on 2.1.296.
//
// Not a shell parser (see lib/shell.mjs): a loop in a variable, a function or
// an `eval` string is not seen. Exit 0 allows the call; exit 2 blocks it and
// feeds stderr back to Claude. An unexpected failure allows (fail open).
// Rationale: docs/notes/agent-hooks-and-scripts.md.

import { commandOf, eventForTools } from "./lib/event.mjs";
import { posix } from "node:path";

import { tokenizeRaw } from "./lib/shell.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

const MINIMUM_BLOCKED_SECONDS = 5;

// The duration forms `sleep` itself accepts: a decimal number with an optional
// unit suffix. A bare number is seconds.
const SLEEP_ONLY = /^sleep\s+(\d+(?:\.\d+)?)([smhd]?)$/;

const UNIT_SECONDS = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

// The duration in seconds of a command that is a naked `sleep` and nothing else,
// or null when the command is anything more than that.
function nakedSleepSeconds(command) {
  const match = SLEEP_ONLY.exec(command.trim());
  return match === null ? null : Number(match[1]) * UNIT_SECONDS[match[2]];
}

// A loop's condition and body, split on the first `do` and the first `done`
// after it; a nested loop ends its enclosing match early, which only narrows
// what is refused.
const WAIT_LOOP =
  /\b(?:until|while)\s([\s\S]*?)(?:;|\n)\s*do\s([\s\S]*?)(?:;|\n)?\s*\bdone\b/g;
const SLEEPS = /\bsleep\b/;
const COUNTS_OR_DEADLINE =
  /\$\(\(|\(\(|\blet\s|\bexpr\s|\bSECONDS\b|\bdate\s+['"]?\+%s\b/;
const TIMEOUT_SHELL =
  /\bg?timeout\s[^;&|\n]*\b(?:bash|sh|zsh|dash)\s+(?:-\w+\s+)*-\w*c\b/;

// True when the loop starting at loopIndex sits inside the quoted script
// of a timeout-wrapped shell: the quote opening that shell's -c argument
// is still open where the loop starts.
function insideTimeoutShell(command, loopIndex) {
  const prefix = command.slice(0, loopIndex);
  let wrapper = null;
  for (const found of prefix.matchAll(new RegExp(TIMEOUT_SHELL.source, "g"))) {
    wrapper = found;
  }
  if (wrapper === null) return false;
  const script = prefix.slice(wrapper.index + wrapper[0].length);
  const opener = /^\s*(['"])/.exec(script);
  if (opener === null) return false;
  const quote = opener[1];
  const rest = script.slice(opener[0].length);
  const closers = rest
    .split(quote)
    .filter((_, i, all) => i < all.length - 1)
    .filter((piece) => !piece.endsWith("\\")).length;
  return closers % 2 === 0;
}

// True when the command holds a sleeping loop with no timeout wrapper enclosing
// it and no counter or deadline inside it.
function hasUnboundedWaitLoop(command) {
  for (const match of command.matchAll(WAIT_LOOP)) {
    const [, condition, body] = match;
    if (!SLEEPS.test(condition) && !SLEEPS.test(body)) continue;
    if (COUNTS_OR_DEADLINE.test(condition) || COUNTS_OR_DEADLINE.test(body)) {
      continue;
    }
    if (insideTimeoutShell(command, match.index)) continue;
    return true;
  }
  return false;
}

// `timeout` options that take the next word as their value when not joined to
// it (`-s KILL`, `--kill-after 5`).
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "-k", "--signal", "--kill-after"]);
const DURATION = /^(\d+(?:\.\d*)?|\.\d+)[smhd]?$/;

// True when the command opens with `timeout <N>` (or `gtimeout <N>`), N a
// non-zero duration, followed by a command for it to bound.
function opensWithTimeout(command) {
  const words = tokenizeRaw(command);
  if (words[0] !== "timeout" && words[0] !== "gtimeout") return false;
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    i += TIMEOUT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const duration = words[i];
  if (duration === undefined || !DURATION.test(duration)) return false;
  if (Number.parseFloat(duration) === 0) return false;
  return i + 1 < words.length;
}

// Split text at the separators `separatorWidth(text, i)` finds outside quotes:
// it returns the separator's width at i, 0 for none, or -1 to refuse the whole
// text, in which case this returns null. Pieces are trimmed; empty ones dropped.
function splitOutsideQuotes(text, separatorWidth) {
  const pieces = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const width = separatorWidth(text, i);
    if (width < 0) return null;
    if (width > 0) {
      pieces.push(text.slice(start, i));
      start = i + width;
      i += width - 1;
    }
  }
  pieces.push(text.slice(start));
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== "");
}

// A list separator: `;`, `&&`, `||` or a newline. A lone `&` refuses, since
// what it backgrounds outlives the bound; an `&` inside a redirection (`2>&1`,
// `&>`, `>&`) or a `|&` pipe is not one.
function listSeparatorWidth(text, i) {
  const pair = text.slice(i, i + 2);
  if (pair === "&&" || pair === "||") return 2;
  const char = text[i];
  if (char === ";" || char === "\n") return 1;
  if (char !== "&") return 0;
  const before = text[i - 1];
  const after = text[i + 1];
  const inRedirection =
    before === ">" || before === "<" || before === "|" || after === ">";
  return inRedirection ? 0 : -1;
}

function pipeSeparatorWidth(text, i) {
  if (text[i] !== "|") return 0;
  return text[i + 1] === "&" ? 2 : 1;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUBSTITUTION = /\$\(|`|<\(|>\(|<</;

// The text with every single-quoted span dropped, since the shell expands
// nothing inside one: a `$(...)` there is a literal, or the script of a
// `sh -c` the timeout bounds.
function outsideSingleQuotes(text) {
  let kept = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      kept += text.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (char === '"') quote = quote === '"' ? null : '"';
    else if (char === "'" && quote === null) {
      quote = "'";
      continue;
    }
    kept += char;
  }
  return kept;
}

// True when the shell running the element would itself run a command
// substitution, a process substitution or a heredoc, which no timeout in the
// element bounds.
function hasSubstitution(element) {
  return SUBSTITUTION.test(outsideSingleQuotes(element));
}

// A list element that runs nothing: `cd DIR`, or bare or exported assignments.
function isSetup(element) {
  if (hasSubstitution(element)) return false;
  const words = tokenizeRaw(element);
  if (words[0] === "cd") return words.length <= 2;
  const assignments = words[0] === "export" ? words.slice(1) : words;
  return assignments.length > 0 && assignments.every((w) => ASSIGNMENT.test(w));
}

// Commands that only read or report, each ending once its input does; `tee`
// writes what it reads, and ends the same way.
const READ_ONLY = new Set([
  "echo",
  "grep",
  "tail",
  "head",
  "cat",
  "ls",
  "wc",
  "free",
  "uptime",
  "date",
  "pwd",
  "true",
  "sort",
  "uniq",
  "tr",
  "cut",
  "tee",
]);
// A short-option cluster holding `f` or `F` (`-f`, `-nF`), or a long option
// `tail` would take as `--follow`: any prefix of it, with or without a value.
const SHORT_FOLLOW = /^-[A-Za-z0-9]*[fF]/;
const LONG_OPTION_NAME = /^--([^=]+)/;
const REDIRECTION_OPERATOR = /^(?:\d*|&)(?:>>?|<)[&|]?/;

// A word as the command sees it once the shell removes quotes and backslashes.
function unquoted(word) {
  return word.replace(/['"\\]/g, "");
}

function isFollowOption(word) {
  if (SHORT_FOLLOW.test(word)) return true;
  const name = LONG_OPTION_NAME.exec(word)?.[1];
  return name !== undefined && "follow".startsWith(name);
}

// True when the word, or a redirection's target, is a path with a `dev`
// component (`/dev/zero`, `//dev/zero`, `../../dev/zero`, `</dev/urandom`)
// other than `/dev/null`. A component named `dev` anywhere refuses, since a
// relative path's directory is not known here.
function readsDevice(word) {
  const path = word.replace(REDIRECTION_OPERATOR, "");
  if (path === "" || posix.normalize(path) === "/dev/null") return false;
  return path.split("/").includes("dev");
}

// A pipe stage running a READ_ONLY command that does not follow a file
// (`tail -f`) or read a device (`/dev/zero`).
function isReadOnlyStage(stage) {
  const words = tokenizeRaw(stage).map(unquoted);
  if (!READ_ONLY.has(words[0])) return false;
  if (words.some(readsDevice)) return false;
  return words[0] !== "tail" || !words.some(isFollowOption);
}

// A list element whose every pipe stage is read-only.
function isReadOnly(element) {
  if (hasSubstitution(element)) return false;
  const stages = splitOutsideQuotes(element, pipeSeparatorWidth);
  if (stages === null || stages.length === 0) return false;
  return stages.every(isReadOnlyStage);
}

// True when the element opens with `timeout <N>` once leading assignments and an
// `env` carrying only `-C DIR` and assignments are set aside, holds no
// substitution, and every later pipe stage is bounded the same way or read-only.
function isBounded(element) {
  if (hasSubstitution(element)) return false;
  const stages = splitOutsideQuotes(element, pipeSeparatorWidth);
  if (stages === null || stages.length === 0) return false;
  const [first, ...rest] = stages;
  if (!opensBounded(first)) return false;
  return rest.every((stage) => opensBounded(stage) || isReadOnlyStage(stage));
}

function opensBounded(stage) {
  const words = tokenizeRaw(stage);
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i])) i += 1;
  if (words[i] === "env") {
    i += 1;
    for (;;) {
      if (words[i] === "-C" || words[i] === "--chdir") i += 2;
      else if (/^(?:-C.|--chdir=)/.test(words[i] ?? "")) i += 1;
      else if (ASSIGNMENT.test(words[i] ?? "")) i += 1;
      else break;
    }
  }
  return opensWithTimeout(words.slice(i).join(" "));
}

// A background command is bounded when every list element is setup, read-only
// or bounded by its own timeout, and at least one is bounded.
function isUnboundedBackground(command) {
  const elements = splitOutsideQuotes(command.trim(), listSeparatorWidth);
  if (elements === null) return true;
  let bounded = 0;
  for (const element of elements) {
    if (isSetup(element) || isReadOnly(element)) continue;
    if (!isBounded(element)) return true;
    bounded += 1;
  }
  return bounded === 0;
}

function blockUnboundedLoop() {
  process.stderr.write(
    "Blocked by block-sleep-poll hook: this loop sleeps with no upper bound, so if " +
      "what it waits for never happens it keeps running after this session has " +
      "returned.\n" +
      "Bound the wait with a timeout wrapper -- " +
      "`timeout 600 sh -c 'until <test>; do sleep 2; done'` -- " +
      "or an iteration counter -- " +
      "`n=0; until <test> || [ $((n+=1)) -gt 300 ]; do sleep 2; done`.\n",
  );
  process.exit(2);
}

function blockUnboundedBackground() {
  process.stderr.write(
    "Blocked by block-sleep-poll hook: a run_in_background command has no timeout " +
      "of its own, so every command it runs must open with `timeout <N>` (N not " +
      "zero), apart from a leading `cd DIR` or `VAR=value` and a trailing `echo` " +
      "or read-only `tail`/`grep`/`cat`, and every stage piped after it must be " +
      "bounded the same way or read-only. A read-only command may not follow a file " +
      "or read a device, and no lone `&`, heredoc, `$(...)`, backtick or `<(...)` " +
      "may appear outside single quotes.\n" +
      "Bound each command -- `timeout 900 npm run lint > /tmp/lint.log 2>&1; " +
      "echo exit=$?`, or `timeout 900 sh -c 'npm run build && npm test'` -- or, " +
      "where no `timeout` is on PATH, run it in the foreground with a raised " +
      "timeout.\n",
  );
  process.exit(2);
}

function blockNakedSleep(seconds) {
  process.stderr.write(
    `Blocked by block-sleep-poll hook: this call is a bare ${seconds}-second sleep, ` +
      "which polls rather than waits -- every poll re-bills this session's whole context.\n" +
      "Wait one of the three ways that cost nothing while they wait: run the command in " +
      "the foreground and let the tool wait for it; start it with run_in_background, " +
      "opening with `timeout <N>` (N not zero), and wait for the completion notification; " +
      "or loop on the condition itself inside one " +
      "bounded call (`timeout 600 sh -c 'until <test>; do sleep 2; done'`).\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);
  const seconds = nakedSleepSeconds(command);
  if (seconds !== null && seconds >= MINIMUM_BLOCKED_SECONDS) {
    blockNakedSleep(seconds);
  }
  if (hasUnboundedWaitLoop(command)) blockUnboundedLoop();
  if (event.tool_input.run_in_background === true) {
    if (isUnboundedBackground(command)) blockUnboundedBackground();
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
