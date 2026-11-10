---
title: "The Review Day"
---

# The review day: why it is shaped as it is

_Status: agent-written design, built as the command and its briefs; a proposal until the owner ratifies it.
The steps are in [`.claude/commands/review-day.md`](../../.claude/commands/review-day.md), the agents' rules in the briefs under `.claude/review-day/`, the slice cutter in [`.claude/scripts/review-day-slices.mjs`](../../.claude/scripts/review-day-slices.mjs) and the workflow in [`.claude/scripts/review-day-workflow.mjs`](../../.claude/scripts/review-day-workflow.mjs).
This note gives the reasons.
See [docs/notes/README.md](README.md)._

## What the day is for

Per-branch review rounds read diffs.
On the Fridays between retros, the review day re-reads the code a fortnight of pull requests made worth re-reading, whole, and files what it finds as ordinary board items for the dev container to fix.
The owner's words that set it: "Fixes go into board issues, which get passed back to the dev container." and "Yes, no need to wait. This is not an orchestration session."

The evidence below is from the first whole-repo review pass, run on 2026-11-06 over 48 slices, and from `origin/staging` over the window 2026-10-23 to 2026-11-06 (290 merged pull requests).

## Where per-branch rounds miss

- Hot files that rounds only ever see as diffs: three files of 2,900 to 3,900 lines were each edited 15 to 19 times in the window.
- Twin copies of one check that drifted, because rounds reviewed them one at a time.
- A stated limit whose precondition a later pull request broke, unnoticed.
- Outward claims written by a pull request that three rounds reviewed and passed.
- Code no per-branch round touched: 6 of the 10 security majors were there.

The slice cutter's selectors aim at these: census changes (new listeners, handlers, deserializers and key writes), hot files, outward text, the spec statements that name changed code, and one rotation slice over the directory read longest ago.
An earlier whole-repo review does not use up the value of another, which is why rotation exists.

## Why a slice is at most 8,000 lines and read whole

- The first-pass security slices were 89,000 and 118,000 lines and found no major.
- The targeted passes that read 7,000 to 13,000 lines per slice whole found 3 of the 10 security majors and every partner-reachable defect.
- One targeted slice of 19,000 lines left 20 of its 44 files unopened, still found a major, and needed a further pass over the files it skipped.
- The three slices of one targeted pass read 24,500 lines whole between them, about 8,000 each.

Cost scales with slices, not with lines in a slice, once a slice is small enough to read whole: a slice too large to read costs the same and finds less.
So every slice is a targeted slice, a file listed but not read whole is a defect the triage turns into an owed line rather than a reviewer's choice, and the reviewer brief has no priority-order fallback.
The 8,000-line bound and the 45,000-line hot-file target are working values fitted from that one pass.

## Lens yield

Measured on the first pass, each figure including reviewer, verifier and the triage's share:

- Lens 3, outward claims and copy: $14.92 for 32 findings, 11 of them major, all in text per-branch rounds had reviewed and passed; $1.36 per major, the cheapest by a factor of five.
- Lens 4, simplification: $0.49 per finding, 8 majors in 208, 45 raised before and still true.
  It is the owner's named ask, the pitfalls of agent-driven development, but most of its findings became internal limits or held structural lines.
- Lens 2, security: $1.66 per finding in the wide slices and $3.12 in the targeted ones, but the targeted ones found the majors.
- Lens 1, specs against code: $2.29 per finding ($25.22 for the 11 findings of its one single-lens pass, the $8.41 slices below), no major, 22 of 35 nits across every pass that ran the lens.
  Its one real miss class is the specs a diff makes stale, which a per-branch round does not check, so lens 1 reads the statements that name changed code rather than whole specs.

## Why lens 3 runs first after census

Lens 3 is the cheapest per major, and its findings are the ones a reader outside the project acts on.
A quiet fortnight or an early stop still runs census (lens 2) and outward text (lens 3): they come first in the keep order after owed passes.
The only rule that can skip lens 3 is the yield rule, which reads delivered units from the board: a lens other than lens 2 that landed no value unit on two days in a row runs every other day until it lands one.
The retro, not the day, moves the default lens mix.

## Why four sorts replace the docket

The first pass's triage brief sent "a fix that needs a maintainer ruling on a control" to the docket, and the docket asked the owner for about 60 rulings.
His correction: "I'm not going to decide on these, am I? It sounds as if they are actual bugs and should be addressed? If so, shouldn't they become issues and not decisions?"
Re-sorting the 43 docket lines by who asked for each control gave 18 fixes, 16 PR-review readings, 2 not built, and 7 owner-call lines; after the re-sort, 5 decisions remained from 372 findings.

The triage now applies that rule to every line: a control a spec line, the threat model or the application roles ask for, with a recommendation that blocks no legitimate use and invents no number, is a fix; a control nobody asked for is not built; an accepted limit or a wording is read in PR review; only a product, scope or priority call, an invented bound that blocks a use, a step costing the owner's time, or a trade-off awaiting a measurement reaches him.
Structural proposals never do: he asked for the lens.

Security findings go to ordinary items with fix wording for their PRs and commits, under the owner's ruling "Ordinary PR with fix wording."; the item records whether the flaw is on `origin/main` and in a tag, so the handling can change once a release exists.

## Verifier and measurement

The verifiers narrowed 137 of 372 findings and refuted 2, and the narrowings are what kept overstated findings off the docket, so every slice with findings keeps a verifier.
The one measurement of the first pass turned a High-or-Low question no read could decide into a Low with a limits line, and removed a decision from the owner; that is the case for the day's one same-day extra.

## Spend

The owner's ruling on the day's spend, verbatim: "Sure, no cap."
The day runs the slices the cutter picks, plus at most one same-day extra, and stops early only when its spend passes twice the cutter's estimate.
The owner judges spend as a share of the weekly allowance ("I think of spend in terms of percentages of the weekly token allowance."), so the summary states it that way when a reading exists, beside the fortnight's agent spend.
The retro judges the day by its cost per fix that merged.

Unit costs the first review pass measured, from which the slice cutter's working values started, each including reviewer, verifier and the triage's share.
The cutter's `WORKING_VALUES` in [`.claude/scripts/review-day-slices.mjs`](../../.claude/scripts/review-day-slices.mjs) holds the current ones, which each retro re-fits:

| Unit | Cost | Basis |
|---|---|---|
| Lens-2 targeted slice, read whole, Opus verifier | $7.36 | 11 slices, $81.00 |
| Lens-4 slice, Sonnet verifier | $6.39 | 16 slices, $102.21 |
| Lens-3 slice | $4.97 | 3 slices, $14.92 |
| Lens-1 slice | $8.41 | 3 slices, $25.22 |
| Any slice, mean | $7.18 | 48 slices, $344.83 |
| Consolidation over 14 triages | about $17 | the first pass's consolidation agent, 2026-11-06 |

Per finding $0.93, per major $11.49, per behaviour-changing finding $5.75.

## Beside the audit day

Both days run on the host and both are not orchestration sessions; they share the four-writing-spawn cap and the load guard, so their spawns do not overlap.
The review workflows run first by default, since four parallel workflows of four slices ran unattended in about 90 minutes, then the consolidation and filing, then the audit's trials.
They route differently by design: an audit problem is a Decision item the owner reads first, because it is about what a person saw on a screen; a review finding is an ordinary work item, and only an owner call reaches the Decision column.

## The pinned commit

Every agent reads at one commit through `git show`, because the container's session shares the clone and moves its checkout.
The workflow's prompts name only the day directory, so the briefs read the commit from the `Pinned sha:` line the slice cutter writes at the head of the day's `SLICES.md`.

## What the retro re-fits

The day writes `FINAL/record.json` for the retro, which reads it and the board and never the findings files:

- cost per landed value unit by lens over the window's days, and the default lens mix re-fitted from it;
- the slice bound, from lines read whole per slice against findings, and the hot-file line target, from which selector's slices landed units;
- what per-branch rounds keep missing, by kind, which tells the retro where a round's lens or claims need a change;
- owner calls per day, against a target near zero, and corrections to the day's filings.

A value unit counts when the item a finding was filed on has a `Delivered by:` line: for lenses 1 and 2 a behaviour-changing fix merged with a test that fails on the old code, for lens 3 an outward claim corrected, for lens 4 a structural proposal ratified or a trim merged.
