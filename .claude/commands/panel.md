---
name: panel
description: Convene a bounded expert panel on one settle-able design question -- independent schema-forced panelists seated to suit the question, reading a clean staging checkout, one Workflow, no consolidator, and an opt-in single deliberation round. Whether to convene at all, and what its outcome decides, is the deferred-decision rule in `.claude/orchestration/ruleset.md`, Decisions, briefs and reporting (measure first; stakes gate); this command only runs a convened panel correctly.
---

You are CONVENING a panel, not sitting on it. You do not answer the question
yourself, and you do not tell the panelists anything you already believe about
it -- the round's value is answers formed without you.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- it holds the session rules this command's steps assume.

## Input

    /panel "<question>" [context-file ...] [--seats <seat> ...] [--deliberate]

- `<question>`: one settle-able question of technical judgment, phrased
  neutrally -- no candidate answer, no hint of which way you or the issue lean.
  If you cannot phrase it without a candidate, it is not ready for a panel.
- `[context-file ...]`: optional repo-relative paths (docs, specs) every
  panelist should read for context. Call this list DOCS; there may be none.
- `--seats`: the panelists to seat, at least two. Call this list SEATS; with
  none given, the panel seats `failure-modes`, `architecture`, and
  `pragmatics`. Choose seats for the dimensions the question has, never for
  the answer you expect. The named seats:
  - `failure-modes`: correctness and failure modes.
  - `architecture`: architecture and maintenance cost.
  - `pragmatics`: operational and cost pragmatics.
  - `design-ux`: design and user experience -- user-facing flows, states,
    copy, and what the operator sees and does. Seat it when the answer changes
    what a user sees or does.
  - For a lens no named seat covers, state it as
    `{"name": "<short-name>", "lens": "<one paragraph>"}`, phrased as
    neutrally as the question.
- `--deliberate`: opt in to one deliberation round should the panel not
  converge (Step 3). Without it, a split panel goes straight to the
  owner.

Whether a panel should run at all, and whether its outcome settles the
question or goes to the owner, is not this command's call: the deferred-decision
rule in `.claude/orchestration/ruleset.md`, Decisions, briefs and reporting,
holds the stakes gate, the measure-first rule, and what each outcome decides. A
panel's conclusion answers a design question; it is never a review round -- it
does not enter `scratch/review-rounds/` and does not satisfy the PR checklist's
Security review line.

A question that touches screen copy, a user flow, CLI ergonomics, or a consent
surface also takes a `ux-reviewer` spawn on the code it concerns, besides the
`design-ux` seat; one that touches a security surface takes `security-reviewer`,
run under the refutation contract in `.claude/orchestration/ruleset.md`,
Review flow; one that
touches both takes both. Their findings go beside the panel's positions to
whoever decides.

## Step 1 -- Clean base

Panelists read a clean mainline checkout, never your working tree: a candidate
edit sitting in the tree is a leading answer. Commit any work in progress (the
clean-tree hook blocks every Workflow call from a dirty tree), then make a fresh
directory with `mktemp -d` and check the mainline out into the path it printed,
the panel's `<base>`:

    git worktree add --detach <base> origin/staging

A base is never shared between panels: a fixed name would let a second panel
remove the first one's checkout while its panelists read it.

The base has no `node_modules`: a question that needs code RUN rather
than read is out of this command's scope -- measure it yourself first instead.

## Step 2 -- Run the panel Workflow

Invoke the Workflow tool with `scriptPath` set to the ABSOLUTE path of
`.claude/scripts/panel-workflow.mjs` in this repository (`git rev-parse --show-toplevel`
gives the root) -- the bare relative spelling fails the call with "script file
not found" -- and `args` set to
`{"question": "<the question>", "base": "<base>", "docs": [<DOCS, possibly empty>], "seats": [<SEATS>]}`,
leaving `seats` out for the default three. For example,
`"seats": ["failure-modes", "design-ux", {"name": "accessibility", "lens": "..."}]`.

The script is checked in and passed by path: do not paste its text into the call
and do not copy it out to edit it -- it spawns one panelist per seat on the tier
`.claude/scripts/panel-script.test.mjs` pins, the same tier for every seat. It
returns the first round, `{round: "first", question, base, docs, seats, positions}`,
where `positions` holds each panelist that answered as
`{seat, position, rationale, keyRisk}`; every one was formed before any
panelist saw another's.

## Step 3 -- Read the verdicts and close

1. Every position aligned: converged. Whether that settles the question or
   informs the owner's decision is the ruleset's deferred-decision rule;
   either way, record in your report the question, the conclusion, and one
   line of rationale per panelist.
2. Any dissent, even one the majority's rationale answers: the panel is split.
   Take the question to the owner in prose with each returned position. Do
   NOT re-run the panel -- a re-run is for contamination evidence only (a
   panelist read a candidate edit or was told a preferred answer), never for
   disagreement, and never because agreement came quickly. The one exception is
   the deliberation round, and only when `--deliberate` was given: before going to the owner,
   invoke the Workflow once more, same `scriptPath`, with `args` set to
   `{"deliberate": <the first round's result, verbatim>}`. Each panelist that
   answered sees its own first answer and the others' and may revise once. The
   result, `{round: "deliberation", note, question, base, docs, seats, panelists}`,
   holds each panelist's `first` and `revised` positions side by side
   (`revised` is null where the revision failed). The script refuses anything
   but a first round's result, so a deliberation cannot be deliberated again;
   run it at most once per panel. Take the question to the owner with both
   positions per panelist: a converged deliberation informs the owner and
   settles nothing.
3. A panelist that returned null exhausted its schema retries and is missing
   from `positions`; its analysis is usually intact in the rejected attempts in
   its transcript -- salvage it. Two or more surviving panelists that all
   agree still converge; otherwise treat the round as split.
4. Remove the worktree: `git worktree remove <base>`.

The deliberation round is a decision taken, opt-in and bounded as above: a
split panel may be missing a consideration only one panelist
raised, and independence holds because every first position is formed and
recorded before any panelist sees another's.

## What you do NOT do

- Do not vote yourself, and do not weight verdicts by which you prefer.
- Do not tell panelists your view or the issue's lean, and do not pass one
  panelist's answer to another outside the deliberation round.
- Do not use a panel's output to satisfy any review obligation.
