---
title: "The built-in linkage rules: what they cover and their provenance"
---

# The built-in linkage rules: what they cover and their provenance

_Status: decided and built. The built-in fields and keys are defined in
`packages/core/src/defaults/builtInLinkageTerms.ts` as
`DEFAULT_LINKAGE_RULE_SET`, and the operator-facing description -- which paths
use them and what they cover -- is in
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#the-built-in-rules). The two
halves were once named and versioned, and terms drawn from them cited those
names; the owner ruled the citation removed, and the names and versions went
with it, so the terms hold the fields and keys themselves and nothing else
identifies the rules. This note records what the two halves are, what the
keys' validation rests on, and the criticisms on record against them. See
[docs/notes/README.md](README.md)._

The first built-in keys are retired. The built-in keys are the catalog of
[linkage-rule-catalog.md](linkage-rule-catalog.md), over eleven fields that add
`phone_number`, `email_address`, `zip_code`, `state`, `county` and
`street_number` to the first set's five. The catalog's revisions added the ZIP3,
state and county rules with the `state` and `county` fields, then the street
number rule with the `street_number` field; dropped the condition that offered
the three name and date rules only to files from one state or one metropolitan
area, offering them for any pair of files, marked less certain; required a
first name of at least two letters in every rule on the full first name; and
added the five contact rules with no date of birth, each matching only where
one of the two records has no valid date of birth.

This is design rationale. Nothing here binds an implementation.

## What the two halves cover

The built-in rules have two halves.

The **linkage fields** are the eleven PII elements the built-in rules work
from, each in its standardized form and with the constraints it has. The
elements are `ssn`, `ssn4`, `first_name`, `last_name`, `date_of_birth`,
`phone_number`, `email_address`, `zip_code`, `state`, `county` and
`street_number`. They are a substrate: they fix what can be matched on and how
each element is cleaned and bounded, and say nothing about what constitutes a
match.

The **linkage keys** are the forty-one combinations built from those fields,
applied in the order listed. They are the specific artifact -- which
combinations count as a match, and in what cascade order. That order is the
catalog's precision order, the 99% band before the 95% band; the keys and their
bands are in [linkage-rule-catalog.md](linkage-rule-catalog.md#order).

Every built-in key is built from the built-in fields. The reverse does not
hold: the same substrate supports keys settled for other uses.

Everything else in a default terms document is a per-party choice made at the
time of the exchange and is outside the built-in rules: the party `identity`,
the `date`, the `algorithm`, the linkage strategy, the output preferences, and
`deduplicate`. Two parties can run these rules and still disagree about who
receives output; they cannot run one set of keys and disagree about what a key
is.

Terms derived from an input file leave out any key that input cannot supply, so
an exchange matches on a **subset** of the built-in keys, never on an addition
to them. The terms document that travels with the exchange records exactly
which keys ran. Where those keys are exactly one built-in choice's, in their
order, over the built-in fields, the accepting party's terms review says so,
worked out from the keys and fields themselves.

## What zero-setup rests on

A zero-setup exchange authors nothing. Each party derives its terms from its own
input file, keeping the built-in keys that file can satisfy, and the two derived
documents are then cross-checked against each other. That works with no
authoring because every built-in key is built from the built-in fields, so a
party derives each key from the same field declarations as its partner.

A built-in key over a field outside that substrate would strand the party whose
file does not include it, as terms referencing a field they never declare,
which names no cause to an operator who authored nothing. A key over a field
inside it that only one party's file supplies -- a phone, email, street number,
ZIP, state or county column, which the built-in fields declare -- stops the
exchange at the terms check instead, before any data moves, and the party whose
file has the column is told which column to remove ([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#the-built-in-rules)).

So the property is held by a check rather than by review:
`npm run check:zero-setup-keys` reads the built-in set and fails a key whose
elements leave the built-in fields, or name a field a derived input cannot
supply by semantic type. Widening the fields stays possible and stays an
explicit decision. What the check covers, and what it cannot see, are in
[repo-check-scripts.md](repo-check-scripts.md#zero-setup-key-fields).

## Why the fields and the keys are described apart

The validation on record, and both criticisms on record, are about which
combinations of PII count as a match -- a judgment made for a particular class
of system. The fields are the generic part: the same elements, cleaned the same
way, underlie keys settled for entirely different uses. Describing them
together would extend the keys' provenance to a substrate that does not have
it.

## What the keys' validation rests on

The keys are not derived from a published linkage standard. Their basis is
**operational**: the first built-in keys were developed and validated with
partner agencies of the class the product primarily serves, running against
their own administrative records, and the key combinations they shipped with --
and the order they were applied in -- are the ones that engagement settled on.
That operational validation, and the grounding the catalog gives each later
rule, is what a user of the built-in rules is relying on, and the whole of the
claim this repository records: no certification, no accreditation, and no
benchmark against a public gold-standard linked file.

Two limits on this note, stated rather than left to be inferred:

- **The engagement's identifying detail is kept out of this repository by
  design.** This repository is public; who the partners were, and what their
  data covered, is not the product's to publish. Attribution belongs in
  user-facing communications and in an agreement, where it can be made with the
  partner's consent and withdrawn.
- **The underlying measurements are not published here.** No precision or recall
  figure, and no comparison against a named external standard, is on record in
  this repository. A written comparison of these keys against the standards used
  elsewhere for linkage of this class, and a stated evidence bar that any future
  built-in keys would have to meet, are both still to be produced.

So what this note supports is the shape of the two halves, the fact that the
keys' provenance is operational validation rather than derivation from a
standard, and the criticisms below. It does not support a claim about measured
accuracy.

The fields have no validation lineage of their own. They are the generic
substrate -- standardized PII elements with constraints -- and a substrate is
not a claim about matching accuracy: what was validated is which combinations
of it count as a match.

## Criticisms on record

Two criticisms are on record against the keys, and they point in opposite
directions. Both are recorded here because a reader deciding whether to run the
built-in rules should meet them at the same time as the validation claim, not
after adopting the keys.

**They are more permissive than the standards used elsewhere.** The
permissiveness is visible in the keys themselves. Two of them use no SSN
evidence at all -- `LN + FN + DOB`, and the same key with the two names swapped
to catch a reversed-name data entry error. Several match on a truncated name (a
three- or four-character last name, a first initial) rather than a full one, and
several substitute year-and-month of birth for a full date. Each of those is a
recall trade: it exists to match a record a stricter rule leaves unmatched, at
the cost of a wider door for a false match. A standard set for a lower tolerance
of false matches would be expected to challenge exactly those keys.
[linkage-rule-catalog.md](linkage-rule-catalog.md) bands each key: the two keys
with no SSN evidence fall in its 95% band and are marked less certain, since
chance agreement on a name and a date grows with the number of people the files
cover. `SSN4 + LN4 + YOB + MOB`
also falls in its 95% band, offered for any pair of files; the truncated keys
beside a full SSN fall in its 99% band.

**Recognized matchable fields go unused.** `phone_number`, `email_address`, and
`zip_code` are semantic types the product recognizes, infers from column names,
and can match on -- and no key of the first built-in keys references any of
them. A party whose data includes a phone number gets no matching value from it
under those keys; it has to add a key itself. The gap is not an oversight to be
closed by adding keys casually: rules for those fields would have their own
precision/recall consequences and are not covered by the validation these keys
rest on, so they need their own grounding before they could ship as built-in.

The catalog closes the gap with that grounding. The built-in keys match on each
of those types, each rule with the band
[linkage-rule-catalog.md](linkage-rule-catalog.md) gives it, and the built-in
fields declare the three. Where a refinement sits in the order is in
[linkage-rule-grounding.md](linkage-rule-grounding.md#placements-the-evidence-forces).

Each such rule is compound -- the type beside a name and a birth date, or its
year and month, or a phone or email beside a name where one of the two
records has no valid date of birth -- and never the type alone, on two
grounds that agree. A key
over a single identifier is a membership oracle: a party holding a candidate
value learns from the result whether its holder is in the other party's file,
which is the differencing exposure [SECURITY_DESIGN.md](../SECURITY_DESIGN.md)
scopes the guarantee against. And a contact value is a shared value in
program-application data -- one phone number or email address is shared across a
household, and across the people an organization files for -- so a key over one
alone reports different people as the same person. The web app's guided key
list states that caveat beside the keys it shows over a phone, email, street
number, ZIP, state or county field, adding that a location column must hold
each person's own, never a site's.

The email shape `FN + EMAIL` has no band, since no source measures it, and is
not a built-in key. An operator reaches it, or any other combination nothing
here has grounded, only by authoring it in the expert key editor. Terms with an
added key are no built-in choice's, so the accepting party's terms review names
no built-in choice for them -- the departure reaches that review, not only the
operator's screen.

A key over one of these types gets the type's recommended cleaning whichever
door authors it -- the guided list's checkbox, an imported document, or the
expert key editor. The cleaning is per-party and is never sent, so the accepting
party derives its own from the terms it accepted: a party matching one of these
columns raw would hash `20001-1234` against a partner hashing `20001` and match
nothing, with neither side told. The editor seeds the recommended pipeline
instead, and an operator who wants other steps edits them in the data-prep
workbench, where the change is theirs and visible.

In short, the first built-in keys were looser than some standards where they
matched, and narrower than the product's own capability in what they could
match on.

## Changing the built-in rules

Two parties' terms agree or not on the terms documents themselves, field by
field and key by key, so two builds shipping different built-in rules do not
reconcile them: a quick exchange between them stops at the terms check. A
change that emits the same fields and the same keys in the same order -- the
file reorganized, a comment rewritten, two properties written in the other
order -- alters no rule. A key's own name is not in that class: it travels in
the terms document, which the two parties compare whole, so two builds spelling
a key differently cancel the exchange between them.
