import { observedPartnerCertificateMismatch } from "../records/signingIdentity.js";
import { buildExchangeRecord } from "../records/exchangeRecord.js";
import { toCommittedPayload } from "../payloadExchange.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeErrorForDisplay } from "../utils/sanitizeErrorForDisplay.js";

import type { LinkageTerms } from "../config/linkageTermsSchema.js";
import type { PreparedExchange } from "../exchange.js";
import type { PartnerPayload, PayloadWireMessage } from "../payloadExchange.js";
import type { BuiltExchangeRecord } from "../records/exchangeRecord.js";
import type { AssociationTable } from "../types.js";

/**
 * Build the record once the run's outcome is decided, so it can state it. It
 * is a secondary audit artifact, so a failure to build it (e.g. an unexpected
 * non-canonical value) must not fail a run that otherwise succeeded or
 * discard its result: catch, warn, and continue without a record.
 * `recordOwedButUnbuilt` is the completed path's report of the loss the
 * terminated path marks on its failure (carryingExchangeRecord).
 */
export async function buildOwedExchangeRecord(p: {
  localTerms: LinkageTerms;
  partnerTerms: LinkageTerms;
  postDisclosureFailure: { error: unknown } | undefined;
  rowCount: number;
  dataset: PreparedExchange["dataset"];
  bothExpectOutput: boolean;
  attestedResultSize: number | undefined;
  retentionDisposition: string | undefined;
  heldResult: boolean;
  associationTable: AssociationTable | undefined;
  localPayload: PayloadWireMessage;
  countOnly: boolean;
  partnerPayload: PartnerPayload;
  receiptBinder: string | undefined;
}): Promise<{
  audit: BuiltExchangeRecord | undefined;
  recordOwedButUnbuilt: boolean;
}> {
  const {
    localTerms,
    partnerTerms,
    postDisclosureFailure,
    rowCount,
    dataset,
    bothExpectOutput,
    attestedResultSize,
    retentionDisposition,
    heldResult,
    associationTable,
    localPayload,
    countOnly,
    partnerPayload,
    receiptBinder,
  } = p;
  let audit: BuiltExchangeRecord | undefined;
  let recordOwedButUnbuilt = false;
  try {
    audit = await buildExchangeRecord({
      localTerms,
      partnerTerms,
      outcome:
        postDisclosureFailure === undefined
          ? "completed"
          : "receipt-swap-terminated",
      // Read off the terminating error's own condition, never its message: a
      // failure that says nothing about the certificate the partner presented
      // -- a transport drop, a refused received payload, a receipt signature
      // that did not verify over a certificate that matched the pin, a run
      // with no pin on file -- records that none was observed.
      certificateMismatchObserved:
        postDisclosureFailure !== undefined &&
        observedPartnerCertificateMismatch(postDisclosureFailure.error),
      recordsExposed: rowCount,
      contributedLinkageFields: [...dataset.fieldNames],
      resultSize: bothExpectOutput ? attestedResultSize : undefined,
      // Self-facing audit pointer from this party's local config; undefined when
      // unconfigured, in which case the record omits it.
      retentionDisposition,
      associationTable: heldResult ? associationTable : undefined,
      localPayloadSent: toCommittedPayload(localPayload),
      // A count-only run receives no payload by its terms, so a frame a
      // non-conforming partner sent before the refusal is not committed as one
      // (docs/spec/EXCHANGE_RECORD.md, Count-only (psi-c) records).
      partnerPayloadReceived: toCommittedPayload(
        countOnly ? { columns: [], rowIndices: [], rows: [] } : partnerPayload,
      ),
      createdAt: new Date().toISOString(),
      // The run's shared binder, so this record pairs with the signed receipt;
      // omitted on every path that derived none.
      receiptBinder,
    });
  } catch (err) {
    recordOwedButUnbuilt = true;
    // Two warnings rather than one conditional tail: on a terminated run there is
    // no result to be unaffected -- the caller's throw discards it -- so the
    // completed path's reassurance would be a false claim there.
    getLogger("exchange").warn(
      postDisclosureFailure === undefined
        ? "the exchange disclosed but the self-attested record could not be " +
            `built (${sanitizeErrorForDisplay(err)}); the result above is ` +
            "unaffected"
        : "the exchange disclosed and then failed, and the self-attested " +
            `record of that disclosure could not be built (${sanitizeErrorForDisplay(err)}); ` +
            "the run's own failure is reported separately",
    );
  }
  return { audit, recordOwedButUnbuilt };
}
