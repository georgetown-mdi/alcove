import { sanitizeForDisplay } from "../utils/sanitizeForDisplay.js";
import type { LinkageTerms } from "./linkageTermsSchema.js";

/**
 * Whether a run under `terms` fills `payload.receive` from the partner's
 * declared send set at the terms exchange: the list is unset, and the partner
 * can send this party payload at all. A count-only (`psi-c`) document admits no
 * payload in either direction, and a party that receives no result
 * (`output.expectsOutput: false`) is sent none, so neither has a list to fill.
 * An explicit empty list states "receive nothing" and is not filled.
 */
export function payloadReceiveFillsOnFirstRun(terms: LinkageTerms): boolean {
  if (terms.algorithm === "psi-c" || !terms.output.expectsOutput) return false;
  return terms.payload?.receive === undefined;
}

/**
 * The column names an unset `payload.receive` in `terms` resolves to against
 * the partner's terms as they crossed the wire: the partner's stated
 * `payload.send`, or none when it states no list. Undefined when the list does
 * not fill ({@link payloadReceiveFillsOnFirstRun}). The run records these
 * names, and the agreed-terms hash covers the terms with them in place
 * ({@link termsResolvingPayloadReceive}); both read them from here.
 */
export function payloadReceiveFill(
  terms: LinkageTerms,
  partnerTerms: LinkageTerms,
): string[] | undefined {
  if (!payloadReceiveFillsOnFirstRun(terms)) return undefined;
  return (partnerTerms.payload?.send ?? []).map((column) => column.name);
}

/**
 * `terms` with an unset `payload.receive` resolved to the partner's stated
 * send set ({@link payloadReceiveFill}), each column by name alone, as the run
 * records it; any other `terms` is returned unchanged. Both parties derive the
 * same resolved pair from the two documents that crossed the wire, and a
 * configuration the fill has written resolves to itself.
 */
export function termsResolvingPayloadReceive(
  terms: LinkageTerms,
  partnerTerms: LinkageTerms,
): LinkageTerms {
  const filled = payloadReceiveFill(terms, partnerTerms);
  if (filled === undefined) return terms;
  return {
    ...terms,
    payload: { ...terms.payload, receive: filled.map((name) => ({ name })) },
  };
}

/**
 * The one line a front end shows or logs when a run fills `payload.receive`
 * from the partner's declared send set. The names are the partner's, so each
 * is escaped for display here; the line goes to a log or UI sink as it is.
 */
export function payloadReceiveFilledNotice(columns: readonly string[]): string {
  const listed =
    columns.length === 0
      ? "no payload columns"
      : `payload columns ${columns.map((name) => `"${sanitizeForDisplay(name)}"`).join(", ")}`;
  return (
    `payload.receive was not set, so it is set from what the partner ` +
    `declares it sends: ${listed}. Later exchanges refuse a partner that ` +
    `sends a different list.`
  );
}
