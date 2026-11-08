---
title: "File-sync rendezvous and poll structure"
---

# File-sync rendezvous and poll structure

_Status: built; agent-written, a proposal until the maintainer ratifies it.
The protocol these methods implement is specified in
[FILE_SYNC.md](../spec/FILE_SYNC.md), which is normative;
this note records why the code that reads partner-written files is cut the way it is._

## One read of a peer hello

The rendezvous reads a peer hello at five places:
the lock joiner, the lockless barrier, and the lock loop's lock-detection, responder and two-hellos branches.
Each read must apply the same checks before the hello leads to any write
([site 5](../spec/FILE_SYNC.md#the-five-enforcement-sites)):
the read gate ([I5a](../spec/FILE_SYNC.md#invariants)),
the version selection and the mode-flag comparison
([Bilateral configuration](../spec/FILE_SYNC.md#bilateral-configuration-detect-and-fail)),
and the two id-pair refusals.

`readPeerHello` does the read and returns the refusal, rather than returning the envelope for each site to check.
No site uses the envelope for anything but those checks,
so a site that reads a hello cannot skip one, and a check added later reaches all five.
What stays at each site is what differs between them:
when the read happens relative to the role commit,
and the cleanup before the refusal is thrown
(the joiner's advertised hello, the lock-detection branch's delete of the peer lock).

The id the id-pair refusals check is the one parsed from the hello's own name.
At the two-hellos branch that is the id already committed a few lines earlier,
so the check is the same as it was when the site read the committed id back.

## One identity reset

The lock joiner's refusal path and the hello exchange's rollback return the connection to its pre-synchronize identity the same way,
so `resetIdentity` is the single statement of what that reset clears.
A site that resets identity calls it, and a field added to the reset reaches both.

## The two waits

The lockless barrier and the lock loop are separate methods because they share no branch.
What they share is held in one object, `HelloExchangeState`, rather than in closure variables:
the scope, the entry-present hello and its ack deadline, and the three values the code after the wait reads --
the lock path and ack path the rollback deletes, and the own-pattern hello the peer timeout names.
State only one loop uses, such as the acked hello name or the joiner-sentinel timer, stays local to that loop,
so it cannot leak from one rendezvous mode into the other.
The lock loop's three completing branches are methods of their own, called in the order the loop selected them,
so the loop reads as the selection and each branch as its own sequence of steps.

## The poll split

`poll()` hands one listing to `classifyListing` and the one selected message to `consumeMessage`.
The statements move unchanged, in their order.
The one value that crosses the boundary is whether the cycle is inside the message read,
which the catch in `poll()` reads to tell a list-then-get race from any other failure.
It is a per-cycle object passed in, not a field on the loop,
so a value set in one cycle cannot be read by a later one.

## Comments that restate the spec

A comment in these files that restated a rule [FILE_SYNC.md](../spec/FILE_SYNC.md) states
is cut to the constraint the code next to it must keep, with a pointer to the section that states the rule.
Known limits, orderings a reader could break by reordering, notes on a site's twin, and the arrival diagrams stay in the code,
because a reader editing that code needs them where the edit happens.
