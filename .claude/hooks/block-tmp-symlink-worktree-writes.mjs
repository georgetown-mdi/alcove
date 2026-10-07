#!/usr/bin/env node
// PreToolUse hook on Bash: refuse a command that writes to a path spelled under
// /tmp when something below the scratch root redirects it, such as a stale
// symlink, and it resolves inside a git worktree. A `mktemp -d` directory
// resolves to itself and never matches, and a /tmp that is itself a symlink
// (macOS) is resolved before the comparison. A destination not spelled under
// /tmp passes.
//
// A write is a redirection target or a path operand of a command in
// WRITING_COMMANDS below. Removing the link itself (`rm /tmp/<name>`) is allowed,
// since that is the fix; a removal through it (a deeper operand, or a trailing
// slash) is a write. It reads a plain command line, so composition, paths known
// only at runtime, `xargs`, prefix words outside COMMAND_PREFIX_WORDS, and
// programs that write files of their own accord are not seen.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. An
// unexpected failure exits 0 (fail open). The incident and the full limits:
// docs/notes/agent-hooks-and-scripts.md.

import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { canonicalPath, nearestExistingDirectory } from "./lib/paths.mjs";
import { peelCommandPrefix, splitSegments, tokenize } from "./lib/shell.mjs";
import {
  isInside,
  isStrictlyInside,
  owningWorktree,
  worktreeRecords,
} from "./lib/worktrees.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

// The directories a path is scratch for being under, in both spellings each has,
// so a command naming the resolved form of a scratch root directly is read as
// scratch too.
const TMP_ROOTS = [
  ...new Set(["/tmp", tmpdir()].flatMap((root) => [root, canonicalPath(root)])),
];

// Commands whose path operands are files they create or overwrite. `sed` is here
// only for its in-place spelling; without one it writes to standard output, and
// the redirect that captures it is read on its own. `ln` and `rm` are each read
// by their own rule below, in `linkTargets` and `removalTargets`, since neither
// writes the path it is handed the way the rest do.
const WRITING_COMMANDS = new Set([
  "cp",
  "dd",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rsync",
  "sed",
  "tee",
  "touch",
  "truncate",
]);

// A redirection operator at the head of a token: an optional file descriptor or
// `&`, and one or two `>`. What follows it in the same token is the target when
// there is anything (`2>/tmp/log`); otherwise the target is the next token
// (`2> /tmp/log`).
const REDIRECT = /^(?:[0-9]+|&)?>{1,2}/;

// The noclobber override `>|` is the same redirection, written with a byte the
// stage splitting takes for a pipe -- which would otherwise leave the operator
// at the end of one stage and its target at the head of the next. Dropping the
// bar before anything is split keeps it one redirection.
const NOCLOBBER = />\|/g;

// dd names its operands by keyword rather than by position.
const DD_OPERAND = /^(?:of|if)=/;

// The flag naming the directory a command writes into, in its two spellings.
// The short one takes the rest of its own cluster as the directory when there is
// any (`-st DIR`, `-tDIR`), which is why the value is captured here rather than
// assumed to be the next word.
const TARGET_DIRECTORY_LONG = /^--target-directory(?:=(.*))?$/;
const TARGET_DIRECTORY_SHORT = /^-[a-zA-Z]*?t(.*)$/;

// The commands that take that flag. Read for no other command, since `-t` names
// something else entirely elsewhere (`touch -t STAMP`).
const TARGET_DIRECTORY_COMMANDS = new Set(["cp", "install", "ln", "mv"]);

// One trailing slash or more at the end of a path, which decides whether `rm`
// operates on a final symlink or through it.
const TRAILING_SLASHES = /\/+$/;

function isPathOperand(token) {
  return token.length > 0 && !token.startsWith("-");
}

// The command a segment invokes and its arguments, with leading assignments and
// prefix words peeled off; null when the segment invokes nothing. A flag that
// belongs to a prefix word is stepped over; the value such a flag can take
// (`sudo -u NAME`) then stands where the command word belongs and is read as the
// command, which loses a write rather than inventing one.
function invocation(tokens) {
  const { index } = peelCommandPrefix(tokens);
  const word = tokens[index];
  if (word === undefined) return null;
  return { name: basename(word), args: tokens.slice(index + 1) };
}

// Every redirection target on a segment. A token whose remainder begins with `&`
// is a descriptor duplication (`2>&1`), which names no file.
function redirectionTargets(tokens) {
  const targets = [];
  for (const [index, token] of tokens.entries()) {
    const operator = REDIRECT.exec(token);
    if (operator === null) continue;
    const remainder = token.slice(operator[0].length);
    const target = remainder.length > 0 ? remainder : tokens[index + 1];
    if (target !== undefined && !target.startsWith("&")) targets.push(target);
  }
  return targets;
}

function isInPlaceFlag(arg) {
  return (
    arg === "--in-place" ||
    arg.startsWith("--in-place=") ||
    /^-[a-hj-z]*i/.test(arg)
  );
}

// A command's operands and the directory its target-directory flag names, with
// `--` ending option parsing. A flag this does not know is stepped over and
// nothing else is, so the value of one standing as its own word is read as an
// operand -- an extra candidate path, never a lost one.
function operandsAndDirectory(args, readsTargetDirectory) {
  const operands = [];
  let directory = null;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    index++;
    if (arg === "--") {
      operands.push(...args.slice(index));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      operands.push(arg);
      continue;
    }
    if (!readsTargetDirectory) continue;
    const long = TARGET_DIRECTORY_LONG.exec(arg);
    const short = TARGET_DIRECTORY_SHORT.exec(arg);
    if (long === null && short === null) continue;
    const attached = long === null ? short[1] : (long[1] ?? "");
    directory = attached.length > 0 ? attached : (args[index++] ?? null);
  }
  return { operands, directory };
}

// The path an `ln` call creates. `ln [-s] TARGET LINK_NAME` writes LINK_NAME
// alone: TARGET is text the new link holds, which `ln` neither reads nor writes,
// so reading it as a write refuses a command that touches nothing. Two or more
// operands write the last one -- the link name, or the directory the links are
// made in; one operand writes the link named after it in the current directory;
// `-t DIRECTORY` writes into that directory instead. A shape not read here names
// no write, the way a fail-open guard must.
function linkTargets(args) {
  const { operands, directory } = operandsAndDirectory(args, true);
  if (directory !== null) return [directory];
  if (operands.length > 1) return [operands[operands.length - 1]];
  if (operands.length === 1) return [basename(operands[0])];
  return [];
}

// The directory each operand of an `rm` call is removed from, which is what the
// removal reaches into. `rm` does not follow a symlink named as its own operand,
// so `rm /tmp/<name>` takes the link and the directory read here is the scratch
// directory holding it -- no redirect, and the fix this hook recommends. A
// trailing slash makes `rm` operate on the directory the link points at
// (`rm -rf /tmp/<name>/` empties it and leaves the link), so that shape reads the
// operand itself, the same as a deeper operand reads the link above it. Measured
// against GNU coreutils 9.1.
function removalTargets(args) {
  return operandsAndDirectory(args, false)
    .operands.filter(isPathOperand)
    .map((operand) => {
      const trimmed = operand.replace(TRAILING_SLASHES, "");
      if (trimmed === operand) return dirname(operand);
      return trimmed.length > 0 ? trimmed : "/";
    });
}

// The paths a writing command names. Every path operand counts, the sources of a
// copy included: a source read through a resolved-away /tmp path is the same
// mistake reaching the same file, and which operand is the destination varies by
// command and flag. The directory a target-directory flag names counts with
// them. `ln` and `rm` are the exceptions, read by the rules above.
function writingCommandTargets(tokens) {
  const command = invocation(tokens);
  if (command === null || !WRITING_COMMANDS.has(command.name)) return [];
  if (command.name === "sed" && !command.args.some(isInPlaceFlag)) return [];
  if (command.name === "ln")
    return linkTargets(command.args).filter(isPathOperand);
  if (command.name === "rm") return removalTargets(command.args);
  const { operands, directory } = operandsAndDirectory(
    command.args,
    TARGET_DIRECTORY_COMMANDS.has(command.name),
  );
  return [...(directory === null ? [] : [directory]), ...operands]
    .map((arg) => arg.replace(DD_OPERAND, ""))
    .filter(isPathOperand);
}

function writeTargets(command) {
  return splitSegments(command.replace(NOCLOBBER, ">")).flatMap((segment) => {
    const tokens = tokenize(segment);
    return [...redirectionTargets(tokens), ...writingCommandTargets(tokens)];
  });
}

function isUnderTmp(path) {
  return TMP_ROOTS.some((root) => isInside(path, root));
}

/** The scratch root a path lies under, or null when it lies under none. */
function tmpRootOf(path) {
  return TMP_ROOTS.find((root) => isStrictlyInside(path, root)) ?? null;
}

// Where the path would resolve if nothing below its scratch root redirected it:
// the root resolved once, the rest of the path appended unchanged. A path whose
// own resolution differs from this passes through a symlink somewhere under
// scratch.
function unredirected(path, root) {
  return join(canonicalPath(root), relative(root, path));
}

// Whether `path` exists on disk and is itself a directory. False for anything
// that does not exist, the way a fail-open guard must -- a `statSync` failure
// here means "ask the parent instead", not "block".
function isExistingDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The worktree a path lies in, or null when it lies in none and when git will
// not answer at all: no git, a path outside every repository, a directory that
// is gone. Every unanswerable state allows, the way a fail-open guard must.
//
// A path that is itself an existing directory is asked about from itself, not
// from its parent: a write target that resolves exactly to a worktree root is a
// directory, and its parent can sit outside every repository (the main
// worktree's own parent) or inside a different, enclosing one (a linked
// worktree's parent, the main worktree) -- either way the wrong answer. Every
// other path -- a file, or one nothing below it has created yet -- still asks
// from the nearest existing ancestor, since the path itself cannot be asked.
function worktreeOf(path) {
  const directory = isExistingDirectory(path)
    ? path
    : nearestExistingDirectory(path);
  if (directory === null) return null;
  const records = worktreeRecords(directory);
  if (records === null) return null;
  const paths = records.map((record) => canonicalPath(record.path));
  return owningWorktree(path, paths) ?? null;
}

function block(target, resolved, worktree) {
  process.stderr.write(
    `Blocked by block-tmp-symlink-worktree-writes hook: '${target}' is written as scratch under ` +
      `/tmp, but it resolves to '${resolved}', inside the git worktree at '${worktree}'. This ` +
      "write would land on repository content instead of on scratch, and every command on the " +
      "line would still report success. A fixed /tmp name left behind as a symlink by an " +
      "earlier session is how a path does this. Create the scratch directory with `mktemp -d` " +
      "and write under the path it prints, never a fixed /tmp name. If that leftover link is " +
      "what this tripped over, remove it (`rm <link>`, which this hook allows) and start again " +
      "from a fresh `mktemp -d`. Name the link itself and give it no trailing slash: a trailing " +
      "slash empties what it points at instead. If the destination really is in the repository, " +
      "write it by its own path rather than through /tmp.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);

  const cwd = eventCwd(event) ?? process.cwd();
  // Nothing on a line that names no scratch directory, run from outside one, can
  // resolve out of scratch, and skipping it keeps the filesystem probes below off
  // every unrelated Bash call.
  if (!TMP_ROOTS.some((root) => command.includes(root)) && !isUnderTmp(cwd)) {
    process.exit(0);
  }

  for (const target of writeTargets(command)) {
    const path = resolve(cwd, target);
    const root = tmpRootOf(path);
    if (root === null) continue;
    const resolved = canonicalPath(path);
    if (resolved === unredirected(path, root)) continue;
    const worktree = worktreeOf(resolved);
    if (worktree !== null) block(target, resolved, worktree);
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
