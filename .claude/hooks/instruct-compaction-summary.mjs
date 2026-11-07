#!/usr/bin/env node
// PreCompact hook, for the `auto` and `manual` triggers alike: print the
// instructions the compaction summary is written to. On exit 0 the harness
// adds this hook's stdout to the summarization request as additional
// instructions, after any text the owner typed after `/compact`, and cuts it at
// 10,000 characters a hook.
//
// What the summary keeps is what no file holds; what a file holds -- above all
// the continuation brief an orchestrating session keeps current -- it names by
// path and drops, since the session reads the file again and a summary that
// restates it carries the same text twice for the rest of the context.
//
// IT NEVER BLOCKS. Exit 2 or a `{"decision": "block"}` reply skips a proactive
// compaction and fails the recovery compaction after a context-limit error, so
// the hook prints the same plain text on every input, reads stdin only to drain
// it, and exits 0 on every path, an unexpected error included.
//
// The facts above were driven against Claude Code 2.1.318:
// docs/notes/agent-hooks-and-scripts.md, Compaction hooks.

import { readEvent } from "./lib/event.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2027-05-31";

// The same on every input; the test holds it under the 10,000-character cut.
const INSTRUCTIONS = [
  "Write the summary for a session that reads its files again after the compaction.",
  "",
  "Keep, in the summary, what no file holds:",
  "- the owner's own words in this context that the continuation brief does not yet quote: instructions, rulings, corrections, and any question put to him and not yet answered;",
  "- the step in progress when the compaction came, and the next action it was about to take;",
  "- a decision being presented to the owner, and how far the presentation got;",
  "- the background agents and commands still running, by task id, with what each is for, and any result that arrived and has not been acted on.",
  "",
  "Drop what a file or the board already holds, naming the file by path instead:",
  "- the continuation brief's contents (scratch/continuation-*.md): the branches in flight, their review state, the shortlist and what comes next;",
  "- the text of .claude/orchestration/ruleset.md, CLAUDE.md, CONTRIBUTING.md, commands, briefs, reports, diffs, logs and tool output that can be read again;",
  "- board item bodies.",
  "",
  "Name the session's state (Working, Wind-down and the rest) only as the continuation brief records it.",
  "",
].join("\n");

function main() {
  readEvent();
  process.stdout.write(INSTRUCTIONS);
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0);
}
