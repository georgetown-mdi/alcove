import type { LinkageKey } from "../config/linkageTermsSchema.js";

/**
 * Whether `key` is marked as matching on one field: it has exactly one
 * element. A partner can fill its input with guessed values of that one field
 * and learn which of them the other party's file holds (docs/SECURITY_DESIGN.md,
 * Threat model). Every surface that writes or agrees keys reads this one test;
 * the mark warns and never refuses a key.
 */
export function linkageKeyHasOneElement(
  key: Pick<LinkageKey, "elements">,
): boolean {
  return key.elements.length === 1;
}
