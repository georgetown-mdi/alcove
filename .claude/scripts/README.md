# .claude/scripts/

Executables an agent session or the harness runs, on request rather than on a
push:

- the project-board tooling every board read and write goes through
  (`fetch-issues.mjs`, `edit-issue.mjs`, `list-issues.mjs`, `list-epic.mjs`),
  and `lib/projectItems.mjs` under them.
  `lib/stubbedBoardRun.mjs` runs one of them as a child process against the
  GraphQL stand-in in `lib/graphqlFetchStub.mjs`, so a suite asserts its exit
  code and output offline
- `find-rulings.mjs`, run before a Decision item is filed or docketed: it
  searches both boards in every status, the docs and rules at
  `origin/staging`, the staging log, and `scratch/` for a standing owner
  ruling on the question's subject words
- `context-size.mjs`, which prints the session's context size in tokens, read
  from the usage of the last model call in the session's transcript, for the
  compaction trigger in the orchestration ruleset's Session lifecycle
- `worktree-init.sh`, which places a fresh worktree on its branching base and
  provisions its `node_modules`
- `host-build.sh`, which a host session runs from a hand-off brief to build a
  commit in a fresh clone -- the workspaces the CLI needs and, on request,
  Docker images -- without touching the checkout it shares with the dev
  container
- `host-commit-check.sh`, which a host session runs in a hand-off brief's
  Step 0 to check that the branch the brief names still carries the briefed
  commit -- as a descendant or a rebase with the same patch id -- or, once the
  branch has merged and is gone, that `main` holds it
- the hand-off commands around a brief: `host-handoff.sh`, the owner's one
  command on the host, which starts a Claude Code session on the brief's model
  (Sonnet by default) at the brief's effort (high by default) pointed at the
  brief and ends saying whether the result file exists, its
  `--check` reading a brief in the dev container before it is handed out,
  and both refusing one that lists more owner actions than its bound;
  `wait-handoff-result.mjs`, which the dev container session runs in the
  background under `timeout` until the result file is written; and
  `webrtc-capture.mjs`, which a host session runs for a browser step: it
  prints the capture code the owner pastes into a page's console and
  summarizes the file the page downloads, or a saved Firefox about:webrtc page
- `format-squash-message.mjs`, which rewraps the draft body of the squash
  message a pull request lands as, drops the markdown and list markers a
  commit message does not take, reports what it cannot fix without rewriting
  the body, and with `--fenced` prints the body as the code-fenced
  pull-request comment it is posted as. It holds the wrap column, which the
  reminder hook takes from here rather than restate it. The subject is the PR
  title, whose budget
  [`squashSubjectBudget.mjs`](../../scripts/lib/squashSubjectBudget.mjs) holds
  for the PR checklist check and the PR-title hook
- `verify-nonexecutable-delta.mjs`, which decides whether a review attestation
  survives a moved head; `verify-rebase-invariance.mjs`, which decides the same
  question for a head moved by a rebase; and `verify-additive-test-delta.mjs`,
  which decides it for a head that only added lines to test files.
  `verify-fix-shape.mjs` checks, as `/review-round` books a lens round, that each
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
- `*-workflow.mjs`, the Workflow script bodies `/review-round`, `/panel`, and
  `/docket` invoke by absolute path. Each is a script BODY, not a module: the
  harness injects `args`, `agent`, `parallel`, and `pipeline`, and takes the
  top-level `return` as the run's result. No ES module parser accepts that, so
  eslint ignores them and the test beside each one compiles it into a function
  to drive it. The review-round and controversy workflow scripts import and
  require nothing (asserted by their tests), because the harness refuses a
  script that does; work that needs a file or a command runs in a script beside
  it (`verify-fix-shape.mjs` states why).
- `judgment-call-controversy-workflow.mjs`, the controversy scoring `/docket`
  runs while building its list: one Sonnet gatherer per session lists the judgment
  calls taken since the last docket, two independent Opus lenses judge each one
  and each line of the session's own closing list, and the result splits every
  session's lines and the closing list into those either lens flags, which are
  presented, and those both score uncontroversial, which are not. Its arguments
  and result are in `.claude/commands/docket.md`, Build the list.
- `retro/`, the spend kit a retro runs over the Claude Code transcript stores.
  `aggregate.mjs` reads one store into per-session usage, owner turns,
  denials and PR mentions over a window; `cost.mjs` prices the aggregates
  with `pricing.json` (list rates, whose source and date its `_source`
  states) into spend by model, store, component and day; `map.mjs` attributes
  that spend to the window's pull requests; `analyze.mjs` measures the review
  apparatus, implementers and session length over it. Every input -- store
  paths, window bounds, PR range, output directory -- is an argument, and
  each script states its own in its header. The transcript parsing rules are
  in `aggregate.mjs`'s header, each with a synthetic fixture in
  `aggregate.test.mjs` built by `transcriptFixtures.mjs`. One window, two
  stores:

  ```sh
  node .claude/scripts/retro/aggregate.mjs --store <a> --cut <iso> --end <iso> \
    --pr-range <lo-hi> --out <dir>/<a>.json --root <a's projects dir>
  node .claude/scripts/retro/aggregate.mjs --store <b> ... --out <dir>/<b>.json ...
  node .claude/scripts/retro/cost.mjs --out-dir <dir> <dir>/<a>.json <dir>/<b>.json
  node .claude/scripts/retro/map.mjs --dir <dir> --prs <prs.json> --pr-range <lo-hi>
  node .claude/scripts/retro/analyze.mjs --dir <dir>
  ```

  `analyze.mjs --call-index` reads a per-store table whose shape its header
  gives.

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
