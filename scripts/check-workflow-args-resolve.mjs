#!/usr/bin/env node
// Workflow args-resolve check: `npm run check:workflow-args-resolve`, run by
// static_checks.yaml on every pull request. Scans the committed Workflow
// scripts in the two shapes check-workflow-agent-models.mjs scans, through the
// block reader and lexer in scripts/lib/workflowScripts.mjs: a fenced js block
// under .claude/commands/, .claude/agents/ or .claude/skills/, and a whole
// .claude/scripts/*-workflow.mjs file. Fails on any read of the injected
// `args` binding other than `resolveWorkflowArgs(args)`, taking an alias of it
// included, so every field is read off what that call returns. An `args` in a
// string, template, comment or prose is not a read. The resolver's own
// behavior is pinned by .claude/scripts/light-review-script.test.mjs and
// .claude/scripts/panel-script.test.mjs. Exit 0 clean, 1 on a finding or
// when no `resolveWorkflowArgs(args)` call is found at all. Rationale and
// limits: docs/notes/repo-check-scripts.md.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codeBlocks,
  isPunct,
  lineOf,
  sourceFiles,
  tokenize,
  workflowScriptFiles,
} from "./lib/workflowScripts.mjs";

const ARGS = "args";
const RESOLVER = "resolveWorkflowArgs";
const CANONICAL = `${RESOLVER}(${ARGS})`;
const SUMMARY_LENGTH = 100;

// The canonical resolve is the whole call: `args` is inside one only when it is
// the entire argument list, so `resolveWorkflowArgs(args.role)` does not qualify.
// Nor does a member call -- `obj.resolveWorkflowArgs(args)` names somebody
// else's function that merely shares the resolver's name.
function isCanonicalResolve(tokens, index) {
  const before = tokens[index - 2];
  return (
    before?.kind === "ident" &&
    before.text === RESOLVER &&
    !isPunct(tokens[index - 3], ".") &&
    isPunct(tokens[index - 1], "(") &&
    isPunct(tokens[index + 1], ")")
  );
}

// `deps.args` is somebody else's property rather than the injected binding. The
// leading dots of a spread are not a member access, so `...args` is excluded from
// this exemption and reported as the read it is.
const isMemberAccess = (tokens, index) =>
  isPunct(tokens[index - 1], ".") && !isPunct(tokens[index - 2], ".");

function summarizeLine(code, index) {
  const start = code.lastIndexOf("\n", index) + 1;
  const end = code.indexOf("\n", index);
  const line = code.slice(start, end === -1 ? code.length : end).trim();
  return line.length > SUMMARY_LENGTH
    ? `${line.slice(0, SUMMARY_LENGTH - 3)}...`
    : line;
}

/**
 * Every read of the injected `args` binding in a block of code that is not the
 * canonical resolve call, as `{line, text}` in source order.
 */
export function looseArgsReads(code) {
  const tokens = tokenize(code);
  const reads = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident" || token.text !== ARGS) continue;
    if (isMemberAccess(tokens, i)) continue;
    if (isCanonicalResolve(tokens, i)) continue;
    reads.push({
      line: lineOf(code, token.start),
      text: summarizeLine(code, token.start),
    });
  }
  return reads;
}

/** How many canonical `resolveWorkflowArgs(args)` calls a block holds. */
export function canonicalResolveCount(code) {
  const tokens = tokenize(code);
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident" || token.text !== ARGS) continue;
    if (isCanonicalResolve(tokens, i)) count++;
  }
  return count;
}

/**
 * Every way a source file reads the injected `args` binding around the canonical
 * resolve, as `{file, line, problem}` triples. Empty means the file resolves its
 * arguments once and reads every field off the result.
 */
export function resolveViolations(file, source) {
  const violations = [];
  for (const block of codeBlocks(file, source)) {
    for (const read of looseArgsReads(block.code)) {
      const line = block.startLine + read.line - 1;
      violations.push({
        file,
        line,
        problem: `${file}:${line}: \`${read.text}\` reads \`${ARGS}\` outside the canonical \`${CANONICAL}\` resolve, so an unusable delivery reads as \`undefined\` field by field instead of failing -- take every field off the value that call returns`,
      });
    }
  }
  return violations;
}

/** Count the canonical resolves a source holds, for the pattern-rot guard. */
export function resolveCount(file, source) {
  return codeBlocks(file, source).reduce(
    (total, block) => total + canonicalResolveCount(block.code),
    0,
  );
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [...sourceFiles(root), ...workflowScriptFiles(root)];
  const violations = [];
  let resolves = 0;
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    resolves += resolveCount(file, source);
    violations.push(...resolveViolations(file, source));
  }
  if (resolves === 0) {
    console.error(
      `no \`${CANONICAL}\` call was found in any committed Workflow script. If a script still resolves its arguments, update the pattern in scripts/check-workflow-args-resolve.mjs to read the form it uses; if none does any longer, delete this check.`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const { problem } of violations) console.error(problem);
    process.exit(1);
  }
  console.log(
    `Workflow args resolve check passed: ${resolves} \`${CANONICAL}\` calls across ${files.length} scanned files, and no other read of \`${ARGS}\`.`,
  );
}
