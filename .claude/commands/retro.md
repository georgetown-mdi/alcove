---
name: retro
description: Run the fortnightly retrospective on the host -- price the window with the kit, read each earlier ruling against its predicted number, count the owner's turns and corrections, replay every proposal that states a number, file the retro's own items as each step lands, and put to the owner only the decisions that are his, one per message.
---

    /retro [notes: the window's end, a scout to add this once]

A retro runs on the Fridays without a review day, on the owner's machine, over both transcript stores, in one sitting; never a cloud or scheduled agent (owner ruling, 2026-10-23).
It reads records and changes rules.
It is not an orchestration session: it has none of the five lifecycle states, no continuation brief, no compact-prep, no wind-down, no shortlist, and no follow-ups pass.
It writes the board and `scratch/`, never the tree: a rule or script it wants is a board item for the container.

## First

1. If `.claude/orchestration/ruleset.md` is not already in your context, read it before proceeding.
   Its Models and spawns and its Decisions, briefs and reporting sections bind every spawn and presentation here.
   Its Session lifecycle does not apply: the docket and follow-ups triggers gate nothing in a retro.
2. The retro's directory `D` is `scratch/retro-review-<date -I>/`, gitignored and host-local.
   `D/STATE.md` is the retro's only running record: the window, each step's result in one line, the owner's words verbatim, and what runs next.
   After a compaction, `/retro` resumes from it.
3. The previous retro's directory is the baseline: its kit outputs under `R1/`, its owner-turn labels under `S7/`, and its STATE.md, which names the window's end.
   Read its anchor from the retro item on board 10.

## Step 1 -- The window

Cut: the previous retro's end. End: now.
PRs: `gh pr list --state all --search "created:>=<cut>"` as `map.mjs`'s header gives.
Before extracting, confirm each store's oldest transcript predates the cut and record any gap.
Exclude this session and the previous retro's from every process measure.

## Step 2 -- The scripted reading

No judgment here; bare scripts, or one Sonnet spawn where a script is not yet a kit step.

- The kit's four steps over both stores into `D/R1/` (`.claude/scripts/README.md`, `retro/`), then the trend table against the baseline:
  per-day beside per-PR, the fixed size cuts 65 / 451 / 1,203 changed lines, a bootstrap interval over days on every ratio, and a row called moved only when 1.0 lies outside it.
  Rows: spend per day; merged PRs per day; cost per merged PR, standardized to the baseline's size mix; owner turns per day and per PR; main-session cost per PR; review apparatus plus fix implementers per PR; majors per lens round and the verifier's refuted share; compactions manual and auto, and owner turns on compaction; implementer runs with peak context over 500k; follow-ups per 100 merged PRs, planned and unplanned, leaving out PRs titled Bump and links made only through package manifests or image pins; docket count, owner turns and share; the review day's dollars per unit by lens and its escape count; the audit day's problems found and fixed.
  Until the kit has a trend step, scout A (Step 3) builds the table from the 2026-11-06 retro's scripts: `scratch/retro-review-2026-11-06/R2/`, `scratch/retro-review-2026-11-06/S7/compare.mjs` and `scratch/retro-review-2026-11-06/F1/`.
- `node scripts/check-expiry-dates.mjs --expiring-before <the retro after this one>`: renew or delete each entry, per its header.
- The ledger quartiles against the thresholds `review-round.md` quotes: an edit only when a quartile moved more than 20%.
- Parked triggers: the retro re-tests them itself.
  On each of boards 9 and 10, every trigger `node .claude/scripts/list-issues.mjs --parked <N>` lists is answered, as `.claude/pm/ruleset.md`, Task template, states:
  a trigger that fired loses its line and the item is a candidate again; one that cannot be answered yes or no is rewritten.
- Agent-memory notes written or changed since the cut, in the container store and the host folder: each is a repository rule, an owner preference or a host-local fact.
  A rule names the repo file that binds its reader and is moved there, as `CLAUDE.md`, Boards and PM, requires; the store keeps only owner preferences and host-local facts.
- Commands, skills, hooks and scripts added since the cut, and their uses in the transcripts; one with no real use in two retros is proposed for retirement.

File the reading's mechanical corrections now through one `project-manager` spawn: fired triggers unparked, a verdict an item waits on, a memory rule's move, a retirement.

## Step 3 -- The standing scouts and the triggered ones

One brief, `D/BRIEF.md`, shared ground rules then one section per scout:
read-only outside `D/<id>/`; full coverage where a script can do it and a stated frame where reading is needed; a stated bound is a result; every claim opened at its evidence; impact in dollars per window, owner turns per window, or defect risk on a named surface; no earlier retro report read except the baseline named; a final reply under 600 tokens.
Spawn them in one message, each with a literal model and a cost cap on the agent; hold a spawn while the load average is above about eight.

- A, rulings and the trend table (Opus, cap $6): for each ruling of the previous retro that states a number, met, missed or inconclusive, read by mechanism and within the fixed size cuts, never by the aggregate alone; each moved row of the trend table with its cause named or marked unexplained.
  Until the kit has a trend step, A first builds the table from the scripts Step 2 names.
- B, owner turns (Opus, cap $8): every owner turn in both stores, classified; first a 20-item re-label of the baseline's labelled corrections, agreement reported; each correction cluster counted against the baseline its rule was written for; the docket's count, turns and rulings that differed from the recommendation.
  A rule whose cluster did not shrink is named for revision or deletion.
- C, landings (Sonnet, cap $4): each item the previous retro filed, its delivering PR and each criterion against the tree, met, partly or not.

Then, from the reading and A's report, at most two dimension scouts (Opus, cap $6 each), only for a moved row no ruling predicted or a missed number whose cause A could not name.
Named candidates: compaction losses and the optimum; the main session's triage share; follow-ups joined to the review ledgers (had the round raised it?).
A harness-behavior question goes to a Sonnet `claude-code-guide` lookup, cap $1.
A plan critic runs only when the retro's standing shape changes.

## Step 4 -- The replay

One Opus spawn, cap $15, `D/REPLAY.md`: every proposal in the scouts' files that states a number, replayed by a second route (its own scan, git, the kit's outputs as instrument data); HOLDS, REVISED with the replayed number, or REFUTED.
A refuted proposal is dropped.
A revised one uses the replayed number from here on.

## Step 5 -- Act, then decide

Sort every surviving lead by who decides it:

- A filing: anything agents can do under the existing rules -- a script, a kit row, a template line, a memory move, a retirement, an item's correction, a rule revision whose cluster did not shrink.
  One `project-manager` spawn files them now, each with an epic and order, the owner's instruction for the retro quoted verbatim in the prompt.
  Each item that changes a rule states the number it predicts and the window it is read in.
- The owner's call: revising or reverting a ruling he gave in his own words; a change that spends his turns or changes what he reads; a change to this command's standing shape.
  Present these only, one per message, in prose: the ruling as he gave it, what its number did and by what mechanism, the options with their cost in his turns and in dollars and what each means for the product, and a recommendation.
  Record his words verbatim in `D/STATE.md` and have the PM consult write each ruling to its item at once, with the number it predicts and the window it is read in.
  Never open one with AskUserQuestion.

Expect one to three decisions.
A line he would answer "sure" with no reason is a filing, not a decision.

## Step 6 -- Close

- Append the previous rulings' verdicts to their items.
- Rewrite the retro item to the next anchor: the cut (this retro's end), the baseline (`D/R1/`), the rulings due a reading with their numbers, and any triggered scout still to run.
  Present it as a record; it is a decision only when a real option exists.
- Price the retro with the kit (`aggregate.mjs --only <this session>`) and append the line to the item: agents by scout, main session, owner turns.
  The line states the retro's dollars and, beside them, its share of the weekly allowance when the review day's record reports one; otherwise it states the dollars alone and says the share was not reported.
- Delete the retro's temporary directories by literal path.
  Leave `D` in place: the next retro's baseline and the items cite it.
