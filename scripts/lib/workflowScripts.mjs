// Reading the committed Workflow scripts, shared by the checks that hold a rule
// over them (check-workflow-agent-models.mjs, check-workflow-args-resolve.mjs).
//
// Those scripts come in two shapes: a fenced js block under .claude/commands/,
// .claude/agents/, or .claude/skills/, and a checked-in Workflow script a
// command invokes by path (.claude/scripts/*-workflow.mjs, whose whole file is
// the block). The lexer reads a block rather than pattern-matching it: strings,
// template literals, regex literals, and comments are read as tokens, so text
// inside them never reaches a check's structural scan.

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { jsBlocks } from "./markdownFences.mjs";
import { lineOf } from "./text.mjs";

export { lineOf };

/** The directories whose Markdown files hold fenced Workflow scripts. */
export const SOURCE_DIRS = [
  ".claude/commands",
  ".claude/agents",
  ".claude/skills",
];
/** The directory of checked-in Workflow scripts, and their file suffix. */
export const SCRIPT_DIR = ".claude/scripts";
export const SCRIPT_SUFFIX = "-workflow.mjs";

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

// Keywords a regex literal may directly follow; after any other identifier, a
// number, or a closing bracket, `/` is division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function regexAllowed(previous) {
  if (!previous) return true;
  switch (previous.kind) {
    case "ident":
      return REGEX_PRECEDING_KEYWORDS.has(previous.text);
    case "punct":
      return !")]}".includes(previous.text);
    case "templateStart":
    case "templateMiddle":
      return true;
    default:
      return false;
  }
}

// An unterminated string ends at the newline rather than running to the end of
// the block, so one stray quote cannot swallow every call after it.
function readString(code, start) {
  const quote = code[start];
  let i = start + 1;
  let value = "";
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      value += code[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === quote) return { end: i + 1, value };
    if (ch === "\n") return { end: i, value };
    value += ch;
    i++;
  }
  return { end: code.length, value };
}

// One run of template text, from a backtick or from the `}` that closes a
// substitution, up to the closing backtick (`closed`) or the next `${`.
function readTemplateChunk(code, start) {
  let i = start + 1;
  let raw = "";
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      raw += code[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "`") return { end: i + 1, raw, closed: true };
    if (ch === "$" && code[i + 1] === "{") {
      return { end: i + 2, raw, closed: false };
    }
    raw += ch;
    i++;
  }
  return { end: code.length, raw, closed: true };
}

function readRegex(code, start) {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return null;
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      i++;
      while (i < code.length && IDENT_PART.test(code[i])) i++;
      return { end: i };
    }
    i++;
  }
  return null;
}

/**
 * Lex a block of JavaScript into `{kind, text?, value?, start}` tokens, skipping
 * whitespace and comments. A string or a substitution-free template has its
 * `value`; a template with substitutions is split into templateStart /
 * templateMiddle / templateEnd around the tokens of each substitution, so braces
 * and parentheses inside template TEXT never reach the structural scan.
 */
export function tokenize(code) {
  const tokens = [];
  const braces = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      const newline = code.indexOf("\n", i);
      i = newline === -1 ? code.length : newline;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const { end, value } = readString(code, i);
      tokens.push({ kind: "string", value, start: i });
      i = end;
      continue;
    }
    if (ch === "`") {
      const chunk = readTemplateChunk(code, i);
      if (chunk.closed) {
        tokens.push({ kind: "template", value: chunk.raw, start: i });
      } else {
        tokens.push({ kind: "templateStart", start: i });
        braces.push("template");
      }
      i = chunk.end;
      continue;
    }
    if (ch === "}" && braces[braces.length - 1] === "template") {
      braces.pop();
      const chunk = readTemplateChunk(code, i);
      tokens.push({
        kind: chunk.closed ? "templateEnd" : "templateMiddle",
        start: i,
      });
      if (!chunk.closed) braces.push("template");
      i = chunk.end;
      continue;
    }
    if (ch === "{") {
      braces.push("brace");
      tokens.push({ kind: "punct", text: ch, start: i });
      i++;
      continue;
    }
    if (ch === "}") {
      if (braces[braces.length - 1] === "brace") braces.pop();
      tokens.push({ kind: "punct", text: ch, start: i });
      i++;
      continue;
    }
    if (ch === "/" && regexAllowed(tokens[tokens.length - 1])) {
      const regex = readRegex(code, i);
      if (regex) {
        tokens.push({ kind: "regex", start: i });
        i = regex.end;
        continue;
      }
    }
    if (IDENT_START.test(ch)) {
      let end = i + 1;
      while (end < code.length && IDENT_PART.test(code[end])) end++;
      tokens.push({ kind: "ident", text: code.slice(i, end), start: i });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[0-9a-zA-Z_.]/.test(code[end])) end++;
      tokens.push({ kind: "number", start: i });
      i = end;
      continue;
    }
    tokens.push({ kind: "punct", text: ch, start: i });
    i++;
  }
  return tokens;
}

/** Whether a token is the given punctuator. */
export const isPunct = (token, text) =>
  token?.kind === "punct" && token.text === text;

/**
 * The blocks of JavaScript a scanned file contains: the fenced js blocks of a
 * Markdown source, or the whole of a checked-in Workflow script, which is one
 * unfenced block of script body from its first line.
 */
export function codeBlocks(file, source) {
  return file.endsWith(".mjs")
    ? [{ code: source, startLine: 1 }]
    : jsBlocks(source);
}

/** Every Markdown file under the scanned directories, as repo-relative paths. */
export function sourceFiles(root, dirs = SOURCE_DIRS) {
  const files = [];
  const walk = (dir) => {
    const absolute = resolve(root, dir);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

/** Every checked-in Workflow script, as repo-relative paths. */
export function workflowScriptFiles(root, dir = SCRIPT_DIR) {
  const absolute = resolve(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((entry) => entry.endsWith(SCRIPT_SUFFIX))
    .map((entry) => `${dir}/${entry}`);
}
