import { FAN_OUT_CANDIDATES_PER_ELEMENT } from "../fanOutFunctions";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_REQUEST_FRAMING_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "./webrtcOutboundBound";

/**
 * Maximum size, in bytes, of a single inbound frame the transport reads into
 * memory, except a single-pass request or reply, which is held to the cap the
 * counts derive for it (docs/spec/TRANSPORT_BOUNDS.md, Inbound frame-size
 * bound). A literal rather than `buffer.constants`, so the AEAD decorator
 * importing it needs no Node `buffer`.
 */
export const MAX_FRAME_SIZE_BYTES = 536_870_888;

/**
 * The most a per-exchange cap raises the file-sync read gate to: the largest
 * exact integer, which is also Node's `buffer.constants.MAX_LENGTH` on a 64-bit
 * host. Nothing in the transport bounds a frame below it; memory is checked
 * before each read, and an encrypted connection holds a frame to the AEAD's
 * own limit.
 */
export const MAX_DERIVED_FRAME_BYTES = Number.MAX_SAFE_INTEGER;

/**
 * The most encrypted elements one PSI set may contain. A sender refuses its own
 * set over it before sending any part; a receiver checks an inbound set's declared
 * length and element scan against it before deserialization. Fixed, not configurable
 * (docs/spec/PROTOCOL.md, A PSI set is sent in parts).
 */
export const MAX_PSI_DECODE_ELEMENTS = 2 ** 24;

/**
 * The largest value of a uint32 field: the single-pass reply states its
 * setup's and its response's lengths and the sender's row count as uint32s.
 */
export const MAX_UINT32 = 0xffff_ffff;

/**
 * The most distinct values one single-pass set holds over file-sync, in place
 * of {@link MAX_PSI_DECODE_ELEMENTS}: the most whose setup, at 35 bytes an
 * element plus its framing, has a length a uint32 holds. A response is 35
 * bytes an element with no framing, so the setup binds first. A sender refuses
 * a set over it before masking any value (docs/spec/PROTOCOL.md, The limits
 * over file-sync).
 */
export const MAX_SINGLE_PASS_SET_ELEMENTS = Math.floor(
  (MAX_UINT32 - PSI_SET_MAX_FRAMING_BYTES) / PSI_ENCODED_ELEMENT_BYTES,
);

/**
 * The most elements a browser party accepts in a partner's PSI set: the
 * largest same-size round measured to complete in a browser tab in both PSI
 * roles. Stated as its receive ceiling on the terms exchange. Raise it only
 * from a fresh measurement in both roles (docs/spec/PROTOCOL.md, What a
 * browser tab can match).
 */
export const BROWSER_PSI_SET_MAX_ELEMENTS = 8_388_608;

/**
 * The single-pass dataset ceiling over WebRTC, a per-party budget on value slots
 * (`effectiveKeyCount * recordCount`, not rows), so the derived reply stays under
 * `MAX_WEBRTC_FRAME_BYTES`. File-sync has no such budget: it has the caps the
 * counts derive for its two frames, the AEAD's limit on one frame,
 * {@link MAX_SINGLE_PASS_SET_ELEMENTS} and the memory checks. Fixed, not
 * configurable: a configurable maximum reopens the memory-exhaustion denial of
 * service. Raise it only by re-deriving it from a fresh measurement
 * (docs/spec/PROTOCOL.md, The single-pass dataset ceiling: receiver memory and
 * masking compute).
 */
export const MAX_SINGLE_PASS_CELLS = 3_000_000;

/**
 * Upper bound on a decoded record count, enforced by `recordCountField` in
 * protocolSetup.ts, so the products in {@link singlePassDatasetExceedsCap} and
 * {@link psiElementBounds} are exact integers by check (docs/spec/PROTOCOL.md, The
 * exact-integer precision of the cell-count gate is a check).
 */
export const MAX_RECORD_COUNT = 1_000_000_000_000;

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
 * Whether one party's own value slots exceed {@link MAX_SINGLE_PASS_CELLS}: the
 * one-party pre-flight in {@link prepareForExchange} on any channel but
 * file-sync, which has no such limit. The two-party gate is
 * {@link singlePassCeilingBreach}.
 */
export function singlePassDatasetExceedsCap(
  effectiveKeyCount: number,
  recordCount: number,
): boolean {
  return effectiveKeyCount * recordCount > MAX_SINGLE_PASS_CELLS;
}

/**
 * The remedy both over-ceiling refusals state, so the pre-flight and the gate
 * cannot differ. The linkage keys are an agreed term, so the remedy names new
 * terms with the partner rather than an edit.
 */
export const SINGLE_PASS_LOCAL_REMEDY =
  "Reduce the record count or split the dataset into smaller batches, or " +
  "agree on new terms with fewer linkage keys with your partner.";

/**
 * Which side of an exchange breached the single-pass ceiling, named from the point
 * of view of the party asking. See {@link singlePassCeilingBreach}.
 */
export type SinglePassCeilingBreach = "local" | "partner" | "both";

/**
 * Which side breached the WebRTC single-pass ceiling, from the asking party's
 * view, or `undefined` within it. Computed from authenticated state both parties
 * have, so the two verdicts mirror each other and the abort stays symmetric.
 */
export function singlePassCeilingBreach(
  local: SinglePassPartySize,
  partner: SinglePassPartySize,
): SinglePassCeilingBreach | undefined {
  const localOver = singlePassDatasetExceedsCap(
    local.effectiveKeyCount,
    local.recordCount,
  );
  const partnerOver = singlePassDatasetExceedsCap(
    partner.effectiveKeyCount,
    partner.recordCount,
  );
  if (localOver && partnerOver) return "both";
  if (localOver) return "local";
  if (partnerOver) return "partner";
  return undefined;
}

/**
 * Whether either party's value slots exceed {@link MAX_SINGLE_PASS_CELLS}. Both
 * parties compute it from authenticated session state alone, never from the
 * inbound file, so they abort in lockstep.
 */
export function singlePassExchangeExceedsCap(
  sender: SinglePassPartySize,
  receiver: SinglePassPartySize,
): boolean {
  return singlePassCeilingBreach(sender, receiver) !== undefined;
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
