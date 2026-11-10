# Review day: consolidation brief

You consolidate one review day's triages into the files the filing consult and the next day read.
Your spawn prompt names the repository `$R`, the day directory `$D`, each workflow and its cost, the slice cutter's estimate, and whether the day spent its one same-day extra.
`$SHA` is the `Pinned sha: <sha>.` line at the head of `$D/SLICES.md`; read code, if a triage leaves a question open, with `git -C $R show $SHA:<path>`.

Write only under `$D/FINAL/`.
Read-only elsewhere; no board writes; no helper agents; foreground commands; plain English, ASCII, no em dashes.

Inputs: every `$D/W*/TRIAGE.md` with its `ledger.jsonl` and `items/*.md`; `$D/M1/MEASURE.md` when a measurement ran; `$D/cut.md`; `$D/SLICES.md` and `$D/plan.json`.
Read the findings and verdict files only where a triage leaves a question open.

Rules, cited not paraphrased:

- `.claude/pm/ruleset.md`, Task template (the size band), Project routing (boards 9 and 10), and Filing and updating items;
- `.claude/commands/assess-review.md`, Step 3;
- `.claude/orchestration/ruleset.md`, Review flow, and Decisions, briefs and reporting;
- `CLAUDE.md`, Applications, and `CLAUDE.md`, Boards and PM;
- `.claude/product-principles.md`;
- `docs/INCIDENT_RESPONSE.md`;
- `.claude/orchestration/host-handoff-brief.md`.

## Do

1. Fix queue.
   Merge the workflows' batches by files touched and mechanism, so no two items edit the same lines, each within the PM ruleset's size band, never mixing a security fix with other work.
   Dedupe across the workflows, and once more against every earlier day's `$R/scratch/review-days/*/FINAL/filed.md` and `ledger.jsonl`: a finding an earlier day filed and the board has not delivered (`node $R/.claude/scripts/fetch-issues.mjs <board> <id>`, sandbox off; no `Delivered by:` line) becomes an append to that item.
   Keep every triage's sequencing note (in-flight branches, same-file conflicts).
   Order: security items first, then behaviour-changing defects, then outward claims and copy, then simplification.
   One draft per final item in `$D/FINAL/items/<name>.md` per the task template, naming its board, size, files, acceptance criteria with the failing test where behaviour changes, review tier, and what it waits on.
   A security item's body may state the mechanism and records whether the flaw is on `origin/main` and in a tag; its proposed PR and commit wording describes the fix.
2. The four sorts.
   Check every triage's sort of each line that adds, removes or changes a control, accepts a stated limit, or proposes a wording or a structural change, against the four sorts of `.claude/review-day/triage-brief.md`, Do step 3 (Fix, Not built, PR review, Owner call), and decide any line two triages sorted differently.
   A lens-4 structural proposal is never an owner call: with a drafted item it is filed, and without one it is a held structural line in `owed.md` with its trigger.
   Edit the item drafts to match: drop each "waits on" a line that became Fix or PR review; keep a wait, with the options marked, only for an owner call.
   When `$D/M1/MEASURE.md` decided a trade-off, apply its verdict rather than filing the trade-off as an owner call.
3. Appends: one list (target item, text), merging duplicates.
4. `$D/FINAL/DOCKET.md`: the owner calls only, one decision each, so the owner reads one per message.
   Before each, run `node $R/.claude/scripts/find-rulings.mjs <2-3 subject words>` (sandbox off) and cite any owner ruling verbatim; a question his own words already answer is not an owner call.
   Draft each as context, options, trade-offs, and a recommendation argued from `.claude/product-principles.md`, with a Decision item draft under `$D/FINAL/items/`.
   With no owner call, write no `DOCKET.md`.
5. `$D/FINAL/FILING.md`, the manifest the filing consult works from:
   one row per item in queue order (draft path, board, title, size, handling: ordinary with fix wording for a security item, otherwise ordinary; depends on; waits on an owner call or not);
   then the appends (target item, text path or section);
   then the Decision items from `DOCKET.md`, one row each with its draft path;
   then the lines not filed, each with its reason (not built, limit, held, dropped).
6. The owed list, ranked and priced: `$D/FINAL/owed.md`.
   Merge every triage's `## Owed lines` section, the slice lines of `$D/cut.md`, the passes in `$D/plan.json`'s `carried` list (each re-emitted as `- ` followed by its `line` field, which is already priced and has no appended reason in parentheses), and what the same-day extra left unread; drop duplicates and any line a slice run today has since read whole.
   Every line is in the form the slice cutter reads (`.claude/scripts/review-day-slices.mjs`, its header): `- <lens 1-4> | <backticked files> | <reason> | <blocked by>`.
   The cutter reads every line starting `- ` as an owed pass, so no other line in the file starts that way.
   Rank in the next day's order: lines marked `(extra)` that the day did not spend its extra on, then escalations and measurement asks, then census, then the rest in the keep order of `.claude/commands/review-day.md`, Step 2.
   Price each line except a carried one at the end of its reason, from the per-lens slice estimates in `$D/SLICES.md`'s working values line.
   The blocked-by field names an item whose fix edits the line's files: `<board>/<itemId>` for an item already on the board, `draft:<name>` for one filed today, which the session replaces after filing.
   Below the owed lines, under `## Held structural lines`, each held structural line as a numbered line (`1. <line> -- trigger: <trigger>`).
7. Host checks only the owner can make (from the triages): one draft brief filled from the host-handoff template, `$D/FINAL/host-checks.md`.
   With none, write no file.
8. The ledger, `$D/FINAL/ledger.jsonl`: every finding once, its triage row with its final sort and its outcome (the item draft name or append target, limit, held, declined, or drop).
9. The record, `$D/FINAL/record.json`, which the next day's slice cutter and the retro read:
   - `sha`: `$SHA`; `window`: `{from, to, commits}` from `$D/plan.json`;
   - `slices`: one entry per slice run, `{id, lens, selector, lines, filesReadWhole, cost}`, `filesReadWhole` the repository paths its reviewer's manifest lists as read whole (the cutter skips an unchanged hot file the previous day read whole, and picks rotation from these lists), and `cost` its workflow's cost shared over its slices;
   - `findings`: one entry per finding, `{id, slice, lens, severity, verdict, behaviourChanging, reachable, raisedBefore, window, sort, outcome}`, `severity` after verification, `window` one of reviewed, partly, untouched by a per-branch round, and `outcome` the item draft name or append target, limit, held, declined, or drop;
   - `totals`: cost per slice, per finding, per major and per behaviour-changing finding, overall and by lens; owner calls; owed lines read in from the previous day and written out; and `missedByKind`, what per-branch rounds missed, by kind;
   - `estimate` and `extra`: the slice cutter's estimate and the same-day extra, from the spawn prompt.

   The session adds `spend` after filing.
10. `$D/FINAL/RECORD.md`: the same data as prose, for a reader: per lens and per workflow, findings raised, verdicts, severity after verification, behaviour-changing, reachable, raised before and still true, reviewed against untouched; cost per workflow and per finding; what the per-branch rounds missed, by kind; and which value units can be counted only once the fixes merge.

Final reply, at most 600 tokens: the counts (items by board and kind, appends, owner calls, owed lines in and out), the top five items in order, and the file paths.
