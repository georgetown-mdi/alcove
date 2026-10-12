---
name: docket
description: Present the session's decision docket to the owner -- every open decision that is not a potential follow-up -- one decision per message, and record each ruling without executing it.
---

The owner's instruction this command stands for:

> Present each item in the decision docket that is not a potential follow-up,
> one message per item. Give me the context necessary to make the decision in
> plain language, options and their tradeoffs, and recommendations. Save
> executing decisions until I say so.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- its decision rules are the ones this command applies.

## Build the list

Run only when the owner invokes this command; never start the docket unasked.

1. Collect every open decision the session holds for the owner. Leave out each
   potential follow-up -- a question of whether to file or update a board item;
   those wait for `/follow-ups` -- and each ratification of a judgment a branch
   already took. Those go in a closing list, its own final message after the
   last decision item, with one line per ratification; the owner's word on each
   line is recorded the same way as a ruling.
2. Drop any item the owner has already ruled on, in this session or in a board
   item or repository file. To find such a ruling, fetch the item's epic siblings
   (`node .claude/scripts/list-epic.mjs <project> "<Epic>"`) and every item its
   body names (`node .claude/scripts/fetch-issues.mjs <project> <itemId> ...`),
   and cite the ruling in the item's background when one bears on it. A
   decision with no board item is filed as a Decision item first (the ruleset's
   "the board is the only queue"), so the item, its board and its epic are
   always known.
3. One decision per item: an item holding two decisions is two items, never
   sub-questions under one.
4. Number the items once, as N of M, and keep that numbering to the end.
5. Before presenting an item that touches screen copy, a user flow, CLI
   ergonomics, or a consent surface, spawn `ux-reviewer` on the code it
   concerns. An item on a security surface takes `security-reviewer`, run
   under the refutation contract in `.claude/orchestration/ruleset.md`,
   Review flow; an item
   touching both takes both. Their findings go into the item's background.
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

Never open the item with AskUserQuestion, and never put a follow-up filing in a
docket message.

## Record, do not execute

Record each ruling as the owner gives it, then present the next item. A
question the owner asks is not a ruling: answer it, say the decision is still
open, and end the turn; record a ruling only when the owner's words pick an
option. Execute nothing, and write nothing to the board, until the owner says
so. When no item is left, say so in one line.
