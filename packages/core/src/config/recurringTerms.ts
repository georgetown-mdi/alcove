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
