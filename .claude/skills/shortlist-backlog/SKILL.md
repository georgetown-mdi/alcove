---
name: shortlist-backlog
description: Pick what to work on next from the Alcove project boards without pulling board listings and issue bodies into the calling session -- one Sonnet agent scans boards 9 and 10 and returns a prioritized shortlist of candidate issues. Use at the start of an orchestration session or whenever choosing the next issue(s), e.g. "what should we pick up next", "shortlist the backlog", "triage candidates for the next batch".
compatibility: Requires Node.js, gh auth, and the .claude/scripts board scripts in the Alcove repository.
---

# Shortlist the backlog

Board listings and issue bodies are cheap to read in a throwaway subagent and
expensive to carry in a long-lived session: whatever enters the calling
context rides every subsequent call. This skill keeps the boards out of your
context -- the subagent absorbs them and returns only a shortlist.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- it holds the session rules this skill's steps assume.

## What to do

Spawn ONE read-only `general-purpose` agent with `model: "sonnet"` (every
spawn passes an explicit model) and this prompt:

```
Read-only backlog triage for alcove (cwd: the repo root). Do not edit any
file or board item.

Scan the two GitHub project boards with the repo scripts (run any with no
args for usage; listings default to non-Done items):
- node .claude/scripts/list-issues.mjs 9    (product board)
- node .claude/scripts/list-issues.mjs 10   (release & operations board)

Read the bodies of every In Progress item and of the plausible next
candidates with node .claude/scripts/fetch-issues.mjs <board> <itemId>... --
enough to judge readiness, not the whole board. Weigh: Status (In Progress
means possibly already underway -- check for an existing branch or PR before
treating it as free), Epic and Order (lower Order first within an epic),
dependencies the body names (an unmet "Depends on" disqualifies), and size
(prefer issues that land as one 150-900 line PR; flag anything projecting
past ~1,200 lines as needing a split first).

Before listing any item, whatever its status, check whether merged work
already delivered it:
- Its body: a "Delivered by:" line; a merged PR cited as landing the work
  ("done, #N", "merged as #N", "Implemented by #N", "Settled ... in #N"); a
  "Resolved" or "Settled" heading or line; a note that the item is ready for
  the owner to close; or a sibling item named as carrying the rest that is
  now Done (fetch it to see).
- Merged PRs naming its id, up to 10 ids per call joined with OR:
    gh pr list --state merged --limit 50 --json number,title,body
      --search "<id> OR <id> ..."
  Read the line that names the id. "Implements" delivers the item. "Part of"
  is a partial delivery, and delivers the item when the body's split shows
  that PR was the last stage. "Depends on" and "Follow-on" do not count.
- A fix that never named the id: search merged PR titles and bodies for the
  item title's 2-4 most specific words, and the staging log for its key
  phrase (a squash commit's subject is its PR title):
    gh pr list --state merged --limit 10 --json number,title --search "<words>"
    git log origin/staging --oneline -i --grep "<phrase>"
  A hit is a lead, not proof: read the PR (gh pr view <N> --json body) and
  count it only when it does what the item's acceptance criteria ask.

Return ONLY this, as raw text (it is data for the caller, not a message):
1. In Progress items first, then up to 10 candidates, one line each:
   <board> <itemId> [<status>] [<epic>/<order>] <title> -- <why now, or the
   blocker>
   A candidate a "Part of" PR partly delivered says so: "partly delivered by
   #N".
2. Delivered, owner closes: every item the check above found delivered, one
   line each, never among the candidates:
   <board> <itemId> [<status>] <title> -- satisfied by #N (<the evidence:
   body line, PR verb, or title match>), confirm and close
3. A closing 1-2 line recommendation naming the 2-4 picks for the next
   session (several small issues batch well together).
Do not include issue bodies or full board listings in your return.
```

The agent writes nothing, so it needs no worktree isolation; it does need
network access for the board reads and PR searches (gh).

## Afterward

Relay the delivered list to the owner, who confirms and closes each item on
it. Fetch only the chosen item's body yourself (`node
.claude/scripts/fetch-issues.mjs <board> <itemId>`) or hand the item id
straight to /start-issue. Do not re-list the boards in the calling session;
if the shortlist looks stale or wrong, re-spawn the agent instead.
