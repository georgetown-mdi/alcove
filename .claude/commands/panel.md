---
name: panel
description: Convene a bounded expert panel on one settle-able design question -- independent panelists seated to suit the question, reading a clean staging checkout, no agent merging their answers, and an opt-in deliberation in which the same panelists revise their own answers. Whether to convene at all, and what its outcome decides, is the deferred-decision rule in `.claude/orchestration/ruleset.md`, Decisions, briefs and reporting (measure first; stakes gate); this command only runs a convened panel correctly.
---

You are CONVENING a panel, not sitting on it. You do not answer the question
yourself, and you do not tell the panelists anything you already believe about
it -- the round's value is answers formed without you.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- it holds the session rules this command's steps assume.

## Input

    /panel "<question>" [context-file ...] --seats <seat> ... [--deliberate]

- `<question>`: one settle-able question of technical judgment, phrased
  neutrally -- no candidate answer, no hint of which way you or the issue lean.
  If you cannot phrase it without a candidate, it is not ready for a panel.
- `[context-file ...]`: optional repo-relative paths (docs, specs) every
  panelist should read for context. Call this list DOCS; there may be none.
- `--seats`: required. The panelists to seat, at least two. Call this list
  SEATS. There is no default roster: without `--seats`, stop and name each
  seat and the dimension of the question it covers before convening. Choose
  seats for the dimensions the question has, never for the answer you expect
  and never by rote: a seat is not added because a note, a habit or an earlier
  panel had it. Your report names, for each seat, the dimension of the
  question it covers. The named seats:
  - `failure-modes`: correctness and failure modes.
  - `architecture`: architecture and maintenance cost.
  - `pragmatics`: operational and cost pragmatics.
  - `design-ux`: design and user experience -- user-facing flows, states,
    copy, and what the operator sees and does. Seat it when the answer changes
    what a user sees or does.
  - For a lens no named seat covers, state it as
    `{"name": "<short-name>", "lens": "<one paragraph>"}`, phrased as
    neutrally as the question.
- `--deliberate`: opt in to deliberation should the panel not converge
  (Step 3): a `panel-chair` agent runs the first round, and on a split resumes
  the same panelists, each reading the others' latest answers and revising its
  own. Without it, the first round is the panel Workflow, and a split panel
  goes straight to the owner.

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
whoever decides. Those two roles are the only side lenses, each spawned only
when the question has its dimension: never a `general-purpose` spawn given a
lens prompt, which on a security surface skips the refutation contract.

## Before the panel -- Test the premise and the option set

Panelists read code and run nothing, so a fact only a measurement can give
never reaches them unless you measure it first.

Before Step 1, for the question's premise and each option it names:

1. Write down the constraint that rules the option in or out, and the
   assumption the question rests on.
2. Check each one that is a fact of the code with one call, and measure each
   one that is a quantity -- a size, a time, a limit -- in your own tree, which
   has `node_modules`, or through a spawn that runs it.
3. A refuted premise or a new option reframes the question before any seat is
   convened, phrased as neutrally as before. A measured quantity that settles
   the question ends it here, as the ruleset's deferred-decision rule states,
   unless the owner asked for the panel: then the measurement goes to the
   owner with the question, and the owner decides whether the panel still runs.
   Otherwise the measurements go to the panel as a file in `<base>` named in
   DOCS (after Step 1), each stating the command, the number and its limits,
   and no reading of what it means for the options.

## Step 1 -- Clean base

Panelists read a clean mainline checkout, never your working tree: a candidate
edit sitting in the tree is a leading answer. Commit any work in progress (the
clean-tree hook blocks every Workflow call from a dirty tree), then make a fresh
directory with `mktemp -d` and check the mainline out into the path it printed,
the panel's `<base>`:

    git worktree add --detach <base> origin/staging

A base is never shared between panels: a fixed name would let a second panel
remove the first one's checkout while its panelists read it.

The base has no `node_modules`: anything that needs code RUN rather than
read is measured in the step before, never by a panelist.

## Step 2 -- Run the first round

Without `--deliberate`, invoke the Workflow tool with `scriptPath` set to the
ABSOLUTE path of
`.claude/scripts/panel-workflow.mjs` in this repository (`git rev-parse --show-toplevel`
gives the root) -- the bare relative spelling fails the call with "script file
not found" -- and `args` set to
`{"question": "<the question>", "base": "<base>", "docs": [<DOCS, possibly empty>], "seats": [<SEATS>]}`, for example
`"seats": ["failure-modes", "design-ux", {"name": "accessibility", "lens": "..."}]`.
The script refuses a call with no `seats`.

The script is checked in and passed by path: do not paste its text into the call
and do not copy it out to edit it -- it spawns one panelist per seat on the tier
`.claude/scripts/panel-script.test.mjs` pins, the same tier for every seat. It
returns the first round, `{round: "first", question, base, docs, seats, positions}`,
where `positions` holds each panelist that answered as
`{seat, position, rationale, keyRisk}`; every one was formed before any
panelist saw another's.

With `--deliberate`, the panel chair runs the first round on the same
briefing: `.claude/scripts/panel-relay.mjs` takes each seat's prompt from the
Workflow script itself, and adds only where to write the answer.

1. Make the panel's answer directory with `mktemp -d`; call the path it
   printed `<dir>`. With the Write tool, write `<dir>/panel.json` holding the
   values the Workflow would take,
   `{"question": "<the question>", "base": "<base>", "docs": [<DOCS>], "seats": [<SEATS>]}`,
   plus `"extraRounds": <n>` only when the owner asked for a cap other than
   two rounds after the first.
2. Run `node <repo>/.claude/scripts/panel-relay.mjs <dir> next`, `<repo>` the
   repository root: it prints `round 1`, or names what `panel.json` gets wrong.
3. Spawn one background Agent with subagent_type `panel-chair` (its definition
   pins Opus) and the prompt
   `Answer directory: <dir>. Repository root: <repo>. Run the first round.`
   Keep its agent id for Step 3.
4. Its report names `<dir>/record.json`, which `panel-record.mjs` wrote. The
   record's `panelists` holds each seat's `first` and `final` answer, the same
   after the first round, and `rounds` every round's answers. A `problem:`
   line in the report means the record failed a check that it is the
   panelists' own work: that is contamination evidence (Step 3), and the
   problems go to the owner with the positions.

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
   deliberation, and only when `--deliberate` was given: before going to the
   owner, send the chair one SendMessage, `Run the later rounds.` It resumes
   the same panelists, each reading the paths of the others' latest answers
   and writing `{position, rationale, keyRisk, changed, movedBy}`, until every
   seat reports `changed: false` or `extraRounds` rounds past the first have run
   (two unless `panel.json` sets another whole number, with no upper bound).
   A panel with no consensus after those rounds is inconclusive: report it as
   such rather than running more. Its report names the
   record again. Take the question to the owner with each seat's `first` and
   `final` position from the record's `panelists` and the record's path: a
   converged deliberation informs the owner and settles nothing.
3. A Workflow panelist that returned null exhausted its schema retries and is
   missing from `positions`; its analysis is usually intact in the rejected
   attempts in its transcript -- salvage it. A deliberating seat with no
   answer in a round is in the record's `rounds` with the reason, and its
   `final` is its latest answer. Two or more surviving panelists that all
   agree still converge; otherwise treat the round as split.
4. Copy a deliberating panel's `<dir>/record.json` into `scratch/panels/`.
   Remove the worktree, `git worktree remove <base>`, once the question is
   closed: a deliberating panel's base stays until the owner has answered,
   since new input resumes its panelists on it.

Deliberation is a decision taken, opt-in and bounded as above: a split panel
may be missing a consideration only one panelist raised, and independence
holds because every first position is formed and recorded before any
panelist sees another's, every later one is the panelist's own file, and
`panel-record.mjs` checks the chair relayed only what `panel-relay.mjs`
prints.

## New input for a panel already run

When the owner asks to feed new input to a deliberating panel whose `<dir>`
and `<base>` are still on disk, write the input, as the owner gave it and
phrased as neutrally as the question, to `<dir>/input-r<N>.md`, N one past the
last of the record's `rounds`, and send the chair one SendMessage,
`Run the later rounds.` It resumes the same panelists, who read the input
with the others' latest answers; up to two more rounds follow it, and the
record holds them all.

For a Workflow panel, or a deliberating one whose directory is gone, the
session puts the route to the owner -- a new panel whose question or docs
carry the input -- and runs it only once the owner answers.

## What you do NOT do

- Do not vote yourself, and do not weight verdicts by which you prefer.
- Do not tell panelists your view or the issue's lean, and do not pass one
  panelist's answer to another: in a deliberation the chair sends only the
  paths `panel-relay.mjs` prints.
- Do not use a panel's output to satisfy any review obligation.
