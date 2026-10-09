/**
 * Maximum size, in bytes, of a single inbound frame the transport reads into
 * memory, and the upper clamp for the single-pass cap below
 * (docs/spec/CHANNEL_SECURITY.md, Inbound frame-size bound). A literal rather than
 * `buffer.constants`, so the AEAD decorator importing it needs no Node `buffer`.
 */
export const MAX_FRAME_SIZE_BYTES = 536_870_888;

/**
 * The most encrypted elements one PSI set may contain. A sender refuses its own
 * set over it before sending any part; a receiver checks an inbound set's declared
 * length and element scan against it before deserialization. Fixed, not configurable
 * (docs/spec/PROTOCOL.md, A PSI set is sent in parts).
 */
export const MAX_PSI_DECODE_ELEMENTS = 2 ** 24;

/**
 * The most elements a browser party accepts in a partner's PSI set: the
 * largest same-size round measured to complete in a browser tab in both PSI
 * roles. Stated as its receive ceiling on the terms exchange. Raise it only
 * from a fresh measurement in both roles (docs/spec/PROTOCOL.md, What a
 * browser tab can match).
 */
export const BROWSER_PSI_SET_MAX_ELEMENTS = 8_388_608;

/**
 * The single-pass dataset ceiling, a per-party budget on value slots
 * (`effectiveKeyCount * recordCount`, not rows). Fixed, not configurable: a
 * configurable maximum reopens the memory-exhaustion denial of service. Raise it
 * only by re-deriving it from a fresh measurement (docs/spec/PROTOCOL.md, The
 * single-pass dataset ceiling: receiver memory and masking compute).
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
 * one-party pre-flight in {@link prepareForExchange}. The two-party gate is
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
  "agree new terms with fewer linkage keys with your partner.";

/**
 * Which side of an exchange breached the single-pass ceiling, named from the point
 * of view of the party asking. See {@link singlePassCeilingBreach}.
 */
export type SinglePassCeilingBreach = "local" | "partner" | "both";

/**
 * Which side breached the single-pass ceiling, from the asking party's view, or
 * `undefined` within it. Computed from authenticated state both parties have, so
 * the two verdicts mirror each other and the abort stays symmetric.
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
 * Call only for an in-cap exchange.
 */
export function singlePassReplyByteCap(
  keyCount: number,
  sender: SinglePassPartySize,
  receiver: SinglePassPartySize,
): number {
  return (
    (SINGLE_PASS_BYTES_PER_MASKED_VALUE + SINGLE_PASS_BYTES_PER_INDEX_WORD) *
      valueSlots(sender) +
    SINGLE_PASS_BYTES_PER_MASKED_VALUE * valueSlots(receiver) +
    SINGLE_PASS_BYTES_PER_INDEX_WORD * keyCount * sender.recordCount +
    SINGLE_PASS_REPLY_OVERHEAD_BYTES
  );
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
