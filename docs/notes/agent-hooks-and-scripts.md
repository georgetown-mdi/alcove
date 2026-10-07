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

## Additive-test-delta verifier

[`.claude/scripts/verify-additive-test-delta.mjs`](../../.claude/scripts/verify-additive-test-delta.mjs)

### Why insertions only

A test change can weaken a control: a deleted assertion, a loosened expectation, a mock that bypasses a check.
So the general test-only case is refused, and the only delta admitted leaves every line the round read where it was and adds nothing that reaches past its own statement.
Nothing in CI can catch a false claim of that property, for the reason the [non-executable-delta verifier](#why-it-is-mechanical) gives.

### Which paths count as tests

A list of directories, `apps/<app>/test/` and `packages/<package>/test/`, each containing only code the suites run.
`scripts/*.test.mjs` is refused: those are the tests of the repository's checks, and several contain the check's own pin data,
where one inserted entry widens a control rather than testing it
(`scripts/sftp-tracked-round-trips.test.mjs` lists, in `ALLOWED_OUTSIDE_THE_BRACKET`, call sites exempt from the bracket that check enforces).
A fixture, a vector or a binary is content the verifier cannot read as test code,
and a configuration file decides how other code is linted, built or run.

### Reading git's own patch

A line count cannot tell an inserted line from a replaced one, so each changed path is diffed by itself under `--unified=0 --inter-hunk-context=0`,
where every line in a hunk body is part of the change.
What that refuses was measured against real git, and the colocated test pins each case:

- a replaced line arrives as a deletion beside its insertion;
- appending to a file that lacked a trailing newline rewrites its last line, so it arrives as a deletion;
- a binary change produces no hunks;
- a rename, with rename detection off, arrives as a delete plus an add.

A diff algorithm may choose which lines it calls inserted, but it cannot represent a removed line as anything but a deletion, so that choice can only make the verifier refuse more.
The patch is read per path under `:(literal)`, so no file name is parsed out of a patch header and a path containing a glob character matches itself;
inside a hunk body every line has its own prefix, so an inserted line that looks like a patch header is still an insertion.

### Inserted lines refused by content

A lint or type-check suppression turns off a rule for code the round read under it.
A call into the test runner's module registry, globals, environment, clock or configuration can change what an existing test measures.
`vi.spyOn` is on that list because a spy is not restored at the end of the test that set it unless the suite says so,
and the verifier does not read each workspace's runner configuration to find out.

### Limits

Whether an inserted test is any good is not read.
The verdict attests only that nothing the round read changed, which is why one deleted line sends the head back to the paths [`assess-review.md`](../../.claude/commands/assess-review.md), Step 4, states.

## Rebase-invariance verifier

[`.claude/scripts/verify-rebase-invariance.mjs`](../../.claude/scripts/verify-rebase-invariance.mjs)

Why the path exists, why it needs both comparisons, and the shape check that separates a rebase from a base sync are in [rebase-reattestation.md](rebase-reattestation.md).
The comparison, its soundness probes and the primitives measured wrong are the [non-executable-delta verifier](#non-executable-delta-verifier)'s, reused rather than reimplemented.

### Path collection fails closed

A diff record whose shape the verifier does not model leaves the run with no verdict,
rather than a path set one short, because a path missing from the set is a path nothing compares.

### Limits

Beyond the non-executable-delta verifier's: markdown content wholesale, including a conflict resolved inside a governing document,
and every path outside the branch's own diff, which is the unread content the path in Step 4 admits.

## Scratch-symlink write guard

[`.claude/hooks/block-tmp-symlink-worktree-writes.mjs`](../../.claude/hooks/block-tmp-symlink-worktree-writes.mjs)

### The incident

A session created its scratch directory under a fixed /tmp name instead of the one `mktemp -d` prints.
An earlier session had left that name behind as a symlink into a checkout of this repository,
so the write followed the link and overwrote a tracked file with scratch output.
Every command involved succeeded, and the damage showed up only when a later check read the replaced file.

### Resolution decides, not the name

A hook cannot tell a fixed name from a generated one by looking at it, and the damage needs no fixed name,
only a scratch path that resolves somewhere it was not written.
So the conditions are that something below /tmp redirects the path, and that it lands inside a git worktree.
A path nothing redirects never matches, including the detached worktree a rebase is done in under /tmp,
which is a git worktree exactly where it was written.
A path the command did not spell under /tmp is outside the hook's scope: `cp /tmp/scratch/report.md <repo path>` names its destination in the repository.

Removing the stale link is the fix, so blocking it would leave the session no way to clear what it just hit;
`rm /tmp/<name>` takes the link, not its target.
A trailing slash is different: `rm -rf /tmp/<name>/` empties the checkout and leaves the link in place.

### Stated limits

Closing these would need a shell-syntax-aware parser, larger and more fragile than the accident guarded against.
The hook binds that accident, not a determined bypass.

- Composition is not unwrapped: a subshell, command substitution, `bash -c "..."`, an alias, a shell function.
  A heredoc body and a quoted string are read as command text of their own, which over-refuses, and only where the path they name resolves into a worktree.
- A path that exists only at runtime is not seen: one in a variable, produced by a glob, or read from a file.
- A writing command behind a prefix word outside `lib/shell.mjs`'s `COMMAND_PREFIX_WORDS` (`timeout 5 cp ...`), or through `xargs` or `find -exec`, is not read.
- A program that writes files of its own accord, an interpreter given a script or a build tool given an output directory, names no write.
- A `cd` on the line does not move what a relative path resolves against; only the call's own directory does.
- Resolution is read at the time of the call, so a link created later on the same line is not the one seen.
- A path operand starting with `-`, including one after `--`, is not read as a write target.

## Other-checkout write guard

[`.claude/hooks/block-primary-checkout-writes.mjs`](../../.claude/hooks/block-primary-checkout-writes.mjs)

### Why it exists

Review and fixing run by ref.
The orchestrating session stays in the primary checkout and never enters a branch's tree,
while every branch lives in its own worktree under `.claude/worktrees/` and every writing spawn is pointed at that tree by absolute path.
A write landing in the primary checkout puts the edit on whatever branch it has checked out, typically staging,
where no review round sees it and no PR includes it.
The sibling case is the same loss by another route:
the file tools take a literal absolute path and every unmodified tracked file is byte-identical across trees,
so reusing a path read from context succeeds, reads back correctly, and shows up only as an unexplained diff on another branch.

### Why the two rules differ in scope

The main-worktree refusal is path-scoped, since no session writes that content.
The sibling refusal binds only a session already inside a linked worktree,
because pointing a spawn at a tree by absolute path from the primary checkout is how work is dispatched.

### Why ignored-ness

The only legitimate writes to a checkout the session is not working in are to paths git ignores.
A new source file created there lands on its branch exactly as an edit to a tracked file does, and `git check-ignore` answers for both.
A tracked file is reported as not ignored whatever the exclude patterns say, since the check consults the index,
and a path whose answer changes between the check and the write is answered as git sees it at the call.

### Why fail open

The opposite of `require-clean-tree-for-review.mjs`: this guard shapes where work is written, and neither correctness nor disclosure depends on it,
while a bug that failed closed would block every edit in every tree.

### The override

It follows the idiom of `block-model-drop-sendmessage.mjs`'s `[accept-model-drop]` marker.
Edit and Write have no free-text field a marker could go in, so the opt-in is a file.
Like that marker it is self-applicable: what it buys is an override that is named, visible in the tree, and reversible, not one that cannot be forged.

### Limits

A tool naming its target under a key other than `file_path` or `notebook_path` is not seen.
The session's tree is read from the event's cwd, where the harness says the session is working, so a cwd that silently reverted out of an entered worktree is treated as the tree it reverted to.
