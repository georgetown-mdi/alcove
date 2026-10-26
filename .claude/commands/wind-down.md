---
name: wind-down
description: Finish the session's work in flight, start nothing new, and hold -- each branch reaches its intended final state, then the session reports and waits for the owner's next command.
---

The owner's instruction this command stands for:

> When the PR lands and has green CI, hold before presenting the decision
> docket.

The bare command is that whole instruction. A note after the command -- a
branch to land first, an exception -- is acted on as the same note sent alone
would be.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- its Session lifecycle section defines this state.

## Steps

1. Start nothing new: take no new board item and spawn no agent for one. A
   review round, fix round or CI fix on a branch already in flight is part of
   finishing it, not new work.
2. Take everything already started to its full conclusion: each branch, run
   and host handoff. For an implementation branch that is a PR marked ready,
   its review rounds done and CI green on its head, as the ruleset's Review
   flow section describes; a step that branch's flow calls for -- its review
   rounds, its PR, a handoff its item needs -- is part of the branch and is
   taken, not skipped.
   For a run already under way -- a benchmark, a stress test, a host handoff --
   it is the run's result. The only thing not started is a new board item.
3. Keep the continuation brief current as each branch lands.
4. When everything started has concluded, report in a few lines: each branch
   and its PR, and what waits on the owner -- a host step, a ruling -- with
   what it waits on. A branch that cannot reach its conclusion without the
   owner -- a step-back trigger, a failure nobody can diagnose -- is parked as
   a Decision item and reported as waiting on that ruling; anything else
   unfinished is finished first, not reported. Say the session is ready for
   the docket, with your recommendation for what comes next, then hold.
   Start neither the docket nor the filing pass, and do not ask for them: the
   owner merges the PRs first, then fires the docket, and his next command
   picks the state.
