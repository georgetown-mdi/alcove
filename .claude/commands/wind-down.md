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
2. Bring each branch in flight to its intended final state. For an
   implementation branch that is an open PR with its review rounds done and
   green CI, as the ruleset's Review flow section describes; for a run already
   under way -- a benchmark, a stress test, a host handoff -- it is the run's
   result. A run not yet started is not started.
3. Keep the continuation brief current as each branch lands.
4. When nothing is left in flight, report in a few lines: each branch and its
   PR, and anything that could not land, with the reason. Then hold. Start
   neither the docket nor the filing pass nor a close-out; the owner's next
   command picks the state.
