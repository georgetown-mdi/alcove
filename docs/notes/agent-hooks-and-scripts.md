---
title: "Agent Hooks and Session Scripts: Design Rationale"
---

# Agent hooks and session scripts: why each has the shape it has

_Status: decided and built.
Each hook's or session script's header states its contract: what it refuses or decides, what it reads, its exit, and what to do when refused.
This note holds the reasoning behind those contracts: the incident or failure each exists for, the alternatives measured and declined, and the limits each accepts.
See [docs/notes/README.md](README.md)._

## Non-executable-delta verifier

[`.claude/scripts/verify-nonexecutable-delta.mjs`](../../.claude/scripts/verify-nonexecutable-delta.mjs)

### Why it is mechanical

[`assess-review.md`](../../.claude/commands/assess-review.md), Step 4, lets a head be re-attested without a fresh review round when its diff against the reviewed sha changes no executable line.
Nothing in CI can catch a false claim of that property:
`npm run check:pr-checklist` compares the attested sha against the head and has no view of whether the property holds,
so an eyeballed "comment-only" lands an unreviewed head as reviewed.

### Primitives measured wrong

The comparison parses each side to a TypeScript `SourceFile` and prints it back with comments suppressed.
Two cheaper primitives were measured wrong, and the colocated test pins both failure modes against the installed TypeScript:

- the compiler's emit erases type positions along with comments, so a type-only edit compares identical;
- a raw scanner has no parser context, so a backtick inside a comment puts it in template state and a comment-only edit reads as a change.

For YAML, a comparison key built by stringifying the value was measured wrong the same way.
`JSON.stringify` writes NaN, Infinity, -Infinity and null all as `null`,
and an own-keys walk writes every Date and every Set as the same empty object,
so a real value change in any of them would pass as comment-only.
The deep comparison treats mapping key order as insignificant, as YAML does, and keeps sequence order.
`uniqueKeys` and `strict` are passed although both default on, so a future default change cannot loosen the check.

### Why the refusals fail closed

A verifier backing an attestation must not report HOLDS over a file it did not examine,
so every path that is not markdown, source, or YAML is unverifiable rather than accepted as "not a JS/TS extension".
The YAML refusals each have a soundness probe:
a multi-document stream, because documents are not aligned across two streams;
a document with a parse diagnostic, a duplicate key among them, which lands in `doc.errors` rather than resolving last-wins;
and a document that parses clean but cannot be materialized,
since an unresolved alias throws out of `toJS()`, an alias bomb trips the package's resource cap,
and a self-referencing anchor comes back circular with no diagnostic.
Each refusal is a reason on its own path's verdict, so one unreadable file leaves every other path with a verdict.

A chmod leaves the blob identical, so modes come off the diff record.
A mode change between two existing sides is unverifiable whatever the extension: the comparison reads programs and cannot say whether making one runnable is harmless.
Rename detection is off, so a moved module counts as a changed program on both paths.

### Which tree the verdict is about

Every ref short of a full sha is per-worktree.
The primary checkout's copy is routinely called by absolute path while the branch under review sits in a linked worktree,
so binding git to the script's own location would resolve HEAD, HEAD~n and ORIG_HEAD against a tree nobody named.
A full sha hides the mistake, because linked worktrees share one object database.
Commands run at the worktree's top level, which was measured to matter both ways:
under `diff.relative` a run from a subdirectory drops every changed path outside it and reports a vacuous HOLDS,
and the `--raw` paths are root-relative only from the top level, which is what `git show <ref>:<path>` reads.

### Limits

Markdown content is exempt wholesale, including a fenced code block an operator would copy out.
The printer's normalizations (whitespace, blank lines, indentation, quote style, ASI semicolons, trailing commas, numeric literal form) compare equal, each pinned by the test.
The soundness probes run before every comparison, so an attestation proves soundness on the TypeScript and `yaml` actually installed rather than trusting that CI ran the suite.

## Worktree deletion guard

[`.claude/hooks/block-worktree-deletions.mjs`](../../.claude/hooks/block-worktree-deletions.mjs)

### The incident

A spawned agent ran `rm -rf` across two live sibling worktrees mid-session and destroyed the uncommitted work in both.
The trees are siblings on one filesystem and every session can reach all of them by path,
and the loss is unrecoverable: work never committed has no branch, stash, or reflog behind it.

### What it leaves open, and why

- `git worktree remove` without `--force`: git's own refusal on a tree with uncommitted work is the guard, and that spelling is how a finished tree is retired.
- `git clean -fdx` in a directory that merely holds worktrees, which real git answers with "Skipping repository" for each nested one.
  A doubled force, or a single force while some directory under the guarded root no longer resolves as a repository, is refused,
  since git skips a repository rather than a path and an orphaned tree goes with a single force.
- Anything strictly inside the session's own tree.

### Which tree a session owns

Two answers, and both are needed.
The harness names an isolated agent's tree after its agent id, so that tree is the session's wherever it stands.
A session standing in a tree is working there, and clearing its own probes and artifacts is that work.
Nothing readable says whether a session belongs in the tree it stands in,
so a session handed a tree, one that walked in, and one that cd'ed into a sibling on the same line are one case.
An orchestrator in the primary checkout has no agent id and stands in no tree, so every tree stays guarded from it.

### Questions put to real git

Whether a directory still resolves as a repository, and whether a config file has turned `clean.requireForce` off,
are asked of git rather than modelled from its on-disk layout or configuration precedence.
An unanswered repository probe leaves the directory guarded;
an unanswered config probe leaves git's default force requirement in place.

### Stated limits

Past those two questions the hook reads a plain command line.
Closing the gaps below would need a shell-syntax-aware parser, larger and more fragile than the accident guarded against.
It binds that accident, not a determined bypass, and a command it allows is not thereby endorsed.

- Composition is not unwrapped: subshells, brace groups, command substitution, `bash -c "..."`, aliases, functions, and a lone `&`.
- The command word is matched by basename with quotes and backslashes stripped, which over-refuses a backslash inside quotes.
- Only sudo, command, env, nice, time, nohup, setsid, doas and stdbuf are peeled as prefixes; `timeout 5 rm ...` reads `timeout` as the command.
- Runtime targets are not seen: a path read from a file, built in a variable, or produced by a glob.
- A `cd` moves path resolution only as its own command, and a symlink into a worktree is not resolved.
- An `mv` or redirect that overwrites a file inside a tree passes; what is guarded is a tree taken away.
  In a pipeline feeding `xargs` every operand is a candidate.
- The tree the shell stands in comes from the call's working directory, so a session whose cwd drifted into a tree may read as outside it, refusing a cleanup rather than allowing a loss.
- A git directory redirect is read only as `-C`, `--work-tree`, and `GIT_WORK_TREE` set as a leading assignment or by an `export` stage.
- `clean.requireForce` is read from the command line and the config files git resolves, so a `--config-env` stays unread.

The hook fails open on an unexpected error, so a bug in it cannot wedge every Bash command.

## Squash-message reminder

[`.claude/hooks/remind-squash-message.mjs`](../../.claude/hooks/remind-squash-message.mjs)

### Why it exists

Pull requests merge by squash-and-merge, so GitHub folds every commit on a branch into one whose default message is the PR title plus a list of commit subjects.
A maintainer squash-merging a multi-commit branch is better served by a body that follows the Commit Messages rules,
and the hook raises that need right after the pull request opens rather than leaving the maintainer to notice it missing.

### Why a pull-request comment

A message printed into the reply is gone by merge time: the session keeps working and the maintainer merging later has nowhere to look it up.
A comment has a stable address on the page holding the merge button, readable from any machine, and never becomes repository content.
The fence keeps GitHub from rendering the body as markdown, so what is copied is what was written.
The format rules are not restated in the hook; [`format-squash-message.mjs`](../../.claude/scripts/format-squash-message.mjs) states them.

### Which branch is counted

The by-ref review flow opens pull requests from the main checkout with `--head <branch>` while that checkout sits on staging,
where an `origin/staging..HEAD` count is 0 and would silence the reminder on exactly the branches it exists for.
So with `--head` the count is `origin/staging..<that ref>`.
Linked worktrees share one object database, so the branch resolves from whichever checkout the command ran in, with no network call.

### Several creates in one command

One reminder for a command chaining several `gh pr create` calls would take the count from the first `--head` and the number from the last URL,
landing a long branch's count on a short branch's pull request.
So `--head` values and PR numbers are read as lists in command and output order and paired by position.
Position is the only thing pairing them, so the pairing is trusted only when the lists are the same length:
a failed create, or output holding part of what ran, leaves lists that cannot be aligned, and the hook emits nothing rather than address a message wrongly.
The session's retry of the failed create fires the hook again.
Within a pair, a `--head` no ref resolves is skipped rather than counted from the cwd's HEAD, which cannot be the branch of more than one pull request.

### Stated limits

- What a PostToolUse payload holds for a Bash result is the harness's business and is not asserted.
  PR URLs are taken from the first string-valued candidate field containing any,
  since a payload repeating one result under two names would otherwise list every URL twice and break the pairing.
- The command is read as raw text, not a parsed argv.
  A `--head` inside another flag's quoted value is read as naming the branch, which lands on the unresolvable-ref path.
  A literal `gh pr create` inside one, such as a PR body quoting the command, counts as another create:
  a single create then goes through the pairing path, its reminder unchanged while the lists pair and dropped when they do not.
- The hook fails open on every error, an unreadable event, missing git, or an unresolvable `origin/staging`, since a reminder must never disrupt the session.
