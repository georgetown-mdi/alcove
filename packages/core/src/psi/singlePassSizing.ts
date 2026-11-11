import { FAN_OUT_CANDIDATES_PER_ELEMENT } from "../fanOutFunctions";
import { MAX_PSI_DECODE_ELEMENTS } from "../connection/frameSize";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_REQUEST_FRAMING_BYTES,
} from "../connection/webrtcOutboundBound";

/**
 * The single-pass ceiling on each party's value slots
 * (`effectiveKeyCount * recordCount`, not rows) over WebRTC: the lesser of the
 * two parties' stated receive ceilings where it is under
 * {@link MAX_PSI_DECODE_ELEMENTS}, which only a browser party states, or
 * `undefined` between two command-line parties, which the memory check at the
 * terms exchange holds instead. Both parties read it from the terms exchange,
 * so they reach one verdict (docs/spec/PROTOCOL.md, The single-pass dataset
 * ceiling: receiver memory and masking compute).
 */
export function singlePassValueSlotCeiling(
  localReceiveCeiling: number,
  partnerReceiveCeiling: number,
): number | undefined {
  const ceiling = Math.min(localReceiveCeiling, partnerReceiveCeiling);
  return ceiling < MAX_PSI_DECODE_ELEMENTS ? ceiling : undefined;
}

// Byte weights of the reply cap, each an upper bound on the serialized cost of
// `encodeSinglePassReply` (link.ts): undershooting rejects a legitimate frame
// (docs/spec/PROTOCOL.md, The single-pass dataset ceiling).
const SINGLE_PASS_BYTES_PER_MASKED_VALUE = 40;
const SINGLE_PASS_BYTES_PER_INDEX_WORD = 4;
const SINGLE_PASS_REPLY_OVERHEAD_BYTES = 256;

/**
 * One party's authenticated single-pass size: the effective key count both
 * parties derive from the agreed terms and the party's declared record count.
 * Their product is its value slot count. Named fields, because a swapped sender
 * and receiver yield a different cap on one side.
 */
export interface SinglePassPartySize {
  /**
   * The effective key count the agreed terms declare (`declaredEffectiveKeyCount`),
   * the same number on both parties.
   */
  readonly effectiveKeyCount: number;
  /** The party's row count times its own fan-out factor, as declared. */
  readonly recordCount: number;
}

/**
 * One party's value slot count, the product every gate below weighs, exported so
 * a diagnosis states that product rather than a neighbouring pair of counts.
 */
export function valueSlots(party: SinglePassPartySize): number {
  return party.effectiveKeyCount * party.recordCount;
}

/**
 * Whether the party's effective key count exceeds the agreed key count: the one
 * discriminant for the index-table layout (link.ts), the ragged term of
 * {@link singlePassReplyByteCap}, and the fan-out remedy. A divergence between
 * them rejects a legitimate reply or misreads a frame.
 */
export function partyFansOut(
  agreedKeyCount: number,
  party: Pick<SinglePassPartySize, "effectiveKeyCount">,
): boolean {
  return party.effectiveKeyCount > agreedKeyCount;
}

/**
 * Whether one party's own value slots exceed `ceiling`: the one-party
 * pre-flight in {@link prepareForExchange} for a browser party, at
 * {@link BROWSER_PSI_SET_MAX_ELEMENTS}. The two-party gate is
 * {@link singlePassCeilingBreach}.
 */
export function singlePassDatasetExceedsCap(
  effectiveKeyCount: number,
  recordCount: number,
  ceiling: number,
): boolean {
  return effectiveKeyCount * recordCount > ceiling;
}

/**
 * Which side of an exchange breached the single-pass ceiling, named from the point
 * of view of the party asking. See {@link singlePassCeilingBreach}.
 */
export type SinglePassCeilingBreach = "local" | "partner" | "both";

/**
 * Which side breached the single-pass value slot `ceiling`
 * ({@link singlePassValueSlotCeiling}), from the asking party's view, or
 * `undefined` within it. Computed from authenticated state both parties have,
 * so the two verdicts mirror each other and the abort stays symmetric.
 */
export function singlePassCeilingBreach(
  local: SinglePassPartySize,
  partner: SinglePassPartySize,
  ceiling: number,
): SinglePassCeilingBreach | undefined {
  const localOver = singlePassDatasetExceedsCap(
    local.effectiveKeyCount,
    local.recordCount,
    ceiling,
  );
  const partnerOver = singlePassDatasetExceedsCap(
    partner.effectiveKeyCount,
    partner.recordCount,
    ceiling,
  );
  if (localOver && partnerOver) return "both";
  if (localOver) return "local";
  if (partnerOver) return "partner";
  return undefined;
}

/**
 * The accepted byte size of the single-pass reply, identical on both parties:
 * the receiver's read gate and the sender's send-time check. Its terms and integer
 * arithmetic are fixed in docs/spec/PROTOCOL.md (The single-pass dataset ceiling).
 * `responseBytes` is the response term: the bytes of the request the receiver
 * sent, which both parties hold once it is sent, or before then a bound on it.
 * Without it the term is the receiver's slots at the per-value figure. Over
 * WebRTC call only for an in-cap exchange. Over file-sync the sum can round
 * above 2^53, which leaves it past the clamp the read gate applies.
 */
export function singlePassReplyByteCap(
  keyCount: number,
  sender: SinglePassPartySize,
  receiver: SinglePassPartySize,
  responseBytes: number = SINGLE_PASS_BYTES_PER_MASKED_VALUE *
    valueSlots(receiver),
): number {
  return (
    (SINGLE_PASS_BYTES_PER_MASKED_VALUE + SINGLE_PASS_BYTES_PER_INDEX_WORD) *
      valueSlots(sender) +
    responseBytes +
    SINGLE_PASS_BYTES_PER_INDEX_WORD * keyCount * sender.recordCount +
    SINGLE_PASS_REPLY_OVERHEAD_BYTES
  );
}

/**
 * The most bytes a single-pass request from this receiver can take: one
 * encoded element a value slot, plus the request's own field. The sender's
 * read gate for the request, and before the request is built the bound on the
 * reply's response term.
 */
export function singlePassRequestByteCap(
  receiver: SinglePassPartySize,
): number {
  return (
    PSI_ENCODED_ELEMENT_BYTES * valueSlots(receiver) + PSI_REQUEST_FRAMING_BYTES
  );
}

/**
 * The least memory a single-pass reply from this sender can take, in bytes: its
 * index table's one word per key and row, which no choice of values reduces. A
 * declared count is the sender's rows times its fan-out factor, 1 or
 * {@link FAN_OUT_CANDIDATES_PER_ELEMENT}, so a count the larger factor divides is
 * weighed at the fewer rows.
 */
export function singlePassIrreducibleReplyBytes(
  keyCount: number,
  senderRecordCount: number,
): number {
  const rows =
    senderRecordCount % FAN_OUT_CANDIDATES_PER_ELEMENT === 0
      ? senderRecordCount / FAN_OUT_CANDIDATES_PER_ELEMENT
      : senderRecordCount;
  return SINGLE_PASS_BYTES_PER_INDEX_WORD * keyCount * rows;
}

/**
 * Upper bounds on the encrypted-element count a received PSI setup or request may
 * declare, from authenticated sizes only, enforced before `deserializeBinary` in
 * participant.ts. A response is held to the request this party sent instead.
 */
export interface PsiElementBounds {
  /** Max elements a received server setup (the sender's masked set) may declare. */
  readonly setup: number;
  /** Max elements a received request (the receiver's masked set) may declare. */
  readonly request: number;
}

/**
 * Each party's value slot count, the most distinct values it can send, so no
 * legitimate frame is rejected on either the single-pass or the cascade path.
 * Each party enforces the bound for the message it receives. The products are
 * exact: record counts are bounded by {@link MAX_RECORD_COUNT}.
 */
export function psiElementBounds(
  sender: SinglePassPartySize,
  receiver: SinglePassPartySize,
): PsiElementBounds {
  return {
    setup: valueSlots(sender),
    request: valueSlots(receiver),
  };
}
