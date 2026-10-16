#!/usr/bin/env node
// PreToolUse hook on Bash: refuse a subagent's run_in_background call whose
// command fits the foreground ceiling. A subagent that backgrounds a command
// and ends its turn sends its caller an interim notification, and each one is
// a caller turn spent; a command that fits the ceiling runs in the foreground
// with the Bash tool's timeout raised, at no such cost.
//
// A call is refused when all of these hold:
//
// - `run_in_background` is true;
// - the event has a non-empty `agent_id`, which only a subagent's call has;
// - no `timeout <N>` or `gtimeout <N>` wrapper in the command has N over
//   FOREGROUND_CEILING_SECONDS. A wrapper is a `timeout` in command position:
//   the first word of a list element or pipe stage, after any assignments and
//   prefix words (`env -C DIR`, `nice`). N takes `timeout`'s own units (`s`,
//   `m`, `h`, `d`); its `-k` grace is not counted.
//
// The test is the largest single wrapper, not the sum of several: a chain past
// the ceiling runs as one call under one wrapper, `timeout 1800 sh -c 'a && b'`.
// A command with no wrapper at all is refused here and by block-sleep-poll.mjs.
//
// Not a shell parser (see lib/shell.mjs): quoted spans are dropped before the
// command is split, so a wrapper inside a `sh -c` script is not seen, and one
// in a variable, a function or an `eval` string is not seen either. Exit 0
// allows the call; exit 2 blocks it and feeds stderr back to Claude. An
// unexpected failure allows (fail open). Rationale:
// docs/notes/agent-hooks-and-scripts.md.

import { commandOf, eventForTools } from "./lib/event.mjs";
import { peelCommandPrefix, splitSegments, tokenize } from "./lib/shell.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2027-03-31";

const FOREGROUND_CEILING_SECONDS = 600;

const QUOTED_SPAN = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "-k", "--signal", "--kill-after"]);
const DURATION = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/;
const UNIT_SECONDS = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
const PREFIX_FLAGS_WITH_VALUE = new Set(["-C", "--chdir", "-u", "-n"]);

// The seconds a stage's `timeout` wrapper allows, or 0 when the stage does not
// open with one.
function wrapperSeconds(stage) {
  const words = tokenize(stage);
  const { index } = peelCommandPrefix(words, {
    isFlagValue: (_, at) => PREFIX_FLAGS_WITH_VALUE.has(words[at - 1]),
  });
  if (words[index] !== "timeout" && words[index] !== "gtimeout") return 0;
  let i = index + 1;
  while (i < words.length && words[i].startsWith("-")) {
    i += TIMEOUT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  const match = DURATION.exec(words[i] ?? "");
  if (match === null || i + 1 >= words.length) return 0;
  return Number.parseFloat(match[1]) * UNIT_SECONDS[match[2]];
}

// The largest wrapper in the command, read with every quoted span emptied so
// that neither a separator nor a `timeout` inside one is read.
function largestWrapperSeconds(command) {
  const unquoted = command.replace(QUOTED_SPAN, "''");
  return Math.max(0, ...splitSegments(unquoted).map(wrapperSeconds));
}

function blockShortBackground() {
  process.stderr.write(
    "Blocked by block-subagent-short-background hook: this subagent's " +
      "run_in_background command has no `timeout` wrapper over " +
      `${FOREGROUND_CEILING_SECONDS} s, so it fits the foreground, and ` +
      "backgrounding it sends your caller an extra notification when your turn ends.\n" +
      "Run it in the foreground with the Bash tool's timeout raised (up to 600000 ms). " +
      "Background only a chain longer than that, as one call opening with " +
      "`timeout <N>`, N over 600 s: " +
      "`timeout 1800 sh -c 'npm run build && npm test' > /tmp/run.log 2>&1; echo exit=$?`.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  if (event.tool_input?.run_in_background !== true) process.exit(0);
  const agentId = event.agent_id;
  if (typeof agentId !== "string" || agentId === "") process.exit(0);
  const command = commandOf(event);
  if (command === null) process.exit(0);
  if (largestWrapperSeconds(command) <= FOREGROUND_CEILING_SECONDS) {
    blockShortBackground();
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
