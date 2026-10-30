---
name: docket
description: Present the decision docket to the owner -- every open decision on its list that is not a potential follow-up, the session's parked ones and the ripest in the Decision column, at least as many as the session filed there -- one decision per message, and record each ruling and act on it when given.
---

The owner's instruction this command stands for:

> Present each item in the decision docket that is not a potential follow-up,
> one message per item. Give me the context necessary to make the decision in
> plain language, options and their tradeoffs, and recommendations. Save
> executing decisions until I say so.

The owner revised its last sentence on 2026-10-29: "When I make a decision mid
orchestration, I'm doing so so that it can be acted on." A ruling is therefore
acted on when given, and only its board writes wait.

The bare command is that whole instruction, so the owner never types it out. A
note after the command -- a merge report, a handoff result path -- is acted on
first, as the same note sent alone would be. To land the work in flight and
hold before the docket, the owner runs `/wind-down` first.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- its decision rules are the ones this command applies.

## Build the list

Run only when the owner invokes this command; never start the docket unasked.

1. Collect the open decisions from the Decision column of boards 9 and 10
   (`node .claude/scripts/list-issues.mjs --status Decision <board>`): those
   the session parked, then the ripest of the rest, until the list holds at
   least as many items as the session filed in the column since the last
   docket, its survey filings included (`.claude/orchestration/ruleset.md`,
   Session lifecycle). The column trends toward zero across dockets and is
   not drained in one: the rest stay in it for a later docket. Every item the
   steps below keep is presented, and when they leave fewer than that floor,
   collect the next ripest until they keep it. Leave out each
   potential follow-up -- a question of whether to file or update a board item;
   those wait for `/follow-ups` -- and each ratification of a judgment a branch
   already took, which the scoring below filters. Leave out each operation
   too -- a step whose way forward no option changes, such as a run, a check, a
   filing or a host-side step: do it, or hand it off, as the ruleset's line on
   why the session cannot do something itself requires. An item is a decision
   only when its options differ in their effect on users or the product.

   Judgment calls are scored, not walked line by line. Write the session's own
   closing list, one line per ratification, then invoke the Workflow tool with
   `scriptPath` set to the ABSOLUTE path of
   `.claude/scripts/judgment-call-controversy-workflow.mjs` in this repository
   (`git rev-parse --show-toplevel` gives the root) and `args` set to
   `{"since": "<when the last docket ran>", "sessions": [{"name": "<session>", "prs": [<its PRs since then>], "sources": [<the files recording its calls>], "notes": "<optional>"}], "closingList": [<the lines>]}`,
   one `sessions` entry for each session that worked since the last docket.
   It gathers every judgment call since then and has two independent lenses
   judge each one and each closing-list line. For each session and for the
   closing list it returns `presented`, the lines either lens flags, ranked by
   score with each lens's verdict and reason, and `standing`, the lines both
   lenses scored uncontroversial; `problems` names any line a lens left
   unscored, which is presented; a problem saying a session's gatherer returned
   nothing means none of that session's calls were judged or shown, so re-run
   that session or read its sources by hand before the docket goes on. A
   standing line is not presented: record it as standing, the same way as a
   ruling. Record the result's `excludedAsRuled` and `skippedPrs` lines, which
   no lens judged, beside the standing lines, each excluded line with the
   ruling it cites. A presented line is checked against
   standing rulings as step 2 says before it becomes a docket item, and one a
   ruling already decides goes to `/follow-ups` as a defect against that
   ruling. The gathered lines left become docket items, broken out by session;
   the closing-list lines left each get their own message after the last
   decision item, headed "Ratification N of M" and laid out as the Present
   section sets out, with its score and both lenses' reasons, and the owner's
   word on each is recorded the same way as a ruling.
2. Drop any item the owner has already ruled on, in this session or in a board
   item or repository file. To find such a ruling, run
   `node .claude/scripts/find-rulings.mjs <the decision's 2-3 subject words>`
   and read every hit's body section in full: a ruling found there, a "not to
   be re-raised" line above all, drops the item and is cited on the originating
   item instead. A default or behavior the user docs (`docs/` outside `docs/notes/`, and `docs/spec/`)
   document is the ruling on what the behavior is, so an item asking that
   question is answered and not filed; a proposal to change a documented
   default is presented only with that ruling cited, and only on a changed
   assumption or a new driver the item names. As a second net, fetch
   the item's epic siblings
   (`node .claude/scripts/list-epic.mjs <project> "<Epic>"`) and every item its
   body names (`node .claude/scripts/fetch-issues.mjs <project> <itemId> ...`),
   and cite the ruling in the item's background when one bears on it. A
   decision with no board item is filed as a Decision item first (the ruleset's
   "the board is the only queue"), so the item, its board and its epic are
   always known.
3. Read each item's whole body, its newest Ruling section first, then
   re-verify its assumptions against the current repository and
   boards before presenting it: rulings landed since it was filed, pull
   requests merged, and every path it cites still present at
   `origin/staging`. An item a changed assumption answers is dropped; one it
   changes is presented with the change stated in its background.
4. One decision per item: an item holding two decisions is two items, never
   sub-questions under one.
5. Number the items once, as N of M, and keep that numbering to the end.
6. Before presenting an item that touches screen copy, a user flow, CLI
   ergonomics, or a consent surface, spawn `ux-reviewer` on the code it
   concerns. An item on a security surface has each premise its background
   rests on measured by the session on `origin/staging`, one call per
   premise: `security-reviewer` runs only as a `/review-round` role round,
   which needs a branch diff a docket item does not have. The review's
   findings and the measured premises go into the item's background.
   An item on a security surface also takes a `/panel` round, its seats chosen
   for the question's dimensions as `.claude/commands/panel.md` says.

## Present, one message per item

Each message holds exactly one item and ends the turn:

- A heading: "Docket item N of M: <what is being decided, in words>".
- Background, in plain language: what exists, what is in question, and who it
  affects.
- The options, each with its effect on users and the product and its cost to
  development -- costs and benefits, not line counts. Name each by what it
  does, never by a bare label like "A1". One option is the design that gives
  the best user experience, even one that redesigns the approach, priced
  against what merged code already provides.
- One recommended option, with its reason in a sentence or two, argued as
  `.claude/product-principles.md` sets out.

An option the ruleset's proposal rule covers (`.claude/orchestration/ruleset.md`,
Decisions, briefs and reporting) carries that rule's line; an item whose such
option lacks it is not presented until it has one.

Never open the item with AskUserQuestion, and never put a follow-up filing in a
docket message.

## Record and act on each ruling

Record each ruling verbatim as the owner gives it, in the session's own
record -- `scratch/docket-<date -I>/rulings.md` and the continuation
brief -- then present the next item. A
question the owner asks is not a ruling: answer it, say the decision is still
open, and end the turn; record a ruling only when the owner's words pick an
option. A ruling is acted on when given, from that record, as the ruleset says
of a mid-day docket (`.claude/orchestration/ruleset.md`, Session lifecycle);
only its board writes wait. When no item is left, say so in one line.

The rulings' board consequences -- status moves, each ruling recorded in its
item's body, epic and order placement -- go to the boards in one pass with the
filings you and the PM agree on, the follow-ups pass
`.claude/commands/follow-ups.md`, Steps, makes. A ruling goes into a body
through `edit-issue.mjs --body-file`, which replaces the stored body with the
file: before the call, check that the file is non-empty and holds the whole
stored body, read in full, with the ruling added.
