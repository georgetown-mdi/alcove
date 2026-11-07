// A partner parked on its next receive is read for an abort frame (see
// `sendAbort`) before the frame is parsed as the one awaited, so it reports
// that the partner ended the exchange, not a schema or decode failure.
import { parseOrProtocolError } from "./connection/messageConnection";
import { PeerAbortError } from "./errors";

import type { MessageConnection } from "./connection/messageConnection";

/**
 * The reason a party puts on the abort it sends the partner in place of a set
 * of its own over `MAX_PSI_DECODE_ELEMENTS` (`MAX_SINGLE_PASS_SET_ELEMENTS`
 * for a single-pass set over file-sync) or the partner's stated receive
 * ceiling. A first round the party could not count sends
 * `PSI_SET_REFUSED_ABORT_REASON` instead. A fixed literal, like every abort
 * reason (see `sendAbort`).
 */
export const PSI_SET_TOO_LARGE_ABORT_REASON = "a PSI set is too large to send";

/**
 * The reason a party puts on the abort it sends the partner when its first
 * round, checked against the partner's stated receive ceiling after the terms
 * exchange, refused for any cause other than its size, and when a list of
 * matches it would send is over the bound the partner holds that list to. It
 * states only that the party refused to send.
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
  "the partner cannot process a set as large as the one you send for a linkage key";

/**
 * The abort reason a party sends when its write of the next shared secret
 * failed: the initiator as terms message 3, and the responder as its first
 * frame after it, which the initiator reads past the terms exchange
 * (docs/spec/PROTOCOL.md, "The rotation at the terms exchange"). A fixed
 * literal, as every abort reason must be (see `sendAbort`).
 */
export const NEXT_SECRET_STORE_FAILED_ABORT_REASON =
  "the partner could not save the next shared secret";

/**
 * The abort reason an initiator sends when its drop of the previous shared
 * secret (`TermsRotation.partnerStored`) failed. The next secret is saved by
 * then, so it is not {@link NEXT_SECRET_STORE_FAILED_ABORT_REASON}. A fixed
 * literal, as every abort reason must be (see `sendAbort`).
 */
export const PREVIOUS_SECRET_DROP_FAILED_ABORT_REASON =
  "the partner could not remove its previous shared secret";

/**
 * The abort reason a party sends when a fault of its own ends the run past the
 * terms exchange and no authenticated abort marker is armed to say so
 * (`sendLocalFaultAbort`). A fixed literal, as every abort reason must be (see
 * `sendAbort`): it states nothing of what the fault was.
 */
export const LOCAL_FAULT_ABORT_REASON = "the partner's run stopped on a fault";

/**
 * The abort reason a party sends when it could not record the payload
 * receive list the first run filled: its own failure, not the partner's.
 */
export const PAYLOAD_RECEIVE_UNRECORDED_ABORT_REASON =
  "a party could not record the payload columns it receives";

/**
 * The abort reason a party sends when its operator declines the payload
 * columns the partner's terms declare it sends, on a run that holds no list of
 * the columns it receives (`RunExchangeOptions.onPayloadReceiveFill`).
 */
export const PAYLOAD_RECEIVE_NOT_ACCEPTED_REASON =
  "the partner has not accepted the payload columns you send";

/**
 * The abort reason a party sends when asking about the payload columns failed
 * rather than being answered.
 */
export const PAYLOAD_RECEIVE_UNCONFIRMED_ABORT_REASON =
  "a party could not confirm the payload columns it receives";

/**
 * The abort reason a party sends when the caller's step after the terms
 * exchange (`RunExchangeOptions.onTermsExchanged`) threw.
 */
export const TERMS_EXCHANGED_STEP_FAILED_ABORT_REASON =
  "a party could not complete its step after the terms exchange";

/**
 * The abort reason a party sends when the partner presented a `deduplicate`
 * other than the one the invitation this party accepted declared.
 */
export const INVITATION_DEDUPLICATE_DIVERGENCE_ABORT_REASON =
  "partner presented a deduplicate its invitation did not declare";

/**
 * The abort reason a party sends when the two parties' payload-disclosure
 * assertions do not resolve against the agreed terms.
 */
export const PAYLOAD_DISCLOSURE_DIVERGENCE_ABORT_REASON =
  "a party asserts a payload disclosure the agreed linkage terms declare no column for";

/**
 * The abort reason a party sends when a signed receipt would name both
 * parties and one side's agreed terms name no identity.
 */
export const UNNAMED_PARTY_ABORT_REASON =
  "a signed receipt names both parties and one side's agreed terms name no identity";

/**
 * The abort reason a party sends when its own signing certificate does not
 * authorize the identity under which it agreed on the terms.
 */
export const CERTIFICATE_DIVERGENCE_ABORT_REASON =
  "a signing certificate does not authorize the identity under which its holder agreed on the terms";

/**
 * The abort reason a party sends when it could not record the partner
 * fingerprint it pinned on a first contact: its own failure, not the
 * partner's.
 */
export const PARTNER_CERTIFICATE_UNRECORDED_ABORT_REASON =
  "a party could not record the fingerprint it pinned on this first contact";

/** The abort reason for a partner certificate the wire format does not admit. */
export const PARTNER_CERTIFICATE_UNREADABLE_ABORT_REASON =
  "a party presented a signing certificate the wire format does not admit";

/** The abort reason for a signing run whose partner presented no certificate. */
export const PARTNER_CERTIFICATE_ABSENT_ABORT_REASON =
  "a party signs receipts and its partner presented no signing certificate";

/** The abort reason for a partner certificate that fails its self-signature. */
export const PARTNER_CERTIFICATE_UNVERIFIED_ABORT_REASON =
  "a party presented a signing certificate that does not verify under its own key";

/**
 * The abort reason for a partner certificate that does not authorize the
 * identity in the partner's agreed terms.
 */
export const PARTNER_CERTIFICATE_UNAUTHORIZED_IDENTITY_ABORT_REASON =
  "a party presented a signing certificate that does not authorize the identity under which its holder agreed on the terms";

/** The abort reason for a partner certificate other than the one pinned. */
export const PARTNER_CERTIFICATE_DIVERGENT_ABORT_REASON =
  "a party presented a signing certificate that is not the one its partner pinned";

/**
 * Every reason a party can put on an abort past the terms exchange. Each entry
 * is a single string literal, so its type is that literal and `sendAbort`
 * refuses at compile time any reason not listed here.
 */
export const ABORT_REASONS_AFTER_TERMS = [
  PSI_SET_TOO_LARGE_ABORT_REASON,
  PSI_SET_REFUSED_ABORT_REASON,
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  NEXT_SECRET_STORE_FAILED_ABORT_REASON,
  PREVIOUS_SECRET_DROP_FAILED_ABORT_REASON,
  LOCAL_FAULT_ABORT_REASON,
  PAYLOAD_RECEIVE_UNRECORDED_ABORT_REASON,
  PAYLOAD_RECEIVE_NOT_ACCEPTED_REASON,
  PAYLOAD_RECEIVE_UNCONFIRMED_ABORT_REASON,
  TERMS_EXCHANGED_STEP_FAILED_ABORT_REASON,
  INVITATION_DEDUPLICATE_DIVERGENCE_ABORT_REASON,
  PAYLOAD_DISCLOSURE_DIVERGENCE_ABORT_REASON,
  UNNAMED_PARTY_ABORT_REASON,
  CERTIFICATE_DIVERGENCE_ABORT_REASON,
  PARTNER_CERTIFICATE_UNRECORDED_ABORT_REASON,
  PARTNER_CERTIFICATE_UNREADABLE_ABORT_REASON,
  PARTNER_CERTIFICATE_ABSENT_ABORT_REASON,
  PARTNER_CERTIFICATE_UNVERIFIED_ABORT_REASON,
  PARTNER_CERTIFICATE_UNAUTHORIZED_IDENTITY_ABORT_REASON,
  PARTNER_CERTIFICATE_DIVERGENT_ABORT_REASON,
] as const;

/** One of {@link ABORT_REASONS_AFTER_TERMS}. */
export type AbortReasonAfterTerms = (typeof ABORT_REASONS_AFTER_TERMS)[number];

// The fixed reasons a partner's abort past the terms exchange is matched
// against: those a PSI round sends, and the two failed saves of a rotation.
const KEPT_ABORT_REASONS: ReadonlyArray<AbortReasonAfterTerms> = [
  PSI_SET_TOO_LARGE_ABORT_REASON,
  PSI_SET_REFUSED_ABORT_REASON,
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  NEXT_SECRET_STORE_FAILED_ABORT_REASON,
  PREVIOUS_SECRET_DROP_FAILED_ABORT_REASON,
  LOCAL_FAULT_ABORT_REASON,
];

/**
 * The abort frame `sendAbort` sends past the terms exchange: the decision and
 * its reasons, and nothing else.
 */
export function decisionOnlyAbortFrame(abortReasons: string[]): {
  decision: "abort";
  abortReasons: string[];
} {
  return { decision: "abort", abortReasons };
}

/**
 * The most bytes an abort frame a party sends past the terms exchange takes:
 * the decision-only frame with the longest of {@link ABORT_REASONS_AFTER_TERMS},
 * as the UTF-8 JSON every transport sends it in. A read gate derived for a
 * smaller frame is held at or above it, so the abort is read rather than
 * refused.
 */
export const MAX_ABORT_FRAME_AFTER_TERMS_BYTES = Math.max(
  ...ABORT_REASONS_AFTER_TERMS.map(
    (reason) =>
      new TextEncoder().encode(JSON.stringify(decisionOnlyAbortFrame([reason])))
        .byteLength,
  ),
);

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
  holdInboundQueueBytes: true,
  frameCeilingBytes: true,
  inboundPollIntervalMs: true,
  outboundWebRtcFrameBound: true,
  outboundFileSyncFrameBound: true,
  inboundPsiSetElementCeiling: true,
  outboundFrameOverheadBytes: true,
  useEnvelopeVersion: true,
  requireBinaryFrames: true,
  markLastSentUnread: true,
  raiseInactivityTimeout: true,
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
