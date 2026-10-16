---
title: "Folding Column Names Before the Linkage-Key Lookup"
---

# Folding column names before the linkage-key lookup

_Status: decided on the maintainer's ruling and built.
The fold and the table it is matched against are specified in [DEFAULT_STANDARDIZATION.md, Type inference from column names](../spec/DEFAULT_STANDARDIZATION.md#type-inference-from-column-names); this note records what the change does to configurations written before it.
See [docs/notes/README.md](README.md)._

Inference recognizes a linkage-key column by its header, and the CSV reader keeps header whitespace.
A lookup on the lowercased header alone does not recognize `First Name`, ` ssn` or `Social Security Number`: a quick exchange sends such a column as payload, and every other inference leaves it undeclared.

The lookup folds the header first, as the spec describes.
The fold makes a lookup key only; the column keeps its raw header as its name.

## What was weighed

- **Leave it, with the pre-run display as the remedy.**
  Declined.
  The display lists every column a quick exchange sends but asks nothing, so an operator who does not read it sends SSN values under a header such as `Social Security Number`.
- **Warn on a sent column whose folded name is a listed name.**
  Declined.
  It adds a mechanism and leaves the column sent.
- **Fold in the quick exchange only.**
  Declined.
  The same header would be a key on a quick run and undeclared on an invited one.
- **Fold in every mode, in core's one inference lookup.**
  Taken, with no new warning or refusal.
  The `field (column)` form of the pre-run display already names each column read as a key.

Matching after the fold stays exact, never fuzzy or by substring, so `ssn_last4` is not read as `ssn`.
A name ending in `_id` after the fold, such as `Medicaid ID`, is an identifier column like `medicaid_id`, which a quick exchange sends by design.

## Consequences for existing configurations

Every header the lowercase-only lookup recognized is recognized as the same type after the fold: every listed name is its own lookup key, and a lowercased name ending in `_id` still ends in `_id` once folded (pinned by `packages/core/test/config/columnNameLookupKey.test.ts`).
The fold only adds recognized headers, and each added header changes what a run declares on the same input file:

- **A quick exchange** keeps back a column the lowercase-only lookup sends.
  The partner receives one payload column fewer, and the pre-run display lists the column as matched on or held back.
- **A configuration or invitation with no `metadata` block** declares a column the lowercase-only lookup leaves undeclared.
  The column is not sent either way, except a header such as `ID ` whose key is `id` or `identifier`, which the table's `identifier` row sends, so the declared send set changes.
  Where the configuration also has no `linkage_terms`, the terms are inferred from the metadata, so a header such as `Date of Birth` adds a field and the keys that use it.
  The terms change at the next handshake.
- **A configuration with explicit terms but no `metadata` block** can bind a field by its type to a header the fold recognizes, in place of a later column of that type or of no column.
- **A configuration with no `metadata` block and one `_id` column** loses it as the identifier when the fold recognizes a second identifier-typed header, such as `Record ID`.
  The promotion needs exactly one identifier-typed column, so neither column indexes this party's own records and, declared-only, neither is declared.

A changed set of terms meets a partner on a build with the lowercase-only lookup, which still infers the old terms, and the run stops with a terms mismatch before any record is compared.
Alcove is pre-release, so the two parties upgrade together rather than through a compatibility rule; a configuration that must keep its old meaning authors a `metadata` block.
