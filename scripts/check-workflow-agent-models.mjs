#!/usr/bin/env node
// Workflow agent model-pin check, run by static_checks.yaml on every PR.
//
// A Workflow script's `agent(prompt, {...})` call that omits `model` does not
// fall back to the agent definition's pinned tier -- it inherits the session
// model, silently, wherever the script happens to be run from. The tiering rule
// in CLAUDE.md is therefore only as good as the pins written into the scripts
// themselves, and prose cannot assert that every call has one.
//
// The PreToolUse hooks that gate the Agent tool see none of this: the model lives
// inside a script string, not a top-level tool input. So the pin is encoded as a
// check over the committed scripts. Those come in two shapes, both scanned here:
// a fenced js block under .claude/commands/, .claude/agents/, or .claude/skills/,
// and a checked-in Workflow script a command invokes by path
// (.claude/scripts/*-workflow.mjs, whose whole file is the block -- it is a script
// body, not a module, so it is not linted and cannot be imported). Every `agent(`
// call in either must pass a literal `model:` from the tier set in its own options
// object, and Fable (which requires the owner's per-spawn approval and is never
// inherited) may not be pinned in a committed script at all. That options object
// is spelled out in the call: a spread into it can include a `model` of its own and
// decide the tier at run time, so the spread is itself a violation whether or not
// a literal sits beside it.
//
// The lexer, the block reader, and the file listing are the shared ones in
// scripts/lib/workflowScripts.mjs, which check-workflow-args-resolve.mjs also
// reads for its own rule over the same two script shapes.
//
// The scan lexes a block rather than pattern-matching it: strings, template
// literals, regex literals, and comments are read as tokens, so a `model: 'opus'`
// sitting in a prompt template or a comment is not a pin, and a parenthesis inside
// a string cannot run one call's extent into the next. A pin counts only at the
// top level of the call's own options object, so a nested call's pin cannot stand
// in for its caller's.
//
// What the scan cannot see, exactly:
//   - a computed model value (`model: tier`) resolves only at run time; it is
//     treated as no pin at all and is reported as one. A hoisted options const is
//     treated the same way, by design -- the convention is an inline literal in
//     the call.
//   - `agent` reached under another name. A non-call use of the identifier is
//     itself reported, because the scan cannot follow it; but a binding taken off
//     a property (`const spawn = deps.agent`) is a member access, which this check
//     leaves alone, and a call through that binding is invisible -- as is a call
//     made straight through the member access (`deps.agent(...)`).
//   - a js fence nested inside another fence. The outer fence's info string decides
//     the block, so js nested in a markdown block -- documentation whose examples
//     are themselves Workflow scripts -- is not scanned at all.
//   - a script that is neither shape: an ad-hoc inline Workflow script, or a file
//     passed by scriptPath from outside .claude/scripts/*-workflow.mjs. The
//     require-workflow-fable-approval.mjs hook covers the inline form for Fable.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCRIPT_DIR,
  SCRIPT_SUFFIX,
  SOURCE_DIRS,
  codeBlocks,
  isPunct,
  lineOf,
  sourceFiles,
  tokenize,
  workflowScriptFiles,
} from "./lib/workflowScripts.mjs";

const ALLOWED_TIERS = ["opus", "sonnet", "haiku"];
const SUMMARY_LENGTH = 100;

// Index of the `)` balancing the `(` at openIndex, or -1 when the call never
// closes (a truncated block).
function matchingParen(tokens, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (isPunct(tokens[i], "(")) depth++;
    else if (isPunct(tokens[i], ")")) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function argumentSpans(tokens, openIndex, closeIndex) {
  const spans = [];
  let depth = 0;
  let start = openIndex + 1;
  for (let i = start; i < closeIndex; i++) {
    const token = tokens[i];
    if (token.kind !== "punct") continue;
    if ("([{".includes(token.text)) depth++;
    else if (")]}".includes(token.text)) depth--;
    else if (token.text === "," && depth === 0) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start < closeIndex) spans.push({ start, end: closeIndex });
  return spans;
}

const literalValue = (token) =>
  token?.kind === "string" || token?.kind === "template"
    ? token.value
    : undefined;

// What a call's options object -- its second argument, and only when that
// argument is an object literal spelled out in the call -- pins at its top level:
// the `model` literals it writes, and whether it spreads anything in. A key may be
// quoted; a value that is not a string or a substitution-free template is not a
// literal and yields nothing, so the call is treated as unpinned. A spread nested
// deeper cannot reach the top-level `model` key, so only a top-level one counts.
function optionsPins(tokens, openIndex, closeIndex) {
  const options = argumentSpans(tokens, openIndex, closeIndex)[1];
  if (
    !options ||
    !isPunct(tokens[options.start], "{") ||
    !isPunct(tokens[options.end - 1], "}")
  ) {
    return { models: [], spread: false };
  }

  const models = [];
  let spread = false;
  let depth = 0;
  for (let i = options.start + 1; i < options.end - 1; i++) {
    const token = tokens[i];
    if (token.kind === "punct") {
      if ("([{".includes(token.text)) depth++;
      else if (")]}".includes(token.text)) depth--;
      else if (
        depth === 0 &&
        token.text === "." &&
        isPunct(tokens[i + 1], ".") &&
        isPunct(tokens[i + 2], ".")
      ) {
        spread = true;
      }
      continue;
    }
    if (depth !== 0) continue;
    const key = token.kind === "ident" ? token.text : literalValue(token);
    if (key !== "model" || !isPunct(tokens[i + 1], ":")) continue;
    const value = literalValue(tokens[i + 2]);
    if (value !== undefined) models.push(value);
  }
  return { models, spread };
}

function summarize(text) {
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > SUMMARY_LENGTH
    ? `${firstLine.slice(0, SUMMARY_LENGTH - 3)}...`
    : firstLine;
}

/**
 * Every appearance of the injected `agent` binding in a block, in source order,
 * as `{kind: "call" | "alias", text, line}`; a call also has the literal
 * `models` its options object pins and whether that object `spread`s anything in.
 * A member access (`runner.agent`) is somebody else's method and is not an
 * appearance at all.
 */
export function agentUses(code) {
  const tokens = tokenize(code);
  const uses = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident" || token.text !== "agent") continue;
    if (isPunct(tokens[i - 1], ".")) continue;
    const line = lineOf(code, token.start);
    if (!isPunct(tokens[i + 1], "(")) {
      const lineStart = code.lastIndexOf("\n", token.start) + 1;
      uses.push({
        kind: "alias",
        text: summarize(code.slice(lineStart)),
        line,
      });
      continue;
    }
    const close = matchingParen(tokens, i + 1);
    const end = close === -1 ? code.length : tokens[close].start + 1;
    uses.push({
      kind: "call",
      text: code.slice(token.start, end),
      line,
      ...optionsPins(tokens, i + 1, close === -1 ? tokens.length : close),
    });
  }
  return uses;
}

/** Every `agent(...)` call in a block of code, in source order. */
export function agentCalls(code) {
  return agentUses(code).filter((use) => use.kind === "call");
}

/** The literal `model` values a single call's options object pins. */
export function pinnedModels(callText) {
  return agentCalls(callText)[0]?.models ?? [];
}

/**
 * Every way a source file's Workflow agent spawns can be off the tiering rule,
 * as `{file, line, problem}` triples. Empty means every call pins a literal tier.
 */
export function modelViolations(file, source) {
  const violations = [];
  for (const block of codeBlocks(file, source)) {
    for (const use of agentUses(block.code)) {
      const line = block.startLine + use.line - 1;
      const where = `${file}:${line}`;
      if (use.kind === "alias") {
        violations.push({
          file,
          line,
          problem: `${where}: \`${use.text}\` uses \`agent\` as a value rather than calling it; the tier pin is read off the call's own options object, so aliasing defeats this check -- spawn through a direct \`agent(...)\` call`,
        });
        continue;
      }
      if (use.spread) {
        violations.push({
          file,
          line,
          problem: `${where}: \`${summarize(use.text)}\` spreads into its options object, which can carry a \`model\` of its own and decide the tier at run time -- write the options out in the call with a literal \`model:\``,
        });
        continue;
      }
      if (use.models.length === 0) {
        violations.push({
          file,
          line,
          problem: `${where}: \`${summarize(use.text)}\` passes no literal \`model:\` in its options object, so it inherits the session model rather than the tier the round intended -- pin one of ${ALLOWED_TIERS.join(", ")}`,
        });
        continue;
      }
      for (const model of use.models) {
        if (ALLOWED_TIERS.includes(model)) continue;
        const fable = /fable/i.test(model)
          ? " -- Fable needs the owner's explicit per-spawn approval and is never pinned in a committed script"
          : "";
        violations.push({
          file,
          line,
          problem: `${where}: \`${summarize(use.text)}\` pins \`model: '${model}'\`, which is not one of ${ALLOWED_TIERS.join(", ")}${fable}`,
        });
      }
    }
  }
  return violations;
}

/** Count the `agent(` calls a source contains, for the pattern-rot guard. */
export function agentCallCount(file, source) {
  return codeBlocks(file, source).reduce(
    (total, block) => total + agentCalls(block.code).length,
    0,
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [...sourceFiles(root), ...workflowScriptFiles(root)];
  const scanned = `${SOURCE_DIRS.join(", ")}, ${SCRIPT_DIR}/*${SCRIPT_SUFFIX}`;
  const violations = [];
  let calls = 0;
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    calls += agentCallCount(file, source);
    violations.push(...modelViolations(file, source));
  }
  if (calls === 0) {
    console.error(
      `${scanned}: no \`agent(\` call was found in any scanned block. If you changed how Workflow scripts call agents, update the pattern in scripts/check-workflow-agent-models.mjs to read the new form.`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const { problem } of violations) console.error(problem);
    process.exit(1);
  }
  console.log(
    `Workflow agent model check passed: ${calls} agent() calls across ${files.length} files in ${scanned} each pin a literal ${ALLOWED_TIERS.join("/")} model.`,
  );
}
