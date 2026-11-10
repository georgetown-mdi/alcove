---
name: review-day
description: Run the code-and-doc review day -- cut the fortnight's changed and hot code into slices small enough to read whole, review each by lens with a verifier and a triage, consolidate, and file the fixes as board items for the dev container; only the owner's own calls reach him.
---

    /review-day

A review day runs on the Fridays between retros, beside the user-journey audit day (`.claude/commands/audit-day.md`), when the owner starts one.
It is a review-and-file day: it writes no branch, runs no fix, and holds nothing for a follow-ups pass.
The owner's words that set it: "Fixes go into board issues, which get passed back to the dev container." and "Yes, no need to wait. This is not an orchestration session."
Why the day is shaped as it is: `docs/notes/review-day.md`.

## First

1. If `.claude/orchestration/ruleset.md` is not already in your context, read it before proceeding: the session's first `Workflow` call is refused until it is read.
   This is not an orchestration session, so of that ruleset only the spawn cap and the load guard (Models and spawns) bind the day, and the audit day shares them.
   Its Session lifecycle does not apply: no continuation brief, no docket or follow-ups trigger.
2. Run in a Claude Code session on the host, from the repository root.
   The dev container's session shares this clone and is live: every agent reads at the pinned commit through `git show <sha>:<path>`, and nothing here edits the checkout.
   The day writes the board and `scratch/`, never the tree.
3. The rules that bind the day's agents are in the briefs under `.claude/review-day/`; this session passes their paths and reads none of them.

The day's directory `D` is `scratch/review-days/<date -I>/`, gitignored and host-local, and every artifact below goes under it.
The previous day is the newest other directory there that contains `FINAL/`, the one the slice cutter picks.

**Beside the audit day.** By default the review workflows run first, then this day's consolidation and filing, then the audit's trials (owner, 2026-11-06, on the design: "The rest is fine.").
The owner can reverse the order; the spawn cap and the load guard keep the two from running their spawns at once either way.

**Spend.** No default budget, ceiling, or cap applies, to the day or to its one extra (owner ruling, 2026-11-06, verbatim: "Sure, no cap.").
The day reviews the slices the slice cutter picks, less those the every-other-day rule cuts (Step 2), plus at most one same-day extra (Step 3).
It stops early only when its spend so far, read from the workflows' task notifications, passes twice the estimate the slice cutter printed: then it starts no further workflow, extra, consolidation or filing, writes the slices not run to `D/cut.md`, writes `D/summary.md` with the spend against the estimate and what ran, and reports to the owner, whose word resumes it at Step 4.
The retro judges the day by its cost per fix that merged.

## Step 1 -- Preconditions

Record each result in `D/preconditions.md`.
At the first that fails, write `D/summary.md` naming it, and stop.

- `gh auth status` succeeds.
- `git fetch origin staging`, then record `SHA`, the output of `git rev-parse origin/staging`.
- The previous day's `FINAL/record.json`, `FINAL/ledger.jsonl`, `FINAL/filed.md` and `FINAL/owed.md` are readable.
  A `FINAL/` with no `owed.md` stopped before Step 4 finished: finish that day's Step 4; one with no `filed.md` stopped before Step 5: finish that day's Step 5; then start the new day.
  With no previous day, record that, and the commit the window starts at, which Step 2 passes as `--prev`.
- `uptime`: the one-minute load is under about eight; otherwise wait and read it again.
- The newest `scratch/continuation-*.md` is readable, for the container's in-flight branches.

## Step 2 -- Slices

`node .claude/scripts/review-day-slices.mjs <SHA> <absolute D>`, adding `--prev <sha>` on a first day, writes `D/SLICES.md` and `D/plan.json` and prints the estimate.
A nonzero exit (1, a slice over the size bound; 2, a usage, git or board-read error) writes nothing: record its message as a failed precondition, write `D/summary.md` naming it, and stop.
`D/SLICES.md` opens with `Pinned sha: <SHA>.`, the line every brief reads the commit from.

Write `D/cut.md`, opening with two lines: `Estimate: <the printed total>.` and `Spend: none yet.`
Below them, one line per slice the day does not run, in the line form the slice cutter reads from `owed.md` (its header), so the consolidation copies it there:

    - <lens> | <the slice's backticked paths> | cut on <date>: <why> | -

The keep order, used to group the workflows and to choose what a stop leaves unrun: owed passes, census (lens 2), outward text (lens 3), hot files (lens 4), stale statements (lens 1), rotation.

**Every other day.** A lens other than lens 2 that landed no value unit on each of the two previous days runs every other day: when the previous day ran it, cut its slices to `D/cut.md`.
Judge it from the board at the start of the day: a lens landed a value unit on a day when an item that day's `FINAL/record.json` names as the outcome of one of its findings under that lens, mapped to its board item through that day's `FINAL/filed.md`, has a `Delivered by:` line (`.claude/pm/ruleset.md`, Task template).

## Step 3 -- Workflows

Group the remaining slices into workflows of four, in the keep order, named `W1`, `W2`, and so on.
Invoke the Workflow tool once per workflow, at most four at once, with `scriptPath` the absolute `<repo>/.claude/scripts/review-day-workflow.mjs` and these args, each job's id and lens taken from `D/plan.json`:

    {"day": "<absolute D>", "wf": "W1", "jobs": [{"id": "<slice id>", "lens": <1-4>}, ...]}

The script runs one Opus reviewer per slice, then a verifier (Opus for lens 2, Sonnet otherwise) for a slice with findings, then one Opus triage per workflow; its tiers and efforts are pinned in the script and not passed.
Each returns a triage summary of at most about 600 tokens.
Read nothing else from `D/W*/` in this thread, except one triage's owed-lines block for the extra below.
The workflow's agents read the briefs and the rule files from this checkout's working tree, not at the pinned sha, so do not move the checkout (no pull, checkout or rebase) while a workflow runs.

As each workflow's notification arrives, add its cost to `D/cut.md`'s `Spend:` line and apply the stop rule (Spend, above) before starting the next.

**The same-day extra.** When a triage summary names a major with files the reviewer did not open, or an UNVERIFIABLE security finding at major or above that a probe can decide, the day may spend once more, on one of these and never both:

- One further workflow of up to four slices.
  Append each slice to `D/SLICES.md` in the form the slice cutter writes (`## <id>: owed, lens <n>`, its Lines and Paths lines), from that triage's owed-lines block in `D/<wf>/TRIAGE.md`, each at most 8,000 lines by `git show <SHA>:<path> | wc -l`, then invoke it as above, `wf` the next free name.
- One measurement agent: spawn `general-purpose` with `model: "opus"` and `effort: "high"`, and this prompt, filled from the triage:
  "Read `<repo>/.claude/review-day/measure-brief.md` and follow it. Repository: `<repo>`. Day directory: `<absolute D>`. Output: `<absolute D>/M1/`. Question: <the finding, the two readings and what each would mean>. Read first: <the findings file, its verdict file, and the triage's rows>. Drive: <what to measure>."

Anything further is an owed line for the next day.

## Step 4 -- Consolidate

Spawn one `general-purpose` agent with `model: "opus"` and `effort: "high"`:
"Read `<repo>/.claude/review-day/consolidate-brief.md` and follow it. Repository: `<repo>`. Day directory: `<absolute D>`. Workflows: <each `wf` and its cost from the task notifications>. Slice cutter's estimate: <from `D/cut.md`>. Same-day extra: <none, or the workflow or `M1` it spent, and its cost>."

It writes `D/FINAL/`: `items/*.md`, `FILING.md`, `DOCKET.md` (owner calls only, absent when none), `RECORD.md`, `record.json`, `ledger.jsonl`, `owed.md`, and `host-checks.md` when a triage named a check only the host can make.

## Step 5 -- File

Spawn one `project-manager` consult with this prompt, the owner's words quoted as written; its definition pins its model:

    File <absolute D>/FINAL/FILING.md row by row: its items, its appends, and its Decision items.
    Run every gh call and board script with dangerouslyDisableSandbox: true.
    Pass every body by path (--body-file <absolute path>, or edit-issue.mjs --body-file), never inline.
    The owner's words, verbatim:
    "Fixes go into board issues, which get passed back to the dev container."
    "Yes, no need to wait. This is not an orchestration session."
    On security items: "Ordinary PR with fix wording."
    A security item's body may state the mechanism; its PR and commit wording describes the fix.
    Report each draft name with the board item it became (<board>/<itemId>), each append with its target, and each row not filed with the reason.

Write the consult's mapping to `D/FINAL/filed.md`, one line per draft: `<draft name> -> <board>/<itemId>`.
Then in `D/FINAL/owed.md`, replace each `draft:<name>` in a line's last field with the item filed for it, so the next day's slice cutter can read whether that fix was delivered.

The owner calls in `DOCKET.md` are the Decision items the consult filed.
If the owner is at the keyboard, present each in prose, one per message: its context, the options and their trade-offs, and a recommendation argued from `.claude/product-principles.md`.
Never open one with AskUserQuestion.
Otherwise they wait in the Decision column for the next docket.

If `D/FINAL/host-checks.md` exists, check it with `bash .claude/scripts/host-handoff.sh --check <path>` and name it in the summary as the owner's.

## Step 6 -- The summary

Write `D/summary.md` and end by printing its path:

- the sha and the window, from `D/SLICES.md`;
- slices run by lens and selector, lines read whole, slices cut and why;
- findings by severity after verification;
- items filed by board and kind, appends, limits, declined, held;
- the owner calls, each with its Decision item;
- the owed list's size, read in from the previous day and written out;
- the spend: by workflow from the task notifications, the extra, the consolidation, the filing, and the main session priced with the retro kit (`aggregate.mjs --only <this session>`, `.claude/scripts/README.md`, `retro/`), and the day's total;
- beside it, the fortnight's agent spend from the kit over the window's dates, and, when a reading of the plan's weekly allowance is available, the day's total as a share of it.
  The owner judges spend that way: "I think of spend in terms of percentages of the weekly token allowance."

Add the same spend figures to `D/FINAL/record.json` as `spend`: `{"day", "fortnight", "weeklyAllowanceShare"}`, the share `null` when no reading was available, so the retro reads them from the record.

Leave `D` in place: the items cite it, and the next day reads `FINAL/`.
