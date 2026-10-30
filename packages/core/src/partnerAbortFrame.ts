// A partner parked on its next receive is read for an abort frame (see
// `sendAbort`) before the frame is parsed as the one awaited, so it reports
// that the partner ended the exchange, not a schema or decode failure.
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

/**
 * The abort reason a party sends when its write of the next shared secret
 * failed: the initiator as terms message 3, and the responder as its first
 * frame after it, which the initiator reads past the terms exchange
 * (docs/spec/PROTOCOL.md, "The rotation at the terms exchange"). A fixed
 * literal, as every abort reason must be (see `sendAbort`).
 */
export const NEXT_SECRET_STORE_FAILED_ABORT_REASON =
  "the partner could not save the next shared secret";

// The fixed reasons a partner's abort past the terms exchange is matched
// against: those a PSI round sends, and the responder's failed store.
const KEPT_ABORT_REASONS: ReadonlyArray<string> = [
  PSI_SET_TOO_LARGE_ABORT_REASON,
  PSI_SET_REFUSED_ABORT_REASON,
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  NEXT_SECRET_STORE_FAILED_ABORT_REASON,
];

/**
 * Whether a raw received frame is an abort decision, read off the `decision`
 * discriminant alone.
 */
function isPartnerAbortFrame(frame: unknown): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as { decision?: unknown }).decision === "abort"
  );
}

// The one kept abort reason an abort frame states, as this build's own
// constant, or undefined for any other frame: the frame's text is never kept.
function keptAbortReasonOf(frame: unknown): string | undefined {
  const reasons = (frame as { abortReasons?: unknown }).abortReasons;
  if (!Array.isArray(reasons) || reasons.length !== 1) return undefined;
  return KEPT_ABORT_REASONS.find((reason) => reason === reasons[0]);
}

/**
 * Raises {@link PeerAbortError} where `frame` is the partner's abort decision,
 * and returns otherwise. The abort's reasons are partner-written text, compared
 * only against {@link KEPT_ABORT_REASONS}; the error's `partnerReason` holds
 * this build's own constant where one matches, so the error holds no partner
 * byte.
 */
export function throwIfPartnerAbort(frame: unknown): void {
  if (isPartnerAbortFrame(frame))
    throw new PeerAbortError(undefined, keptAbortReasonOf(frame));
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

// Every member of MessageConnection, so a member added there and not forwarded
// by afterFirstFrameNotAbort fails to compile here.
const FORWARDED_CONNECTION_MEMBERS = {
  send: true,
  receive: true,
  close: true,
  terminated: true,
  setInboundFrameCap: true,
  inboundPollIntervalMs: true,
  outboundWebRtcFrameBound: true,
  outboundFileSyncFrameBound: true,
  inboundPsiSetElementCeiling: true,
  outboundFrameOverheadBytes: true,
} as const satisfies Record<keyof MessageConnection, true>;

/**
 * `conn` with `hook` awaited once, when the first received frame that is not
 * a partner's abort decision arrives, before that frame is returned. Every
 * other member is forwarded unchanged. A throw from `hook` rejects that
 * receive.
 */
export function afterFirstFrameNotAbort(
  conn: MessageConnection,
  hook: () => void | Promise<void>,
): MessageConnection {
  let pending = true;
  const forwarded: Record<string, unknown> = {};
  for (const name of Object.keys(FORWARDED_CONNECTION_MEMBERS)) {
    const member = (conn as unknown as Record<string, unknown>)[name];
    if (typeof member === "function") forwarded[name] = member.bind(conn);
  }
  return {
    ...(forwarded as unknown as MessageConnection),
    receive: async (timeoutMs?: number) => {
      const frame = await conn.receive(timeoutMs);
      if (pending && !isPartnerAbortFrame(frame)) {
        pending = false;
        await hook();
      }
      return frame;
    },
  };
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
