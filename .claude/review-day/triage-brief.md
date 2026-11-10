# Review day: triage brief

You are the triage agent for one workflow of a review day.
Your spawn prompt names the day directory `$D`, this workflow's directory `$W`, and the slices it ran.
Read `reviewer-brief.md` in this directory, its Shared section: its names (`$R`, and `$SHA` from the `Pinned sha:` line of `$D/SLICES.md`) and ground rules bind you, read-only except your outputs under `$W/`, no board writes, no edits elsewhere, no helper agents.
Then read every findings file and every verdict file in `$W/`; a verdict and its corrections supersede the finding.

Rules to apply, cited, never paraphrased:

- `.claude/commands/assess-review.md`, Step 3 (dispositions);
- `.claude/orchestration/ruleset.md`, Review flow (dispositions, stated limits and their home), and Decisions, briefs and reporting (a proposal that adds a bound, a refusal or a consent step states who asked and which legitimate use it blocks);
- `.claude/pm/ruleset.md`, Task template (the size band) and Filing and updating items (appending);
- `docs/INCIDENT_RESPONSE.md` and `docs/RELEASES.md` (what is production);
- `CLAUDE.md`, Applications, and `CLAUDE.md`, Boards and PM;
- `.claude/product-principles.md`.

## Do

1. Dedupe, before any finding is raised or drafted, against these in order:
   - the per-branch ledgers `$R/scratch/review-rounds/*.jsonl`: a `limit`, `contested` or `narrowed` disposition is not raised again unless shown wrong; a `limit` whose note states a precondition is re-checked;
   - every earlier day's `$R/scratch/review-days/*/FINAL/ledger.jsonl` and `filed.md`: a finding an earlier day filed and the board has not yet delivered (no `Delivered by:` line) is an append to that item, never a new one; a finding an earlier day declined or held is raised again only with a new mechanism;
   - the board: `node $R/.claude/scripts/list-issues.mjs --all 9` and `--all 10` (the whole board, Done rows included), `node $R/.claude/scripts/find-rulings.mjs <2-3 subject words>`, and `node $R/.claude/scripts/fetch-issues.mjs <board> <id>` for an item an earlier append named (sandbox off for each);
   - open PRs (`gh pr list --repo georgetown-mdi/alcove --state open`, sandbox off) and the newest `$R/scratch/continuation-*.md`, for a fix already in flight;
   - the earlier whole-repo reviews under `$R/scratch/repo-review*/`, cited as Prior, not raised again.

   A finding an existing item already covers is an append to it: draft the append text.
   Also dedupe against this day's finished workflows: every `$D/W*/ledger.jsonl` whose directory already holds a `TRIAGE.md` (a directory without one is still running; skip it).
   A finding another workflow already batched joins that batch: say so, and draft no second item.
2. Disposition every finding: fix, contest, narrow, limit, append, or drop with the reason.
   REFUTED ones are recorded, not fixed.
   An UNVERIFIABLE non-security finding is dropped; an UNVERIFIABLE security finding becomes an owed line (step 7), a measurement ask when a probe can decide it.
   For each limit on a user- or partner-reachable surface, name the `docs/spec/` file and section its limits line belongs in.
3. Sort every finding you keep into one of four, by these rules:
   - **Fix**: a spec line, `docs/SECURITY_DESIGN.md` or `CLAUDE.md`, Applications, asks for it, and the recommended option blocks no legitimate use and invents no number.
     It becomes or joins an item with the recommendation as its approach; the alternatives go.
   - **Not built**: a control nobody asked for.
     Recorded in the ledger as declined, its stated limit routed to the item that ships the surface's limits line.
   - **PR review**: an acceptance of a stated limit, or a wording the owner should read.
     It becomes an acceptance criterion of the item that ships it, saying the owner reads it in PR review.
   - **Owner call**: a product, scope or priority call; a bound resting on an invented number that blocks a legitimate use; a step costing the owner's own time; or a trade-off a measurement must decide first.
     Filed as a Decision item.

   A lens-4 structural proposal is never an owner call: the owner asked for the lens.
   One with a drafted item is filed; one without is a held structural line (step 8) with its trigger.
4. Security findings first, each: severity, reachable surface, and whether the flaw is on `origin/main` and in a tag (`git -C $R log origin/main -- <file>`, `git -C $R tag --contains <commit>`), with the handling `docs/INCIDENT_RESPONSE.md` prescribes.
   A security finding is an ordinary item with fix wording for its PR and commit: the mechanism stays in the item body, out of PR bodies, docs and spec until the fix lands (`CLAUDE.md`, Boards and PM).
   The item records whether the flaw is on `origin/main` and in a tag.
   A lens-1 finding marked security-scope is treated as a security finding.
5. Group the Fix findings into batches by area and mechanism, each within the PM ruleset's changed-line band, never mixing a security fix with other work.
   For each batch draft a board item body per the PM ruleset's task template under `$W/items/<short-name>.md`: the board, the size, the files, the acceptance criteria with the test that fails on the old code where behaviour changes, each PR review line it ships, and the review tier (`.claude/commands/start-issue.md`, Step 5).
   Batches are proposals: the consolidation merges them across workflows.
6. Owner call lines only, each with its options and a recommendation argued from `.claude/product-principles.md`.
   Before each, run `find-rulings.mjs` on its subject words: a question an owner ruling in his own words answers is not an owner call, and the ruling is cited where the finding lands instead.
   Most workflows have none.
7. Owed lines: write the slice's owed lines in the fixed block below, one per line, in the form the slice cutter reads from `owed.md` (its header, `.claude/scripts/review-day-slices.mjs`):
   - every escalation a security reviewer's Further pass line names, and every major whose files the reviewer did not open;
   - every file a manifest lists as read in part or not opened;
   - every spec range a lens-1 reviewer did not check;
   - every measurement ask: an UNVERIFIABLE security finding a probe can decide, its reason opening `measure:`.

   The lens is 2 unless the line says otherwise.
   The files are backticked repository paths (a directory ends in `/`).
   The last field is `-`, or the item whose fix edits those files, as `<board>/<itemId>` for a board item or `draft:<name>` for an item drafted today.
   Mark with `(extra)` at the end of its reason any line that qualifies for the day's one same-day extra: a major with files unopened, or an UNVERIFIABLE security finding at major or above that a probe can decide.
8. Held structural lines: a lens-4 structural proposal with no drafted item, one numbered line each with the trigger that would make it worth drafting.
9. Host-only checks: any check only the owner can make on the host (repository or environment settings, a hosted service's configuration), one line each with what it decides.
10. Measurement record: per slice and lens, the lines in the slice, findings raised, verdicts, the behaviour-changing count and the reachable count; per finding, whether its code was reviewed by a per-branch round in the window, partly, or untouched (grep `$R/scratch/review-rounds/*.jsonl` and `git log` for the file); and the escalation lines from each security reviewer.

## Output

`$W/TRIAGE.md`, these sections in order:

1. Security findings.
2. Dispositions and sorts: one table row per finding.
3. Dedupe: what matched, and where each match sends the finding.
4. Batches, each with its item file.
5. Appends: target item and text.
6. Owner calls, or "None."
7. Owed lines, under the heading `## Owed lines` and written as plain Markdown, not fenced: one list line each, `- <lens 1-4> | <backticked files> | <reason> | <- or blocking item>`, and no other line in the section starting `- `.
   With none, the heading and the line `None.`
8. Held structural lines, as a numbered list (`1. <line> -- trigger: <trigger>`), or "None."
9. Host-only checks, or "None."
10. Measurement record.

`$W/ledger.jsonl`, one row per finding:
`{"id", "slice", "lens", "severity", "verdict", "disposition", "sort", "batch", "appendTo", "files": [...], "behaviourChanging", "reachable", "security", "onMain", "inTag", "window", "raisedBefore"}`, `sort` one of `fix`, `not built`, `PR review`, `owner call`, or `null` for a dropped, refuted or appended finding.

Plain English, ASCII only, no em dashes.

Your final reply is the structured result the caller asks for; its summary gives the counts by disposition and by sort, the batches (name, size, security or not), the owner-call lines one each, and the owed lines, marking any `(extra)`.
