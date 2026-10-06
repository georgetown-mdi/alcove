#!/usr/bin/env node
// PreToolUse hook on Edit, Write and NotebookEdit: refuse a write to a path git
// does not ignore in a checkout of this repository that the session is not
// working in -- the MAIN worktree always, whoever writes, and a sibling worktree
// when the session is itself working inside a linked one. Paths git ignores
// (scratch/, briefs, round artifacts) and paths outside the repository pass.
//
// Ignored-ness is asked of `git check-ignore` in the worktree that owns the path,
// so a new file and an edit to a tracked one are refused alike; a gitignored
// symlink into another tree resolves to its target's checkout first. The
// session's tree is the event's cwd, and a cwd no worktree contains leaves the
// sibling rule silent. Only file_path and notebook_path are read; a write made
// through Bash is not gated.
//
// Override: create the sentinel file OVERRIDE_SENTINEL names in that checkout,
// which allows writes there until the file is deleted.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude.
// Every state it cannot answer allows (fail open). Rationale:
// docs/notes/agent-hooks-and-scripts.md.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { eventCwd, eventForTools } from "./lib/event.mjs";
import { canonicalPath, nearestExistingDirectory } from "./lib/paths.mjs";
import { owningWorktree, worktreeRecords } from "./lib/worktrees.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

const GUARDED_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "notebook_path"];
const OVERRIDE_SENTINEL = join(
  ".claude",
  "allow-primary-checkout-writes.local",
);

// The remedy depends on where the session stands. A session working in a
// linked worktree is pointed at the same path in its own tree. One in the main
// worktree is pointed at a branch's tree and told to scope commands with
// `env -C` or `git -C`, since block-worktree-cd.mjs refuses a leading `cd`
// into the tree.
function mainWorktreeRemedy(path, mainRoot, sessionTree) {
  if (sessionTree !== undefined && sessionTree !== mainRoot) {
    return (
      `Did you mean '${join(sessionTree, relative(mainRoot, path))}', in the ` +
      "worktree this session is working in? "
    );
  }
  return (
    "Work on a branch belongs in that branch's own worktree -- write to the absolute path " +
    "under .claude/worktrees/<tree>/ instead, and scope every command to it " +
    "(`env -C <tree> <command>` or `git -C <tree> ...`). "
  );
}

function blockMainWorktreeWrite(target, path, mainRoot, sessionTree) {
  process.stderr.write(
    `Blocked by block-primary-checkout-writes hook: '${target}' is repository content of the ` +
      `main worktree at '${mainRoot}', which no session writes -- only paths git ignores there ` +
      "(scratch/, briefs, round artifacts) are writable, whether the file exists yet or not. " +
      mainWorktreeRemedy(path, mainRoot, sessionTree) +
      "A file written here would land on whatever " +
      "branch the primary checkout holds, off the branch under review, where no review round " +
      "and no pull request will include it. For a deliberate, maintainer-directed edit of this " +
      `checkout, create '${OVERRIDE_SENTINEL}' in it and delete it when you are done.\n`,
  );
  process.exit(2);
}

function blockSiblingWorktreeWrite(target, path, owner, sessionTree) {
  process.stderr.write(
    `Blocked by block-primary-checkout-writes hook: '${target}' is repository content of the ` +
      `worktree at '${owner}', but this session is working in '${sessionTree}'. The file tools ` +
      "take the path literally and are not rooted to the working directory, so this would edit " +
      "another branch's checkout, where every unmodified file looks identical and the write " +
      "shows up only as an unexplained diff on that branch. Did you mean " +
      `'${join(sessionTree, relative(owner, path))}'? For a deliberate edit of the other ` +
      `worktree, create '${OVERRIDE_SENTINEL}' in it and delete it when you are done.\n`,
  );
  process.exit(2);
}

function targetPath(toolInput, cwd) {
  for (const key of PATH_KEYS) {
    const value = toolInput?.[key];
    if (typeof value === "string" && value.length > 0) {
      return resolve(cwd ?? ".", value);
    }
  }
  return null;
}

// Worktree paths of the repository the directory belongs to, main worktree
// first, each resolved through its symlinks the way a target path is; null when
// git would not answer.
function worktreePaths(directory) {
  const records = worktreeRecords(directory);
  return records === null
    ? null
    : records.map((record) => canonicalPath(record.path));
}

// The worktree the session itself is working in, or undefined when its directory
// cannot be placed in one -- an event holding no cwd, or one outside this
// repository. Undefined leaves the sibling rule silent.
function sessionWorktree(cwd, paths) {
  if (cwd === null) return undefined;
  return owningWorktree(canonicalPath(cwd), paths);
}

// Whether git ignores the path: true, false, or null when git declines to
// answer at all (exit 128, a missing binary), which allows like every other
// unanswerable state. `check-ignore` exits 1 -- a real answer of "not ignored"
// -- for a path no exclude pattern covers and for every tracked file, since it
// consults the index. It takes pathnames rather than pathspecs, so no `:(...)`
// magic is passed: git answers 128 to it.
function isIgnored(root, path) {
  const relativePath = relative(root, path);
  if (relativePath.length === 0 || relativePath.startsWith("..")) return null;
  try {
    execFileSync(
      "git",
      ["-C", root, "check-ignore", "--quiet", "--", relativePath],
      { stdio: "ignore" },
    );
    return true;
  } catch (error) {
    return error?.status === 1 ? false : null;
  }
}

function main() {
  const event = eventForTools(...GUARDED_TOOLS);
  if (event === null) process.exit(0); // unreadable, or another tool

  const cwd = eventCwd(event);
  const target = targetPath(event.tool_input, cwd);
  if (target === null) process.exit(0);
  const path = canonicalPath(target);

  const directory = nearestExistingDirectory(path);
  if (directory === null) process.exit(0);
  const paths = worktreePaths(directory);
  if (paths === null) process.exit(0);

  const mainRoot = paths[0];
  const owner = owningWorktree(path, paths);
  if (owner === undefined) process.exit(0); // outside every checkout of this repo

  const sessionTree = sessionWorktree(cwd, paths);
  const writesAnotherWorktree =
    sessionTree !== undefined &&
    sessionTree !== mainRoot &&
    sessionTree !== owner;
  if (owner !== mainRoot && !writesAnotherWorktree) process.exit(0);

  if (existsSync(join(owner, OVERRIDE_SENTINEL))) process.exit(0);
  if (isIgnored(owner, path) !== false) process.exit(0);

  if (owner === mainRoot) {
    blockMainWorktreeWrite(target, path, mainRoot, sessionTree);
  } else {
    blockSiblingWorktreeWrite(target, path, owner, sessionTree);
  }
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge every edit on an unexpected hook error
}
