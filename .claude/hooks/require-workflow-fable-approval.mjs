#!/usr/bin/env node
// PreToolUse hook: route a Workflow call whose script names Fable to a
// user-approval prompt. It is the sibling of require-fable-approval.mjs, which
// gates the Agent tool; a Workflow script reaches the same tier through its own
// agent() options, where no top-level tool input holds the model.
//
// Detection is textual and literal, over every part of the call the model can
// arrive in: the inline `script`, the file a `scriptPath` names (read from disk,
// a relative path against the call's cwd), and the serialized `args` the script
// reads (a script can pass `model: args.model` and hold the spelling in the args
// object of the same event). A `model:` key, quoted or bare, assigned a Fable
// spelling, or a quoted string that is itself a Fable spelling, asks.
//
// That is the whole of what a text scan can see, and the limits follow from it --
// all of them fail OPEN: a model value computed at run time (`model: tier` with
// the tier derived, `...options`) is invisible here; a `scriptPath` file that
// cannot be read, or that imports a module pinning Fable, shows only its own
// text; and a resume of an earlier run replays a script this hook never sees.
// The critical half for committed scripts is the static
// check (`npm run check:workflow-agent-models`), which fails any agent() call in a
// fenced js block under .claude/commands/, .claude/agents/, or .claude/skills/, or
// in a checked-in Workflow script (.claude/scripts/*-workflow.mjs), that does not
// pin a literal non-Fable tier -- within its own stated limits, a computed model
// value and a call reached through an alias. This hook covers the ad-hoc inline
// script, which no committed-file check can reach.
//
// Every path but a positive match exits 0 and allows the call: an unreadable or
// unparseable event, a tool other than Workflow, a call holding no script text,
// script file, or args, a script, file and args with no Fable spelling in them,
// an unreadable `scriptPath`, and any unexpected throw (the outer catch). Fable's real gate for the Agent tool is
// require-fable-approval.mjs; a false negative here costs an unprompted Workflow
// spawn, while a hook that wedged every Workflow call would cost far more.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ask, eventCwd, eventForTools, FABLE_ASK_TAIL } from "./lib/event.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2027-03-31";

// `model: 'fable'` / `"model": "claude-fable-5"` in any quote style (the key is
// quoted when the option rides in a JSON args object), plus a quoted string that
// is nothing but a Fable spelling, which reaches the option by another name. A
// spelling is `fable` or `claude-fable` with numeric version parts only, so a
// branch or file name that begins with fable passes.
const FABLE_PATTERNS = [
  /(?<![\w$])(?:model|(['"`])model\1)\s*:\s*(['"`])\s*(?:claude-)?fable(?:-\d+)*\s*\2/i,
  /(['"`])\s*(?:claude-)?fable(?:-\d+)*\s*\1/i,
];

const ASK_REASON =
  "This Workflow's script requests the Fable tier for one of its agents, which " +
  "needs your approval " +
  FABLE_ASK_TAIL;

// The text of the file a `scriptPath` names, resolved against the call's cwd, or
// null when the path is absent or the file cannot be read.
function scriptFileText(event) {
  const scriptPath = event?.tool_input?.scriptPath;
  if (typeof scriptPath !== "string" || scriptPath.length === 0) return null;
  try {
    return readFileSync(
      resolve(eventCwd(event) ?? process.cwd(), scriptPath),
      "utf8",
    );
  } catch {
    return null;
  }
}

function main() {
  const event = eventForTools("Workflow");
  if (event === null) process.exit(0); // unreadable, or another tool

  const script = event?.tool_input?.script;
  const args = event?.tool_input?.args;
  const texts = [];
  if (typeof script === "string" && script.length > 0) texts.push(script);
  const fileText = scriptFileText(event);
  if (fileText !== null) texts.push(fileText);
  if (args !== undefined && args !== null) {
    texts.push(typeof args === "string" ? args : JSON.stringify(args));
  }
  const namesFable = (text) =>
    typeof text === "string" &&
    FABLE_PATTERNS.some((pattern) => pattern.test(text));
  if (texts.some(namesFable)) ask(ASK_REASON);
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge a workflow on an unexpected error
}
