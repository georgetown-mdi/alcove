/**
 * Assemble a re-run's {@link PreparedExchange} from the stored record's
 * exchange-file document and the input acquired THIS run. The record's
 * `exchangeFile` already holds this party's OWN-perspective document -- the
 * linkage terms, metadata, and standardization composed at deposit time (the
 * inviter's minted terms, or the acceptor's derived perspective) -- so a re-run
 * binds those persisted terms to the freshly-read rows and columns. The columns
 * this party receives are the terms' own `payload.receive`, which the terms
 * exchange compares against the partner's stated `payload.send`; a document
 * whose terms leave it unset is filled there from the partner's send set.
 *
 * The terms-side enforcement beside it is the acceptor's persisted
 * `expectedPartnerDeduplicate` -- the `deduplicate` the invitation declared for
 * the inviter's own side -- threaded onto
 * {@link PreparedExchange.expectedPartnerDeduplicate} so a re-run refuses an
 * inviter presenting any other value at the terms exchange
 * (`assertPresentedDeduplicateMatchesInvitation`), before any key or payload
 * moves. Absent on an inviter's record, and on a document composed from no
 * acceptance, where nothing was declared to bind.
 *
 * The document's `includeOwnColumns` rides into `prepareForExchange` beside the
 * metadata, so a re-run's result file holds the same own columns the operator
 * chose for this exchange. A record holding no such key composes the result
 * the partner's values alone make up. Its `retentionDisposition` rides in the
 * same way, into the exchange record the run writes.
 *
 * Pure and exported so the terms binding and the enforcement are the tested
 * boundary, pinned without a connection.
 */

import { prepareForExchange } from "@alcove/core";

import type { CSVRow, ExchangeSpec, PreparedExchange } from "@alcove/core";

/**
 * Build the re-run's prepared exchange. `identity` is read from the persisted
 * terms' own identity (this party's, composed at deposit), so the run holds the
 * same identity the exchange record commits to. The metadata and standardization
 * ride the persisted document when authored, otherwise core infers them from the
 * columns exactly as the quick path does. The persisted
 * `expectedPartnerDeduplicate` is threaded onto the prepared object after
 * `prepareForExchange` (the same call site the accept path uses), never
 * inferred here.
 */
export function prepareManagedRerunExchange(
  exchangeFile: ExchangeSpec,
  rawRows: Array<CSVRow>,
  columns: Array<string>,
): PreparedExchange {
  const prepared = prepareForExchange(
    {
      linkageTerms: exchangeFile.linkageTerms,
      ...(exchangeFile.metadata !== undefined
        ? { metadata: exchangeFile.metadata }
        : {}),
      ...(exchangeFile.standardization !== undefined
        ? { standardization: exchangeFile.standardization }
        : {}),
      ...(exchangeFile.includeOwnColumns !== undefined
        ? { includeOwnColumns: exchangeFile.includeOwnColumns }
        : {}),
      ...(exchangeFile.retentionDisposition !== undefined
        ? { retentionDisposition: exchangeFile.retentionDisposition }
        : {}),
    },
    exchangeFile.linkageTerms.identity,
    rawRows,
    columns,
  );
  // The terms-side enforcement, mirrored from the persisted document exactly as
  // the accept path mirrors it from the invitation's declared terms: passed
  // AS-IS, so an absent declaration (an inviter's record, or a document no
  // acceptance composed) stays undefined and binds nothing.
  prepared.expectedPartnerDeduplicate = exchangeFile.expectedPartnerDeduplicate;
  return prepared;
}
