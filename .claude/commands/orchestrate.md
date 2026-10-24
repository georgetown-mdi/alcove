---
name: orchestrate
description: Start or resume an orchestration session -- load the session rules and the newest continuation brief, then work the backlog on boards 9 and 10 until the owner names another state.
---

    /orchestrate [the day's notes]

The owner's standing instruction for an orchestration session, less what the ruleset and the other commands already state.
The same command resumes the session after a compaction and starts the next one after a `/clear`:
the resume message is this command, never a continuation brief's path handed to the owner.

## The day's notes

$ARGUMENTS

The text above is the owner's note for the session -- a parked pull request, the session model, anything unusual; an empty line means none.
Add it to the continuation brief's owner notes, never replacing what is there, so a resume that omits it keeps it.
## First

1. Read `.claude/orchestration/ruleset.md`.
2. When a continuation brief exists, read the newest:
   the line `ls -t scratch | grep -m1 '^continuation-.*\.md$'` prints in the primary checkout, newest by modification time.
   A brief whose first line begins `Closed out`, as the follow-ups pass leaves it, is history: start from the board, and keep this session's brief in a new file.
   Any other brief is this session's own, resumed after a compaction or a rotation: keep writing it.
   A new brief is `scratch/continuation-<date -I>.md`, with the next letter added (`b`, `c`) when that name is taken.
3. If you have questions before you start, ask them now and wait for the answers.

## The work

- Orchestrate the backlog on boards 9 and 10: items in Backlog or Todo, never the Decision column.
  That column is the owner's ruling queue, and its items are never yours to implement or settle.
- Pick items that deliver value to users and the product and that can be developed at once without interfering with each other.
  Do not avoid hard work, above all work that unblocks other streams.
- Work autonomously, using your discretion.
  Delegate the writing and the reading (`.claude/commands/start-issue.md`, Orchestrating), and keep your own context for planning, decisions and analysis.
- The owner delegates the task and review budgets to you: raise one when the raise delivers value to users or the product, recorded as `.claude/commands/assess-review.md`, Step 2, sets out.
- For anything that needs resources outside the container -- Docker, the open internet -- stop and ask:
  the owner runs it or hands it to a host session (`CLAUDE.md`, Spawns and reports).
- The rest -- working on as pull requests merge and across compactions, parking decisions, and the docket and follow-ups only on the owner's trigger -- is `.claude/orchestration/ruleset.md`, Session lifecycle.
