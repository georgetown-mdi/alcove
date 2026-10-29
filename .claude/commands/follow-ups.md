---
name: follow-ups
description: The session's last step -- decide its potential follow-ups with a PM consult, then do the board work in one pass -- filings, updates, the rulings and their consequences -- then housekeeping, close the continuation brief, and state any final action item only the owner can take.
---

The owner's instruction this command stands for:

> For any potential follow-ups, form your own opinions on whether or not they
> should be filed, balancing their potential benefit to users and the product
> as a whole against their implementation and opportunity costs. Then consult
> with a PM. If you both agree, have the issues filed, ensuring that they
> receive an appropriate epic and implementation order. If any others issues
> are affected by a filing or work done in this session, ensure that they are
> properly updated. Try to do all of the board work in a single pass. Include
> consequences of decisions from the decision docket. After that is done, do
> any relevant housekeeping and state if there are any final action items that
> are not open questions carried on future project issues.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- it holds the session rules this command's steps assume.

## Steps

Run only when the owner invokes this command; never start the board pass
unasked. Keep this pass in messages of its own, apart from any docket item.
It is the session's last step: the board alone holds the state afterwards.

1. If any branch is still in flight, wind down first as
   `.claude/commands/wind-down.md` does, without its readiness report and final
   hold.
2. List every open thread the session turned up -- each potential follow-up
   in PR bodies, review dispositions and agent reports, each confirmed review
   finding not fixed on a branch, each parked Decision item, each run still
   under way -- so none is left in prose alone. Each confirmed finding not
   fixed on a branch joins the potential follow-ups, and so does each
   shortlist candidate the continuation brief records as not taken: each is
   a board item already, so step 5 weighs it for an update, never a filing. For each potential follow-up,
   form your own opinion on whether to
   file it, weighing its benefit to users and the product against its
   implementation and opportunity costs, as `.claude/product-principles.md`
   sets out.
3. Consult the PM once over the whole list, through a `project-manager` spawn
   that holds the list, your opinion on each, the consequences of the docket's
   rulings, and the owner's instruction above quoted verbatim. The quoted
   instruction is the owner's delegation for the batch: relayed verbatim in
   the spawn prompt, it licenses filing every item you and the PM agree on
   (`.claude/pm/ruleset.md`, Filing and updating items).
4. File only what you and the PM both agree on, each with an epic and an
   implementation order. Write each held follow-up's outcome on its
   `Potential follow-up <slug>:` line in the continuation brief, as the PM
   ruleset's same section states. Raise a disagreement with the owner rather
   than settling it. One side conceding on evidence the other verified in the
   repository is agreement, not a disagreement to raise. A PM question that
   blocks nothing is carried in the filed item's Open questions and named in
   the report, never put to the owner mid-pass.
5. In the same pass, update every open item that a filing, the session's work,
   or a ruling affects, and write onto its item each ruling the session
   recorded -- the docket's, and each answer the owner gave mid-work -- in
   its verbatim text with its consequences, a revised ruling with its
   revision. `edit-issue.mjs --body-file` replaces the stored
   body with the file, so before each call check that the file is non-empty and
   holds the whole stored body, read in full, with the update added. A
   shortlist action line the session did not take -- a handoff brief not
   written, a Decision item not filed -- is written on its item as a dated
   line, "Brief owed since <date>: write, schedule or drop." or "Decision item
   owed since <date>: write, schedule or drop.", keeping the date of such a
   line already there, and listed in the report as a docket entry for the next
   session.
6. Do the relevant housekeeping: retire each finished worktree and each local
   branch the ruleset lets go, named or `worktree-agent-*`, as its Worktrees
   and checkouts section allows, and stop each watcher or background process
   the session started.
7. Make the continuation brief's first line `Closed out <date -I>: the board
   alone holds the state.`, so the next `/orchestrate` starts from the board.
8. Report in a few lines what was filed and updated. For each run still under
   way, print one sentence the owner can give a new session to watch it and
   act on its result. State the final action items: only what the owner alone
   can take and no board item carries, each with the one line the ruleset
   requires on why the session cannot; with none, say so in one line.
