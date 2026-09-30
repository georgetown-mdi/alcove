import { prepareForExchange } from "@alcove/core";

import { acceptorExchangeDataSpec } from "@psi/acceptInvitation";

import type { CSVRow, LinkageTerms, PreparedExchange } from "@alcove/core";

import type { AcceptorDataEdits } from "@psi/acceptInvitation";

/**
 * Assemble the acceptor's prepared exchange: the data spec adopts the
 * invitation's `linkageTerms` with the committed name substituted and the
 * confirm-columns edits threaded in ({@link acceptorExchangeDataSpec}), then
 * `prepareForExchange` binds it to the acquired CSV's rows and columns.
 *
 * The columns this party receives are the adopted terms' `payload.receive`,
 * mirrored from the invitation's `payload.send` -- the set the consent screen
 * showed -- which the terms exchange compares against the send set the inviter
 * states there.
 *
 * The terms-side commitment is `expectedPartnerDeduplicate`, the value
 * the invitation declared for the inviter's own side: the consent screen stated
 * it, and nothing in the agreed terms compares the two -- so an inviter
 * presenting a different value at the terms exchange aborts the run before any
 * key or payload moves ({@link assertPresentedDeduplicateMatchesInvitation}).
 * It is read off the invitation, never off `deduplicate` below, which is this
 * party's own side and binds the inviter to nothing.
 *
 * Pure and exported so the commitments and the spec assembly are the tested
 * boundary, pinned without running the run lifecycle.
 */
export function prepareAcceptorExchange({
  linkageTerms,
  acceptorName,
  edits,
  rawRows,
  columns,
  deduplicate,
}: {
  linkageTerms: LinkageTerms;
  acceptorName: string;
  edits: AcceptorDataEdits;
  rawRows: Array<CSVRow>;
  columns: Array<string>;
  /** Whether several of THIS party's records may match one of the partner's, as
   * the accepting operator set it at the seat. */
  deduplicate: boolean;
}): PreparedExchange {
  const prepared = prepareForExchange(
    acceptorExchangeDataSpec(linkageTerms, acceptorName, edits, deduplicate),
    acceptorName,
    rawRows,
    columns,
  );
  prepared.expectedPartnerDeduplicate = linkageTerms.deduplicate;
  return prepared;
}
