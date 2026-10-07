#!/usr/bin/env node
// Workflow agent model-pin check: `npm run check:workflow-agent-models`, run
// by static_checks.yaml on every pull request. Scans the committed Workflow
// scripts in both shapes: a fenced js block under .claude/commands/,
// .claude/agents/ or .claude/skills/, and a whole
// .claude/scripts/*-workflow.mjs file. Fails unless every `agent(` call passes
// a literal `model:` from ALLOWED_TIERS at the top level of its own inline
// options object; a spread into that object, a computed or hoisted value, a
// non-call use of `agent`, and a pinned Fable each fail. The lexer, block
// reader and file listing are shared with check-workflow-args-resolve.mjs in
// scripts/lib/workflowScripts.mjs. Exit 0 clean, 1 on a finding or when no
// `agent(` call is found at all. Rationale and limits:
// docs/notes/repo-check-scripts.md.

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
