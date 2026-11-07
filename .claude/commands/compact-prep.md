---
name: compact-prep
description: Prepare for a /compact the owner runs by hand -- bring the continuation brief current and print the compact argument and the resume message, without stopping work in flight or starting new work for it.
---

The owner's instruction this command stands for:

> We might want to compact soon - whenever it is convenient to do so. When
> you think it would be a good time, print a message that can be used as an
> argument to the compact command and one that can be used as a prompt to
> continue work after the command completes. Keep just what is necessary.

The bare command is that whole instruction. A note after the command -- a PR
the owner will merge, a handoff he will run before resuming -- goes into the
resume message. It runs only when the owner asks: the session's context
compacts automatically at the size `.claude/orchestration/ruleset.md`,
Session lifecycle, states, and the session does not prepare for that.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- its Session lifecycle section defines this state.

## Steps

1. Change nothing about the work: agents in flight keep running, nothing
   stops, and no branch, fix round or spawn starts as part of the preparation.
2. At the next point where no step of your own is half done, bring the
   continuation brief current. Record in it the state the session was in
   before this preparation -- Working, Wind-down, or another state the
   ruleset's Session lifecycle names, never Compact-prep itself -- and the
   latest shortlist's candidates the session has not taken.
3. Print two messages, each a few lines:
   - The argument for `/compact`: what the summary is to keep that no file
     holds once step 2 is done, written as an instruction (`keep ...`), never
     as a description of the session's state. That is typically an open
     question to the owner or a decision presentation in progress, kept
     verbatim. It names neither the brief nor the running agents:
     `instruct-compaction-summary.mjs` gives the summary its standing
     instructions, `remind-after-compaction.mjs` names the ruleset and the
     brief afterwards, and the harness lists the agents still running. With
     nothing left to keep, print the bare `/compact`.
   - The resume message: `/orchestrate`, followed by what the owner said he
     will do in between and where its result will be. It names no brief and
     no state: `/orchestrate` reads the newest brief and enters the state it
     records.
4. Carry on in the recorded state until the owner compacts.
