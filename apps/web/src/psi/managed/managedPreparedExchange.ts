/**
 * Assemble a re-run's {@link PreparedExchange} from the stored record's
 * own-perspective exchange-file document and the input read this run. An unset
 * `payload.receive` is filled at the terms exchange from the partner's send set
 * (docs/spec/EXCHANGE_FILE.md, "An unset `payload.receive` is filled on the
 * first run"); the acceptor's `expectedPartnerDeduplicate` makes a re-run
 * refuse an inviter presenting any other value before any key or payload moves
 * (docs/spec/EXCHANGE_FILE.md, "Terms-binding consent").
 */

import { prepareForExchange } from "@alcove/core";

import type { CSVRow, ExchangeSpec, PreparedExchange } from "@alcove/core";

/**
 * Build the re-run's prepared exchange, with this party's identity from the
 * persisted terms. Metadata and standardization come from the document when
 * authored, otherwise core infers them from the columns as the quick path does.
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
  // Passed as-is, as the accept path does: an absent declaration binds nothing.
  prepared.expectedPartnerDeduplicate = exchangeFile.expectedPartnerDeduplicate;
  return prepared;
}
