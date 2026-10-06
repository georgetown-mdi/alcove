// Past the terms exchange, a refusal on one side is one-sided: the refusing
// party best-effort sends an abort frame (see `sendAbort`) to a partner already
// parked on whatever receive comes next. That receive may await a PSI binary
// frame or a JSON frame with a strict schema; either way the abort is read for
// what it is before the frame is parsed as the one the receive awaited, so the
// parked party reports that the partner ended the exchange rather than a
// schema or decode failure naming nothing it can act on.
import { parseOrProtocolError } from "./connection/messageConnection";
import { PeerAbortError } from "./errors";

import type { MessageConnection } from "./connection/messageConnection";

/**
 * The reason a party puts on the abort it sends the partner in place of a set
 * of its own over `MAX_PSI_DECODE_ELEMENTS` or the partner's stated
 * receive ceiling. A first round the party could not count sends
 * `PSI_SET_REFUSED_ABORT_REASON` instead. A fixed literal, like every abort
 * reason (see `sendAbort`).
 */
export const PSI_SET_TOO_LARGE_ABORT_REASON = "a PSI set is too large to send";

/**
 * The reason a party puts on the abort it sends the partner when its first
 * round, checked against the partner's stated receive ceiling after the terms
 * exchange, refused for any cause other than its size. It states only that
 * the party refused to send its set.
 */
export const PSI_SET_REFUSED_ABORT_REASON =
  "a PSI set was refused before sending";

/**
 * The abort reason a party sends when the partner's set for a linkage key is
 * larger than this party can process: at the terms exchange
 * (`checkPartnerRoundCapacity` in exchange.ts) or at the first part of the set
 * (`receivePsiSet`). A fixed literal, as every abort reason must be (see
 * `sendAbort`).
 */
export const PARTNER_SET_OVER_CAPACITY_ABORT_REASON =
  "the partner cannot process a set as large as the one you send for a " +
  "linkage key";

const ROUND_ABORT_REASONS: ReadonlyArray<string> = [
  PSI_SET_TOO_LARGE_ABORT_REASON,
  PSI_SET_REFUSED_ABORT_REASON,
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
];

/**
 * Whether a raw received frame is one of the abort decisions `sendAbort`
 * emits. Read off the `decision` discriminant alone, which is what both
 * terms-exchange slots key on and the only field either form of the frame is
 * required to hold: the reasons beside it are partner-written text.
 *
 * The terms exchange itself parses the whole envelope instead, because it
 * reads the rest of the frame.
 */
function isPartnerAbortFrame(frame: unknown): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as { decision?: unknown }).decision === "abort"
  );
}

// The one fixed round abort reason an abort frame states, as this build's own
// constant, or undefined for any other frame: the frame's text is never kept.
function roundAbortReasonOf(frame: unknown): string | undefined {
  const reasons = (frame as { abortReasons?: unknown }).abortReasons;
  if (!Array.isArray(reasons) || reasons.length !== 1) return undefined;
  return ROUND_ABORT_REASONS.find((reason) => reason === reasons[0]);
}

/**
 * Raises {@link PeerAbortError} where `frame` is the partner's abort decision,
 * and returns otherwise. The abort's reasons are partner-written text, compared
 * only against the fixed reasons a PSI round sends; the error's
 * `partnerReason` holds this build's own constant where one matches, so the
 * error holds no partner byte.
 */
export function throwIfPartnerAbort(frame: unknown): void {
  if (isPartnerAbortFrame(frame))
    throw new PeerAbortError(undefined, roundAbortReasonOf(frame));
}

/**
 * Parses a frame received past the terms exchange: a partner's abort raises
 * {@link PeerAbortError} (see {@link throwIfPartnerAbort}), and anything else
 * is parsed strictly, a frame that fails the schema raising a `protocol`
 * `ConnectionError`.
 *
 * @param schema - The schema the awaited frame is parsed under.
 * @param frame - The frame as received.
 */
export function parseAfterTerms<T>(
  schema: { parse(value: unknown): T },
  frame: unknown,
): T {
  throwIfPartnerAbort(frame);
  return parseOrProtocolError(schema, frame);
}

/**
 * Receives the next frame past the terms exchange and parses it as
 * {@link parseAfterTerms} does.
 */
export async function receiveAfterTerms<T>(
  conn: MessageConnection,
  schema: { parse(value: unknown): T },
): Promise<T> {
  return parseAfterTerms(schema, await conn.receive());
}
