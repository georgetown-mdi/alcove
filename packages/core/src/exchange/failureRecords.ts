import { annotate, annotationKey, annotationOf } from "../failureAnnotation.js";
import { getLogger } from "../utils/logger.js";

import type { BuiltExchangeRecord } from "../records/exchangeRecord.js";

// The self-attested record a terminated run leaves on the error it throws, and
// the accessors a caller reads it back with.

const TERMINATED_RUN_RECORD = annotationKey<BuiltExchangeRecord>(
  "terminated run record",
);

// A key of its own rather than a sentinel record, so "nothing was owed" and
// "what was owed could not be built" do not share one undefined.
const TERMINATED_RUN_RECORD_UNBUILT = annotationKey<true>(
  "terminated run record unbuilt",
);

const TERMINATED_RUN_ONE_DIRECTIONAL = annotationKey<true>(
  "terminated run disclosed one direction",
);

/**
 * The self-attested record of the disclosure a terminated run had already made,
 * recovered from the error {@link runExchange} threw by walking the `cause`
 * chain; `undefined` when the failure has none.
 *
 * A run owes the record once its own payload send resolves or is rejected as
 * indeterminate (docs/spec/EXCHANGE_RECORD.md, When a record is owed). The
 * caller persists it as it persists {@link ExchangeResult.audit}; the record's
 * `outcome` field states the failure.
 */
export function exchangeRecordFromFailure(
  error: unknown,
): BuiltExchangeRecord | undefined {
  return annotationOf(error, TERMINATED_RUN_RECORD);
}

/**
 * Whether the terminated run behind `error` owed a self-attested record that
 * {@link buildExchangeRecord} could not build: the failure-path form of
 * {@link ExchangeResult.recordOwedButUnbuilt}, so a caller can report the loss
 * on a machine interface. False when no record was owed or the record is in
 * hand, the two cases a bare `undefined` from {@link exchangeRecordFromFailure}
 * cannot tell apart. Walks the `cause` chain.
 */
export function exchangeRecordOwedButUnbuilt(error: unknown): boolean {
  return annotationOf(error, TERMINATED_RUN_RECORD_UNBUILT) === true;
}

/**
 * Whether the terminated run behind `error` disclosed this party's payload and
 * received none of the partner's. Its record commits to an empty received
 * payload, the same as for a partner that sent none
 * (docs/spec/EXCHANGE_RECORD.md, When a record is owed). False for a run that
 * received the partner's payload or owed no record. Walks the `cause` chain.
 */
export function exchangeDisclosedWithoutPartnerPayload(
  error: unknown,
): boolean {
  return annotationOf(error, TERMINATED_RUN_ONE_DIRECTIONAL) === true;
}

/**
 * `error`, marked for the accessors above. A thrown non-object cannot take a
 * mark, which is warned: the operator's disclosure-log entry for a disclosure
 * that happened goes missing.
 */
export function carryingExchangeRecord(
  error: unknown,
  audit: BuiltExchangeRecord | undefined,
  partnerPayloadReceived: boolean,
): unknown {
  if (typeof error !== "object" || error === null) {
    // Warned only where a record exists and is now unreachable; a record that
    // never built already warned at its build, with the cause this cannot name.
    if (audit !== undefined)
      getLogger("exchange").warn(
        "the exchange disclosed and then failed, and the failure is not an " +
          "object this run's self-attested record could be attached to; no " +
          "record is available to write for a disclosure that occurred",
      );
    return error;
  }
  if (!partnerPayloadReceived)
    annotate(error, TERMINATED_RUN_ONE_DIRECTIONAL, true);
  if (audit === undefined)
    return annotate(error, TERMINATED_RUN_RECORD_UNBUILT, true);
  return annotate(error, TERMINATED_RUN_RECORD, audit);
}
