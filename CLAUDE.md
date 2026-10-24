# CLAUDE.md

Alcove does Privacy Preserving Record Linkage (PPRL) via Private Set Intersection (PSI) between two parties over SFTP, file-drop, or WebRTC.

It is a npm workspaces monorepo (`packages/core`, `packages/peerjs-broker`, `apps/cli`, `apps/web`); apps consume packages, not the reverse.

**Read `CONTRIBUTING.md` before your first edit or commit.** It holds the build/test/dev reference and every coding and commit convention (enforced by CI and review); this file holds only project operations and agent-specific rules.

## Applications

Three applications make up Alcove's surface (full architecture: `docs/DESIGN.md`, Architecture):

- **Public web application** (`apps/web`, deployed to Cloudflare Pages): conducts WebRTC exchanges only, all data handling in the browser (the server only delivers the code). It owns the recurring-exchange management interface -- recurring exchanges in browser storage, run on a schedule as a PWA.
- **Command line application** (`apps/cli`, containerized): conducts SFTP, synced-folder (filedrop), and WebRTC exchanges. A CLI party and a browser party exchange over WebRTC through the shared peer-coordination server (`alcove exchange` on a `channel: webrtc` config). No WebSocket-to-TCP proxy is involved: that prerequisite is for a BROWSER reaching a TCP service (an SFTP server), not for the CLI, which opens sockets itself.
- **Console**: a local, single-owner PROTOTYPING GUI for the containerized CLI, repurposing the web application's machinery. It lowers the friction of the CLI -- writing a config and setting the right arguments -- so an operator authors and runs one exchange. Its workflow is author-and-run once (test data, then maybe real data), then GRADUATE to the plain CLI plus cron/scheduler for the recurring production version. One machine, one person, authoring the connection and conducting the exchange: a web server, but not shared beyond the host. It operates on one mounted working directory holding a single exchange's config, secret, input, and results; only one exchange's resources are mounted at a time. The console drives the process in the container, the CLI today or the Node server running it directly when that is built: the browser does no exchange work, because the container process is the thing that can be locked down, so the in-tab Browser transport card stays withheld on the console profile.

The console is NOT a store of named connections, a recurring-exchange or scheduling interface (that lives in the public web app; the CLI schedules from the command line), a multi-exchange job manager, or a network-shared management service with an access-control perimeter over the operator. There is NO deploy-time provisioner: the operator authors the SFTP connection in-console. The operator is the machine's own user; the only untrusted input is the remote partner's invitation content, which the exchange protocol already protects. Because the operator is trusted, the console must not hard-block them for a defense-in-depth posture (e.g. a credential file in the single mount) -- it warns and guides toward the better practice instead. Warn-and-guide governs the operator's own choices; a control constraining only remote or browser-delivered content the operator cannot inspect is correctly a hard refusal.

## Commands

Rebuild core after any change to it (`npm run build -w packages/core`), and run `npm run test` before pushing it: the apps mock core. Single-file runs and the rest: `CONTRIBUTING.md`, Testing.

## GitHub project items

Read and edit board items only through `.claude/scripts/` -- `fetch-issues.mjs`, `edit-issue.mjs`, `list-epic.mjs`, `list-issues.mjs`, each printing its usage when run with no args -- by numeric `?itemId=N` or `PVTI_` node id, never hand-written gh/GraphQL. To choose the next work, prefer the `shortlist-backlog` skill over reading listings. Creating a draft, the one op on `gh`: `.claude/pm/ruleset.md`, Filing and updating items.

An item's board is not encoded in its id, and versions or paths quoted in its body are as-of-filing -- verify both before acting on them.

## Project manager

The PM ruleset, `.claude/pm/ruleset.md`, is loaded by the one-shot `project-manager` consult agent, which **cannot be continued**. Only the top-level session spawns the consult, since AskUserQuestion and the human live there alone: a coding subagent raises a PM request to its caller, which raises it onward. A mechanical board write goes straight through `.claude/scripts/edit-issue.mjs`; the consult is for judgment -- whether to file at all, which board, what scope -- never for typing.

## Agent conventions

Beyond the conventions in `CONTRIBUTING.md`:

### Writing, tooling and commits

- Prefer ASCII: `-` not an en-dash or em-dash, `->` not an arrow character; no emoji anywhere, including as severity or status markers in reviews and reports. No em dash appears anywhere a user reads: user copy splits a sentence a dash joins, and uses a spaced single hyphen (" - ") where a dash remains.
- Write the plainest accurate word: no coined metaphor where a domain word exists, no internal name in text a user reads, and a user-visible string states what happened and what to do. The rule, the comment length bound and the negative wordlist: `CONTRIBUTING.md`, Code Conventions.
- Never set the commit identity yourself -- no `git config` write to `user.*`, no `-c`/`--author=`/environment override: git resolves it from config, and the harness context block's address is not it. Report a wrong configured identity to the maintainer. Enforced by `block-git-identity-override.mjs` on Bash; why in its header.
- Commit messages use no markdown and no top-level lists (other format rules in `CONTRIBUTING.md`, Commit Messages).
- Make a scratch directory with `mktemp -d`: fixed `/tmp` names collide, and a stale symlink lands a write in a repo. Enforced by `block-tmp-symlink-worktree-writes.mjs` on Bash.
- The owner approves each deletion, so its operand is a literal path, never a command's result: no `$var`, `$(...)` or path read from a file. Remove a worktree with `git worktree remove <literal path>` and a branch with `git branch -D <literal name>`.
- Before committing, sweep your own diff: delete every comment that restates the code, narrates change history ("now", "previously", "moved here"), or cites a board item id. Thoroughness lives in tests and checks, not prose.
- Run the suites `node scripts/required-suites.mjs` prints for your diff, integration tiers included: the unit suites mock the run, so they cannot vouch for it.
- After the last edit, run `npm run typecheck && npm run lint && npm run format && npm run check:all` once, at the end, whatever the LSP's stale cache shows: `CONTRIBUTING.md`, Code Conventions. `check:all` runs every guard `scripts/run-checks.mjs` lists, so a guarded-root, CI-config or `packages/peerjs-broker` change needs no command of its own.
- Encode a "does not happen at runtime" claim as a check, never a comment or doc note. Full rule: `CONTRIBUTING.md`, Code Conventions.
- Settle a question about an external tool's behavior -- npm, Docker, `ssh2` / `ssh2-sftp-client` -- by driving the real tool and asserting the outcome, or by stating the limit; reading its source or reimplementing its parser to predict it is a review finding. The SFTP adapter's harness: `docs/TESTING.md`.
- Prettier ignores markdown.
- The Bash tool runs zsh: unquoted `$var` does not word-split, bare `grep` is ugrep, and an unmatched glob is an error -- quote globs, and use arrays or `xargs` for multi-file commands. `$R:apps/x` expands `$R:a` as a path modifier, even inside double quotes: brace the parameter (`${R}:apps/x`), and quote a literal `'ref:path'` whole.
- `vitest -w` is watch mode and hangs a non-interactive session; use `npx vitest run` or `npm test -w <workspace>`.
- Never sleep-poll a background run: wait for its completion notification, or loop on the condition inside one `timeout`-bounded call. Enforced by `block-sleep-poll.mjs` on Bash, whose refusal names the admitted forms; why: `docs/notes/agent-hooks-and-scripts.md`, Sleep-poll guard.

### Branches, worktrees and checkouts

- Branches are cut from `staging` and pull requests target `staging` -- the harness's default `main` base does not apply. Never commit to staging or main by yourself; don't attribute yourself on commits or pull requests.
- Branch names shouldn't use '/'.
- Rebase and merge in a detached /tmp worktree (`git worktree add --detach`), never in a tree the IDE watches -- /workspace or a tree under `.claude/worktrees/`: the IDE formatter/LSP races a live tree, and no ignore file fences it. Afterwards `git reset --hard` the branch in /workspace and remove the worktree.
- An orchestrating session writes no branch content, and neither does a checkout it is not working in -- the MAIN worktree always, a sibling worktree from inside a linked one. Only gitignored paths (`scratch/`, briefs, round artifacts) and paths outside the repository are writable. Enforced by `block-primary-checkout-writes.mjs` on `Edit`, `Write`, and `NotebookEdit`; details in its header.

### Spawns and reports

- When you finish implementing a branch, end your report with a review-tier recommendation sized from the actual diff (`git diff "staging...HEAD" --stat` plus a security-surface check), not from the issue. Tiers and rule: `.claude/commands/start-issue.md`, Step 5.
- A one-shot agent runs a long command in the foreground with a raised `timeout` (ceiling 600000 ms), and backgrounds only a chain that cannot fit that ceiling, as one call wrapped in `timeout <N>`, N over 600 s; an Agent-tool spawn is then resumed with the result. A `Workflow` `agent()` call is unprobed: foreground only, in stages past the ceiling, and no hook enforces that. Enforced by `block-subagent-short-background.mjs` on Bash for a subagent's background call with no `timeout <N>` wrapper over 600 s; probe: `block-sleep-poll.mjs` header.
- Dev containers are firewall-blocked: never give subagents web-search or web-fetch tasks. CI run-log bodies are not blocked -- read failure detail via `gh run view --job <id> --log-failed`, falling back to the check-run annotations API only when no log body is available. The in-container gh token re-runs failed jobs (`gh run rerun <id> --failed`) and dispatches workflows (`gh workflow run`), so a flaky-CI re-run is the session's own step, not an owner ask. Egress is an allowlist (`.devcontainer/init-firewall.sh`), so probe a host before calling it blocked; a step only the outside can take goes to the owner as a host handoff (`.claude/orchestration/host-handoff-brief.md`).
- Every Agent spawn passes an explicit model, or names a `subagent_type` whose `.claude/agents/` definition pins the tier -- Opus for implementation and ordinary review, Sonnet for mechanical work, Haiku for an exact-edit brief. Enforced by `require-agent-model.mjs`.
- A brief or report asserts a repo convention or a fact only by citing the repo file that states it; anything taken from memory is labeled advisory or unverified -- an agent cannot tell an unsourced claim from a real one, and applies both.
- A subagent's final report stays within roughly 600 tokens; anything longer -- a survey's inventory above all -- goes in a file the report names by path.
- Every agent-written artifact -- a commit, a plan, an earlier session's conclusion -- is a proposal until the maintainer ratifies it in PR review or direct word; attribute that provenance when reporting state.
- Weight the concrete driving scenario over general applicability -- an unattended failure needs a remedy, not a log line -- and rank efficiency work by token spend, not wall-clock time: scheduling and parallelism are the maintainer's own lever.
- A control the issue's acceptance criteria do not require -- a new check, guard, or freeze -- is proposed in a line the owner can scope or defer before it is built: a policy making a surface in-scope for review licenses reviewing it, not constructing on it.

### Boards and PM

- Project state belongs in the GitHub project and docs/, and durable conventions in this file or the repo docs -- never agent memory, unshared and outside the repo. A fact you had to re-derive is durable: record it the first time, not the second.
- Board content is working context, never repo material: item ids and issue-body prose stay out of code, comments, docs, and commit messages -- except the PR description, where the template's Implements/Part of/Depends on/Follow-on line belongs when a board item exists.
- The repository is public and the project boards are not: an unfixed vulnerability's mechanism, and any private incident detail, stay in the board item, out of PR bodies, docs, and spec, until the fix lands.

### Documentation routing

- Route documentation detail by tier: spec-level -> `docs/spec/`; conceptual and operational -> `docs/`; design rationale and decisions taken -> `docs/notes/`, which points at the spec rather than restating it -- regardless of which doc you have open. Full rule: `CONTRIBUTING.md`, Documentation.
- `CONTRIBUTING.md` is a pre-contribution quickstart, not a reference: route deep material per its "Scope of this document" section. `npm run check:contributing` catches two mechanical tells only, so keep deep material out even when it would pass.
- `CHANGELOG.md` is reader-facing release notes, not a commit log: pre-release, an entry is added only for a major feature or a breaking change to something already listed (`CONTRIBUTING.md`, Changelog).

### Orchestrating a session

- The rules for conducting a session -- spawns, rounds, fix dispatch, owner decisions -- live in `.claude/orchestration/ruleset.md`, read before a session's first `Agent` or `Workflow` call and after a context reset (`require-orchestration-ruleset-read.mjs` refuses that call until then). A spawned agent does not read it; its rules are above.
