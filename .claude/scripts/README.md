# .claude/scripts/

Executables an agent session or the harness runs, on request rather than on a
push:

- the project-board tooling every board read and write goes through
  (`fetch-issues.mjs`, `edit-issue.mjs`, `list-issues.mjs`, `list-epic.mjs`,
  `lint-issues.mjs`), and `lib/projectItems.mjs` under them
- `find-rulings.mjs`, run before a Decision item is filed or docketed: it
  searches both boards in every status, the docs and rules at
  `origin/staging`, the staging log, and `scratch/` for a standing owner
  ruling on the question's subject words
- `worktree-init.sh`, which places a fresh worktree on its branching base and
  provisions its `node_modules`
- `host-build.sh`, which a host session runs from a hand-off brief to build a
  commit in a fresh clone -- the workspaces the CLI needs and, on request,
  Docker images -- without touching the checkout it shares with the dev
  container
- `squash-message.mjs`, which drafts the body of the squash message a pull
  request lands as, and `format-squash-message.mjs`, which rewraps a draft
  body, drops the markdown and list markers a commit message does not take,
  reports what it cannot fix without rewriting the body, and with `--fenced`
  prints the body as the code-fenced pull-request comment it is posted as. It
  holds the wrap column, which the reminder hook takes from here rather than
  restate it. The subject is the PR title, whose budget
  [`squashSubjectBudget.mjs`](../../scripts/lib/squashSubjectBudget.mjs) holds
  for the PR checklist check and the PR-title hook
- `verify-nonexecutable-delta.mjs`, which decides whether a review attestation
  survives a moved head; `verify-rebase-invariance.mjs`, which decides the same
  question for a head moved by a rebase; and `verify-additive-test-delta.mjs`,
  which decides it for a head that only added lines to test files.
  `verify-fix-shape.mjs` checks, as `/light-review` books a lens round, that each
  edit the round proposes as mechanical finds its old text exactly once at the
  reviewed ref.
  `check-review-ledger-dispositions.mjs` checks, at merge-ready, that a
  branch's review ledger names a fix commit the PR head contains for every
  `fixed` finding, a home for every `deferred` one, a spec limits line for
  every `limit` on a reachable surface, and a step-back record on a second cap
  raise. It and `verify-rebase-invariance.mjs` read a ledger through
  `lib/reviewLedger.mjs`.
  `lib/gitFixture.mjs` holds the throwaway repositories the suites drive real git
  through
- `measure-pr-checks.mjs`, which measures the wall clock a pull request pays for
  its checks and names the critical path that gates the merge. It makes several
  hundred GitHub API calls, so it is asked for explicitly:
  `npm run measure:pr-checks -- [runs]`. With no arguments it prints its usage
  rather than starting a run
- `*-workflow.mjs`, the Workflow script bodies `/light-review`, `/panel`, and
  `/docket` invoke by absolute path. Each is a script BODY, not a module: the
  harness injects `args`, `agent`, `parallel`, and `pipeline`, and takes the
  top-level `return` as the run's result. No ES module parser accepts that, so
  eslint ignores them and the test beside each one compiles it into a function
  to drive it. The light-review and controversy workflow scripts import and
  require nothing (asserted by their tests), because the harness refuses a
  script that does; work that needs a file or a command runs in a script beside
  it (`verify-fix-shape.mjs` states why).
- `judgment-call-controversy-workflow.mjs`, the controversy scoring `/docket`
  runs at its closing step: one Sonnet gatherer per session lists the judgment
  calls taken since the last docket, two independent Opus lenses judge each one
  and each line of the session's own closing list, and the result splits every
  session's lines and the closing list into those either lens flags, which are
  presented, and those both score uncontroversial, which are not. Its arguments
  and result are in `.claude/commands/docket.md`, Build the list.

Tests sit beside their subject, in the vitest project named `scripts` -- the
project covering the repository's own `scripts/` is `repo-scripts`:

```sh
npx vitest run --project scripts
```

## What belongs here, and what belongs next door

The directory is decided by who RUNS the file, not by what the file reads.

- A session or the harness runs it: here.
- CI or a contributor runs it against the repository, including a check whose
  whole subject is `.claude/` or `CLAUDE.md`: [`scripts/`](../../scripts/README.md).
- Claude Code runs it on a tool event, deciding whether the call proceeds:
  [`.claude/hooks/`](../hooks).
