import { annotate, annotationKey, annotationOf } from "../failureAnnotation.js";
import { getLogger } from "../utils/logger.js";

import type { BuiltExchangeRecord } from "../records/exchangeRecord.js";

// The self-attested record a terminated run leaves on the error it throws, and
// the accessors a caller reads it back with.

// Where a terminated run's self-attested record waits for the caller that catches
// the throw.
const TERMINATED_RUN_RECORD = annotationKey<BuiltExchangeRecord>(
  "terminated run record",
);

// The other half of the same answer: the terminated runs that owed a record and
// whose build of it threw. A key of its own rather than a sentinel record so the
// record-bearing accessor's return type stays exactly what a caller already
// handles, and so "nothing was owed" and "what was owed could not be built" stop
// sharing one undefined.
const TERMINATED_RUN_RECORD_UNBUILT = annotationKey<true>(
  "terminated run record unbuilt",
);

// The terminated runs whose payload crossed and whose partner's never arrived,
// so the record beside them commits to no received payload.
const TERMINATED_RUN_ONE_DIRECTIONAL = annotationKey<true>(
  "terminated run disclosed one direction",
);

/**
 * The self-attested record of the disclosure a terminated run had ALREADY made,
 * recovered from the error {@link runExchange} threw; `undefined` when the failure
 * holds none.
 *
 * A run past its own payload send has handed this party's payload to the
 * transport, so the disclosure the record attests occurred whatever the steps after
 * it then do. The record is owed from that point (docs/spec/PROTOCOL.md,
 * Self-attested record), so the caller persists this pair exactly as it persists
 * {@link ExchangeResult.audit}: the run still failed, and the record's own
 * `outcome` field states that rather than passing for a completed run's.
 *
 * A failure raised before this party's payload send holds nothing: the region
 * had not opened, so no record is owed. The send holds one both when it resolves
 * and when the transport rejects it as indeterminate -- a publish it can neither
 * confirm nor retract (docs/spec/EXCHANGE_RECORD.md, When a record is owed).
 *
 * The lookup walks the `cause` chain, so a caller that re-raises the failure with
 * the original as its `cause` still recovers the record.
 */
export function exchangeRecordFromFailure(
  error: unknown,
): BuiltExchangeRecord | undefined {
  return annotationOf(error, TERMINATED_RUN_RECORD);
}

/**
 * Whether the terminated run behind `error` owed a self-attested record that
 * could not be built, so {@link exchangeRecordFromFailure} returns nothing for a
 * disclosure that nonetheless occurred.
 *
 * True only past this party's payload send: the record was owed (docs/spec/PROTOCOL.md,
 * Self-attested record) and {@link buildExchangeRecord} threw, which the build
 * warns about on the operator log with its cause. This is the same loss
 * {@link ExchangeResult.recordOwedButUnbuilt} states on the completed path, asked
 * of the failure here so a caller can report it on a machine interface rather
 * than only in a log line an unattended run discards. False when the failure owed
 * no record at all, and false once the record is in hand -- the two answers a bare
 * `undefined` from {@link exchangeRecordFromFailure} cannot tell apart.
 *
 * The lookup walks the `cause` chain, as its record-bearing sibling does.
 */
export function exchangeRecordOwedButUnbuilt(error: unknown): boolean {
  return annotationOf(error, TERMINATED_RUN_RECORD_UNBUILT) === true;
}

/**
 * Whether the terminated run behind `error` disclosed this party's payload and
 * received none of the partner's -- the run cut, or the reply refused at the
 * wire schema, between this party's own send and the partner's frame.
 *
 * The record such a run leaves commits to an empty received payload, which is
 * what this party received but reads no differently from a partner that
 * transmitted none (docs/spec/EXCHANGE_RECORD.md, When a record is owed). A
 * caller accounting for the disclosure reads the distinction here: this party's
 * data crossed and nothing came back. False for a run that received the
 * partner's payload before terminating, and false for one that owed no record.
 *
 * The lookup walks the `cause` chain, as its siblings above do.
 */
export function exchangeDisclosedWithoutPartnerPayload(
  error: unknown,
): boolean {
  return annotationOf(error, TERMINATED_RUN_ONE_DIRECTIONAL) === true;
}

/**
 * `error`, marked for the accessors above: holding `audit` where the record
 * built, recording the loss where it did not so a caller can tell that absence
 * from a failure that owed no record, and recording whether the partner's
 * payload arrived at all. A thrown non-object can hold no mark, which is warned
 * here: what goes missing is the operator's disclosure-log entry for a
 * disclosure that happened.
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
