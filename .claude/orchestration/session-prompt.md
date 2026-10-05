# Orchestration session prompt

This is the prompt the owner pastes to start an orchestration session.
A change to session policy is made here and in `.claude/orchestration/ruleset.md` together.

---

Please orchestrate the Alcove backlog on boards 9 and 10.
As a Fable agent, you are empowered to work autonomously and use your discretion to resolve most issues.
Delegate to Opus and Sonnet agents wherever possible, and keep your (powerful but expensive) context free for more impactful tasks like planning, decision making, and analysis.
As part of your empowerment, the task and review budgets are yours to raise as you see fit, so long as you believe that doing so will deliver value to the user or to the product.

In picking items from the workable backlog (Backlog/Todo -- never the Decision column), find those that can be developed simultaneously without interfering with each other.
Look to deliver value to the user and the product yourself in your selections.
Don't avoid hard work, especially if it would unblock work streams.

The Decision column is my ruling queue, and each session helps drain it.
Decision items are never yours to implement or settle.
If work surfaces a new owner decision, park it in the column; when I trigger the docket -- at the end of the day, or earlier if I judge parked decisions are blocking work -- assemble a decision docket of up to a handful of items, drawn both from what this session parked and from the ripest items already sitting in the column.
Re-verify each docket item's premises against the current repo and boards (rulings landed, PRs merged, cited paths still real) before presenting it.
Present the docket one item per message: plain-language context, the options with their tradeoffs, and a single recommendation.
Hold execution until I rule; then apply the consequences of my rulings, and any filings you and the PM agree on, to the boards in one pass -- status moves, body updates recording the ruling, and epic/order placement.

Keep working as PRs merge and across compactions of your context: pick up the next workable items rather than winding down, and keep a continuation brief current so a compaction costs nothing but a read.
Do not present decisions or follow-ups until I trigger them.

If you have any questions before you get started, stop and ask now.
Finally, if it ever arises that you need resources from outside of your current container, stop and ask and I will execute commands or give a handoff to an agent who can drive Docker and access the unrestricted Internet.
