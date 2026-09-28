---
title: "The Payload Column Set as Agreed Terms"
---

# The payload column set as agreed terms: one record, compared at the handshake

_Status: decided on the maintainer's ruling, after a 3-panelist design panel and a survey of what the terms exchange already compares; the first-run fill of an unset `payload.receive` is built, the rest is not. The records the ruling removes are specified as they stand in [EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#payload-disclosure-consent), the terms comparison in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termspayload) and [CANONICAL_ENCODING.md](../spec/CANONICAL_ENCODING.md#scope), and the terms-exchange envelope in [PROTOCOL.md](../spec/PROTOCOL.md#linkage-strategies-cascade-and-single-pass); the spec rows change as each part lands. This note records why the shape is the one it is. See [docs/notes/README.md](README.md)._

A recurring exchange runs the same agreement many times, and either party's input file can change between runs: a column added to an extract, a column dropped from it, a column renamed. The question was how the exchange holds the set of payload columns each party sends and receives when that happens, so that neither party discloses a column the partner never agreed to receive, and neither party runs on for less than it agreed to receive.

## The records the ruling removes

Three records the tool writes into a party's configuration, beside the agreed terms rather than inside them ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#payload-disclosure-consent)):

- a send-side commitment and an accepting party's outbound consent, both checked before connecting;
- a receive-side expected set, checked only after the partner's payload has crossed ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#receive-side-runtime-enforcement-reconcilereceivedpayload)).

That arrangement left three gaps, all on the paths a recurring exchange takes:

- **The receive check runs too late.** A partner that dropped a column is caught only after this party has disclosed its own payload, and the result is then thrown away: disclosure for no benefit.
- **An empty received set never counts.** The partner sends nothing both when it discloses nothing and when no row matched, so a partner that drops every column passes, and an observed empty set is never recorded.
- **An unnamed column is sent.** Metadata inferred from the input header marks a column Alcove does not recognize as payload, so a column added to the extract crosses without any record naming it.

The records also cost the operator: an accepting party with no input file at accept time holds a pending consent that refuses every unattended run, and the console and the web import each carry a display of their own for the records.

## The decision

The agreement is the only record of the payload.

- **What a party sends** is what its input metadata declares as payload. A column the metadata does not name is not sent, and the run lists the undeclared columns.
- **What a party receives** is `linkage_terms.payload.receive`. A recurring exchange that leaves it unset takes the partner's declared send set on its first run, at the terms exchange and before any key or data moves, and records it in the configuration it runs from; every later run compares it strictly ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#an-unset-payloadreceive-is-filled-on-the-first-run)). A one-off exchange leaves it unset and takes what the partner sends. A party that declares `output.expects_output: false` has already stated that it receives nothing and lists no `payload.receive`; for a party that expects output, an explicit empty `receive: []` is how it states that it receives nothing (the cross-check itself: [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termspayload)).
- **No tool-written payload records.** The send-side commitment, the outbound consent and its pending state, the receive-side expected set, and the check that runs after the payload has crossed are removed, along with the console's confirmation card for the consent and the web import's lines for those records. The accept screen keeps showing the data dictionary.
- **A change on either side is a terms mismatch at the handshake**, refused before any key or data moves. A declared column missing from the input is refused locally, before connecting.

## Why the terms were already enough

The survey of the terms exchange settled most of the question:

- Each party sends its full linkage terms on the terms exchange, and agreement is decided by comparing the two documents, in the same canonical form the agreed-terms hash covers, before any linkage key moves ([CANONICAL_ENCODING.md](../spec/CANONICAL_ENCODING.md#scope)). A declared `payload.receive` that differs from the partner's `payload.send` already aborts there ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termspayload)).
- The gap was the lazy case. An invitation with no `payload.receive` gives the accepting party no mirrored `send`, so its outbound set never entered the agreed terms, and the three records stood in for it outside them.
- Two rules close that case with no change to the wire. A party whose terms leave `payload.send` unset states, in the terms it sends at every run, the columns its metadata declares. And a recurring exchange whose `payload.receive` is unset fills it from that stated set on its first run. Both directions are then inside the agreed terms and compared at the handshake from the second run on.

What both parties agree to, and what the agreed-terms hash covers, is the resolved terms: each unset `send` stated from its party's metadata, and each unset `receive` resolved to the partner's stated `send` ([EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#the-agreed-terms-hash)). The fill takes place at the terms exchange, before any key or data moves, so the resolved list is already the one the run holds the partner to; hashing the unresolved form would make the record of a first run disagree with the configuration the fill wrote, and a verifier would report a mismatch for a run that did exactly what was agreed. Both parties derive the resolved pair from the same two wire documents, so no new field crosses the wire and the record format is unchanged.

Once both directions are agreed terms, each record is a second copy of something the terms hold, kept by a different mechanism at a different moment. The post-payload check becomes a later, weaker repeat of a comparison already made, and the empty-set ambiguity stops mattering, because what is compared is the declared set rather than bytes observed after matching.

## Changing the terms in band

Strict comparison in both directions means one party's deliberate change stops the other's schedule. The ruling answers that with a route through the run itself rather than around it:

- **The party that changed its terms just runs.** Its new terms reach the partner on the terms exchange.
- **An attended partner** (a terminal on standard input, no `--consent-to-terms`) sees the change -- columns added and removed, and any other term changed -- confirms it, has the terms written into its configuration, and the run continues.
- **An unattended partner** refuses before any data moves, writes the proposed terms beside its configuration, and the failure names the one command that applies them. The console and the web app show the same change with a control that applies it, after which the operator runs again.
- `alcove update` and `alcove apply` ([EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#terms-update)) stay as the route for agreeing a change before either party runs.

## Alternatives weighed

Three designs were weighed. All three kept tool-written records of the set in each direction; they differed in how strictly a change was held and where it was caught.

**Recorded sets held strict both ways.** Each party records the set it sends and the set it expects, each either confirmed, pending, or pinned from what arrives on the first run, with the basis of each recorded for an auditor. Any added or dropped column refuses the run. Its strictness survived into the ruling: an added column is a terms change either way. Its records did not:

- Every state it adds -- pending, pinned, the basis beside each -- is a state of a copy the agreed terms already hold, and each needs its own screen on every surface.
- A set pinned on an unattended first run is consent nobody gave. If that run already lacked an agreed column, every later run enforces the mistake, and the only trace is the word "pinned". The ruling does fill an unset `payload.receive` from the first run, and answers this with what the fill takes and records rather than with a basis record: it takes the partner's declared send set at the terms exchange, not the columns that happened to arrive, before anything is disclosed; it logs the columns taken; and it is not a consent surface, since it sets only what this party receives, while what the partner sends stays governed by the partner's own metadata. A party that knows the set writes it before the first run, and nothing is filled.
- Its own stated risk, a stalled schedule after an already-discussed change, is what the in-band terms change answers.

**A send-side allowlist.** The recorded send set acts as an allowlist: an added column is left out and the run goes ahead with a notice, while a missing agreed column refuses the run. Its first half survives in the ruling, keyed to the metadata rather than to a separate record: an undeclared column is not sent and the run lists it. What was not taken is treating a column the operator did declare, but the partner did not agree to, as something to drop quietly. That is a terms change, and it goes to the partner as one, rather than leaving an intended addition unshared for as many runs as the notice goes unread.

**Widening the terms-exchange envelope.** Each party announces its resolved list of payload column names on the terms-exchange envelope, beside the payload-intent flag that already rides it outside the agreed-terms hash, and sends the list even when no row matched. The receiver compares it against its expected set before any key moves, which moves the receive check ahead of disclosure and removes the empty-set ambiguity. The goal was right and the ruling keeps it. The mechanism was set aside because the survey showed it duplicates the comparison the terms exchange already makes: with `payload.receive` required, the sets are inside the terms both parties send in full, so a second list on the envelope would be a second comparison of the same fact, outside the hash and with its own refusal path to keep consistent.

## What this note does not decide

- The exact exit codes, event categories, and message text for the handshake refusal and the in-band confirmation; those follow the existing refusal rows when each part is specified.
- Whether a one-off exchange ever records `payload.receive`; the ruling leaves it unset and lazy there.

## See also

- [EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#payload-disclosure-consent) - the payload records as they stand, and [what a terms update writes](../spec/EXCHANGE_FILE.md#what-applying-writes)
- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termspayload) - `payload.send` and `payload.receive`, and how they are cross-checked
- [PROTOCOL.md](../spec/PROTOCOL.md#linkage-strategies-cascade-and-single-pass) - the payload-intent flag on the terms-exchange envelope, outside the agreed-terms hash
- [CLI.md](../CLI.md#changing-the-terms-of-an-established-partnership) - `alcove update` and `alcove apply`
- [one-sided-disclosure.md](one-sided-disclosure.md) - the same rule for linkage keys: a run the input cannot satisfy is refused, not narrowed
