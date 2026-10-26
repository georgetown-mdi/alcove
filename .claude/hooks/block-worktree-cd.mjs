#!/usr/bin/env node
// PreToolUse hook: refuse a Bash command that opens with `cd` into an agent
// worktree under .claude/worktrees/.
//
// Why this exists: the Bash tool's directory persists between calls, so a
// command beginning `cd <tree> && ...` does not scope that one call to the tree:
// it moves the session's working directory into it. A spawn that is not
// worktree-isolated may write only under the session's working directory, so
// the move puts later spawns, and the shells of runs already under way, in a
// tree that is not theirs. `env -C <tree> <command>` and `git -C <tree> <args>`
// scope the call and leave the session where it is, which is what the refusal
// names.
//
// What it refuses: a command whose FIRST token is `cd` and whose destination --
// either of zsh's two `cd` forms, resolved in lib/shell.mjs -- lies inside a
// single worktree under a `.claude/worktrees/` root. The two-argument form
// reaches a sibling worktree without naming it: from
// `.claude/worktrees/agent-a`, `cd a b` lands in `.claude/worktrees/agent-b`.
//
// What it allows by design:
//   - a `cd` into the tree the call is already being made from: the session is
//     already there, so nothing moves
//   - a `cd` to the `.claude/worktrees` root itself, which is no worktree
//   - a `cd` anywhere else -- /workspace, a /tmp rebase tree, a subdirectory
//
// What it cannot see: a `cd` that is not the command's first token, one whose
// target is a variable or a `~` path (neither is expanded here), and a
// directory change made by anything other than `cd`. A two-argument `cd` whose
// destination it cannot compute -- an argument holding a `$` or a `~`, an <old>
// that does not occur in the directory of the call -- is allowed the same way.
// The narrow match is the point: the observed shape is the leading `cd`, and a
// false positive on a wider one would cost a capability rather than a rephrase.
//
// Exit 0 allows the call; exit 2 blocks it and feeds stderr back to Claude. Any
// unexpected failure here falls through to exit 0 (fail open) so a bug in this
// hook can never wedge every Bash command.

import { resolve } from "node:path";

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { leadingCdDestination } from "./lib/shell.mjs";
import { isInside, worktreeContext } from "./lib/worktrees.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2027-06-30";

function block(tree) {
  process.stderr.write(
    `Blocked by block-worktree-cd hook: this command opens with a \`cd\` into ${tree}, ` +
      "which changes this session's working directory to that worktree for every later call. " +
      "Spawns that are not worktree-isolated may write only under the session's working " +
      "directory, so they would follow it into a tree that may already be another agent's.\n" +
      `Scope the call instead: \`env -C ${tree} <command>\`, or \`git -C ${tree} <args>\` ` +
      "for a git question about that tree.\n",
  );
  process.exit(2);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);

  const from = resolve(
    eventCwd(event) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  );
  const destination = leadingCdDestination(command, from);
  if (destination === null) process.exit(0);

  const context = worktreeContext(destination);
  if (context === null || context.tree === null) process.exit(0);
  if (isInside(from, context.tree)) process.exit(0); // already homed there

  block(context.tree);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never wedge Bash on an unexpected hook error
}
