---
name: compact-prep
description: Prepare for the owner's /compact -- bring the continuation brief current and print the compact argument and the resume prompt, without stopping work in flight or starting new work for it.
---

The owner's instruction this command stands for:

> We might want to compact soon - whenever it is convenient to do so. When
> you think it would be a good time, print a message that can be used as an
> argument to the compact command and one that can be used as a prompt to
> continue work after the command completes. Keep just what is necessary.

The bare command is that whole instruction. A note after the command -- a PR
the owner will merge, a handoff he will run before resuming -- goes into the
resume prompt.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- its Session lifecycle section defines this state.

## Steps

1. Change nothing about the work: agents in flight keep running, nothing
   stops, and no branch, fix round or spawn starts as part of the preparation.
2. At the next point where no step of your own is half done, bring the
   continuation brief current.
3. Print two messages, each a few lines that keep only what the next context
   needs:
   - The argument for `/compact`: the brief's path, the task ids of agents
     still running, and any decision presentation that is open.
   - The prompt to resume after it: read `.claude/orchestration/ruleset.md`
     and the brief, then continue working, with what the owner said he will
     do in between and where its result will be.
4. Keep working until the owner compacts; afterwards the session is in the
   Working state again.
