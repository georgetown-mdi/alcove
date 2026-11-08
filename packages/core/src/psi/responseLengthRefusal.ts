// A PSI receiver's refusal of the partner's response for its length, and the
// abort that tells the partner of it on every transport: the partner sent the
// response and is parked on the frame after it, so without the abort it ends
// on the channel close instead (docs/spec/PROTOCOL.md, A response of another
// element count is refused).
import { annotate, annotationKey, annotationOf } from "../failureAnnotation";
import { PSI_RESPONSE_LENGTH_ABORT_REASON } from "../partnerAbortFrame";
import { sendAbort } from "../protocolSetup";

import type { MessageConnection } from "../connection/messageConnection";
import type { PartnerProtocolRefusalError } from "../errors";

const RESPONSE_LENGTH_REFUSAL = annotationKey<true>(
  "a PSI response refused for its length",
);

/** `refusal`, marked as the refusal of a PSI response for its length. */
export function asResponseLengthRefusal(
  refusal: PartnerProtocolRefusalError,
): PartnerProtocolRefusalError {
  return annotate(refusal, RESPONSE_LENGTH_REFUSAL, true);
}

/**
 * Runs `step`, and where it raises a refusal {@link asResponseLengthRefusal}
 * marked, sends the partner {@link PSI_RESPONSE_LENGTH_ABORT_REASON} on
 * `conn` before the refusal propagates. Any other failure propagates
 * unchanged.
 */
export async function abortOnResponseLengthRefusal<T>(
  conn: MessageConnection,
  step: () => T | Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (annotationOf(error, RESPONSE_LENGTH_REFUSAL, { ownOnly: true }))
      await sendAbort(conn, [PSI_RESPONSE_LENGTH_ABORT_REASON]);
    throw error;
  }
}
