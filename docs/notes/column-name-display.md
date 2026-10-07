---
title: "Showing the Operator's Own Column Names"
---

# Showing the operator's own column names: isolated, not escaped

_Status: decided and built.
The display treatment is `apps/web/src/components/ColumnName.tsx`; the partner-text escape it contrasts with is specified in [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) (Display sanitization escape format).
See [docs/notes/README.md](README.md)._

The acceptor's confirm-columns screen and the consent screen show column names from two sources.
This note records why the operator's own names are isolated rather than escaped, and what that leaves open.

## Two provenances, two treatments

Every column-name sink on the confirm-columns screen goes through `ColumnName.tsx`:
the grid's row header and its two control labels,
the quick-fix mapper's options,
the disclosed-columns panel,
the alert naming the operator's own columns in the payload-declaration conflict notice,
the grid's live regions,
and the ledger's "You will send" row.
So does the consent screen's chip list of what this party will send,
so one name displays the same wherever either screen puts it.

A name the invitation declares is partner text, and it is escaped where the invitation summary is built.
The two provenances meet in the conflict notice, and on the consent screen, where the declared names sit in the same panel as this party's own send.
The split has a cost both screens accept:
a declared name the operator's file also contains reaches them escaped in the notice and verbatim in the grid row the notice sends them to.
The two forms are the same string only for a name of printable ASCII with no backslash.
Escaping the half the operator cannot inspect costs reading one name in two forms.

## Why isolation, not the escape

These names are the operator's own CSV header, read from the file they chose,
not the partner-controlled text `sanitizeForDisplay` exists for.
What they need is layout containment.
A header with a right-to-left override, or an embedding it never closes, otherwise reorders the sentence, label, or table row it is interpolated into,
and these are the screens where the operator decides what leaves their machine.

Isolation costs almost nothing else.
An accented or non-Latin header renders as itself rather than as escapes,
and two headers sharing a long prefix stay distinct up to `MAX_NAME_LENGTH`, the ceiling past which no name completes an exchange.

## What isolation does not tell apart

A homoglyph (Cyrillic U+0430 for Latin "a"), a zero-width character, or a tab or newline (HTML folds either into the space beside it)
makes two headers differing only by that display alike; escaping is what would tell them apart.
Two headers longer than `MAX_NAME_LENGTH` code points that share their first `MAX_NAME_LENGTH` render as the same cut string in every sink on either screen.

The names are the operator's own, so the cost is the clarity of their own header, not a misdirected disclosure:
a name long enough to be cut is past the ceiling on the UTF-16 count too,
so marking either twin to send closes the launch gate (`acceptorOverlongDisclosedColumns`, over the predicate core's prepare-time `assertDisclosedNamesCarriable` reads)
rather than sending the column the operator did not mean.
The module decides only how a name displays, never what is sent.

## The display cut

Nothing bounds a CSV header at intake and isolation escapes nothing,
so without a cut an arbitrarily long header paints whole over the screen that holds the launch gate.
The cut's ceiling matches the wire's:
the partner's parse of the payload frame refuses a longer name, as does `ColumnMetadata.name` wherever metadata is parsed rather than inferred.
This screen's metadata comes from `inferMetadata` over the file's own unbounded header, so an oversized name still renders cut, but cannot leave the machine.

The cut counts code points, so it never splits a surrogate pair, and an override it leaves open is closed by the isolate around it.
The wire's ceilings count UTF-16 units.
The two disagree in one direction only:
a name long enough to cut is always past the wire ceiling too, so the mark never elides a name that transmits.
The reverse is silent: a header of `MAX_NAME_LENGTH` astral characters is twice that many units,
renders whole and unmarked, and is still refused on the wire.

## The isolate's residual

FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE (Unicode UAX #9) lay the text between them out on its own resolved direction,
and the whole isolate counts as one neutral character to the text around it.
PDI also ends any embedding or override (RLE, LRE, RLO, LRO, a missing PDF) the isolated text left open.

The isolate class itself is the residual, and both forms, the string wrapper and the `<bdi>` element, share it:
a name whose unmatched PDI closes the wrapper early leaves an override running over the copy that follows.
What keeps it off a sink is the layout, not the wrapper:
a name given a block of its own has no copy beside it for the override to run over,
while a sink that puts literal copy in one text block with a wrapped name can have that copy reordered.
`apps/web/test/browser/inviterSharing.test.ts` and `apps/web/test/browser/accept.test.ts` measure which sinks are of which shape;
a sink no check drives is not asserted to contain the residual.

One hole no check covers, stated as UAX #9 states it rather than as a measurement:
a name with an unmatched RLI, LRI, or FSI consumes the closing PDI, so the wrapper opens and never closes.
The trust basis for both is the same: these are the operator's own CSV headers.

## Why the wrap is unconditional

Whether a given name can reorder its surroundings is a question about Unicode bidi classes.
An unconditional wrap is a property a reader can check by looking at the call site.
The `<bdi>` form is preferred wherever a sink accepts markup,
since it keeps the isolation in the markup rather than in the text the operator selects and copies.
