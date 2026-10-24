---
name: close-out
description: End the session -- wind down, leave every open thread where the next session finds it (a continuation brief, or the board alone on a clean break), do the housekeeping, and report only the final action items the owner alone can take.
---

The owner's instruction this command stands for:

> When all of the PRs land, print a message that I can use to finish the
> session in a new one, going over the docket, follow-ups, and housekeeping.

    /close-out [clean]

- `clean`: a clean break. No continuation brief: the filing pass runs now, so
  the board alone holds what the next session needs, and that session starts
  fresh.

The bare command is the whole instruction. A note after the command is acted
on as the same note sent alone would be.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- its Session lifecycle section defines this state.

## Steps

1. Wind down as `.claude/commands/wind-down.md` does, without its final hold.
2. List every open thread: each confirmed review finding not fixed on a
   branch, each potential follow-up, each parked Decision item, each run still
   under way. None is left in prose alone as something for later.
3. Housekeeping: retire each finished worktree and each local branch the
   ruleset lets go, named or `worktree-agent-*`, as its Worktrees and checkouts
   section allows, and stop each watcher or background process the session
   started.
4. Without `clean`: write the continuation brief's final state -- the open PRs
   and their state, the parked Decision items, the potential follow-ups with
   your opinion on each, each run still under way and where its result will
   be, and the next session's first step. The owner starts the next session
   with `/orchestrate`, which reads the newest brief itself, so print that
   command and name no brief.
5. With `clean`: run `/follow-ups` now, the owner's `clean` being its trigger,
   so every thread from step 2 other than the parked Decision items is
   filed, updated or declined on the board.
   Parked Decision items stay on the board for the next session's docket. For
   each run still under way, print one sentence the owner can give a new
   session to watch it and act on its result.
6. Report the final action items: only what the owner alone can take, each
   with the one line the ruleset requires on why the session cannot. With none,
   say so in one line.

The docket runs within a close-out only when the owner triggers it with
`/docket`; the filing pass, only with `clean` or `/follow-ups`.
