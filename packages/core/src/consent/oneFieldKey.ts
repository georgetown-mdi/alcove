import type { LinkageKey } from "../config/linkageTermsSchema.js";

/**
 * Whether every element of `key` reads the same field, so the key matches on
 * one field: one element, or one field repeated under aliases with different
 * transforms. A partner can fill its input with guessed values of that field
 * and learn which of them the other party's file holds (docs/SECURITY_DESIGN.md,
 * Threat model). Every surface that marks keys reads this one test, with
 * `ONE_FIELD_KEY_COPY` (consentFacts.ts); the mark warns and never refuses a
 * key.
 */
export function linkageKeyUsesOneField(
  key: Pick<LinkageKey, "elements">,
): boolean {
  return new Set(key.elements.map((element) => element.field)).size === 1;
}
