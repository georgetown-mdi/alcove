---
title: "Comparing the Two Parties' Linkage Terms"
---

# Comparing the two parties' linkage terms

_Status: decided and built.
The comparison is `compareTerms` and `validateCompatibility` in `packages/core/src/linkageTermsNegotiation.ts`; what each party refuses is specified in [PROTOCOL.md, A terms change at the terms exchange](../spec/PROTOCOL.md#a-terms-change-at-the-terms-exchange).
This note records why the comparison is built the way its code comments state.
See [docs/notes/README.md](README.md)._

At the terms exchange each party compares its own linkage terms against the partner's.
The code keeps one or two lines per constraint at the site it governs.
The reasoning behind those constraints is here.

## Raw values compared, delimited values shown

A mutually-distrusting partner chooses the legal agreement's reference and purpose and the payload column names.
It chooses them on the side the diagnostics call "yours" too, since `deriveAcceptedLinkageTerms` adopts the inviting party's `legalAgreement` verbatim ([DISPLAY_ESCAPE.md, Compatibility diagnostic value delimiting](../spec/DISPLAY_ESCAPE.md#compatibility-diagnostic-value-delimiting)).

Every value a diagnostic names is delimited where the diagnostic is composed.
Escaping is applied once on each route:

- An `errors` entry becomes an `Error` message, which `sanitizeErrorForDisplay` escapes once where it is shown, so the values inside the delimiters are the raw ones.
- A `warnings` entry is returned to the caller as display text with no error to hold it, so it is escaped and redacted where it is composed.
  The CLI escapes each warning again, and the second escape changes nothing a reader can see, because every value a warning names has a shape the escape does not rewrite ([DISPLAY_ESCAPE.md, Display sanitization escape format](../spec/DISPLAY_ESCAPE.md#display-sanitization-escape-format)).

The equality checks compare the raw values.
Both transforms exist only for display, and the escape is lossy: two different values can display alike, so comparing the displayed forms could report a real mismatch as a match.

## Fields and keys compared by canonical form

The fields and the keys are compared by their RFC 8785 canonical encodings, the encoding the agreed-terms hash covers, so terms equal here hash equal there ([CANONICAL_ENCODING.md, Object member ordering](../spec/CANONICAL_ENCODING.md#object-member-ordering)).

- The encoder sorts object keys, so the order a document lists its properties in does not change the result.
- Fields are sorted by name before encoding, because their order in the list means nothing.
- Keys are ordered from most to least precise, and that order is part of the terms, so keys are compared in place.
- No casing fold is applied: every parse path that produces a `LinkageTerms` has already normalized the `transform.params` keys to camelCase, so both sides reach the comparison in one form.

`canonicalString` throws `CanonicalEncodingError` on a value outside the encoding's domain.
The comparison's contract is to report a problem as a difference rather than throw, so a refused value becomes a difference of the kind it was found in, naming the encoder's message.
A partner cannot reach this over the terms exchange: the terms schema refuses every value the encoder refuses, on every parse path ([CANONICAL_ENCODING.md, Numbers](../spec/CANONICAL_ENCODING.md#numbers)).
The catch stays for a direct caller, since `validateCompatibility` takes two `LinkageTerms` objects and its signature does not require them to be schema-parsed.

Where a side cannot be encoded, the mismatch comparison is skipped for it.
A value that cannot be encoded cannot be compared, and its encoding difference is already a difference of that kind, which refuses the run.

## The payload directions

Each payload direction is checked only where its receiving party declared `payload.receive`, an empty list included.
The three states, absent, empty and present, and how a party arrives at its list are specified in [EXCHANGE_FILE.md, Absent, empty, present](../spec/EXCHANGE_FILE.md#absent-empty-present).

- A declared empty list is strict on purpose: it states that the partner sends nothing, which the consent display shows as `(none)` rather than leaving the direction open.
- An absent list compares nothing, which is what lets an invitation be accepted without the inviting party knowing the accepting party's columns.
- Leaving a list absent relaxes only this check on the declaration.
  It never widens what a party sends, which each party's own metadata decides.

The check is symmetric.
Each direction keys on its own receiving party's declaration, and the two parties call the comparison with their arguments swapped, so both reach the same verdict.

Column lists are compared byte for byte, one sorted column at a time, never as one string joined on a delimiter.
A partner chooses the column names, so a name containing the delimiter could make two different lists join to the same string: `["a,b"]` and `["a","b"]` both join to `a,b`.
