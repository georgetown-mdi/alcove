import type { LinkageTerms } from "./linkageTermsSchema.js";

/**
 * The refusal an authoring path gives terms for a recurring exchange that
 * state no `payload.receive` ({@link recurringTermsLackDeclaredReceive}). A
 * fixed literal: the caller names the document it read.
 */
export const RECURRING_RECEIVE_REQUIRED_MESSAGE =
  "linkage_terms.payload.receive is required for a recurring exchange: list " +
  "the payload columns you expect your partner to send for matched records, " +
  "or write receive: [] to receive none";

/**
 * Whether terms authored for a recurring exchange lack the `payload.receive`
 * list that exchange requires. The list is the inviter's half of the payload
 * mirror: an acceptor adopts it as its own `payload.send`
 * (`deriveAcceptedLinkageTerms`), so stating it fixes what the partner sends
 * inside the agreed terms, and a later change to either side's payload is a
 * terms mismatch at the handshake. An explicit empty list states "receive
 * nothing" and satisfies the rule.
 *
 * Terms under which the partner can send this party no payload need no list:
 * a count-only (`psi-c`) document, which admits no payload in either
 * direction, and a party that receives no result
 * (`output.expectsOutput: false`), whose `receive` the schema holds empty.
 */
export function recurringTermsLackDeclaredReceive(
  terms: LinkageTerms,
): boolean {
  if (terms.algorithm === "psi-c" || !terms.output.expectsOutput) return false;
  return terms.payload?.receive === undefined;
}
