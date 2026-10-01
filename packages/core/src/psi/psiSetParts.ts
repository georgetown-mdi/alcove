// A cascade or count-only round sends each PSI set -- the setup, the request,
// the response -- as one or more parts, each a binary frame within the
// partner's per-frame receive bound, and the receiver joins them before the
// element scan and decode. Every part begins with the same fixed header, so a
// missing, repeated, or inconsistent part is refused from the header alone,
// and the set's declared length is held to a bound derived from the
// authenticated record counts before any buffer for it is allocated
// (docs/spec/PROTOCOL.md, "A PSI set is sent in parts").
import {
  MAX_FRAME_SIZE_BYTES,
  MAX_PSI_DECODE_ELEMENTS,
} from "../connection/frameSize";
import {
  fileSyncMessageFileBytes,
  SPLIT_INPUT_REMEDY,
} from "../connection/fileSyncOutboundBound";
import {
  binaryPackByteStringLength,
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
  webrtcFrameExceedsBound,
} from "../connection/webrtcOutboundBound";
import { ProtocolRefusalError, RoundCapacityError } from "../errors";
import { sendAbort } from "../protocolSetup";
import { receivePsiBinaryFrame } from "./psiBinaryFrame";

import type { MessageConnection } from "../connection/messageConnection";

/**
 * Bytes of the header every part of a PSI set begins with: the part's index
 * and the set's part count, each an unsigned 32-bit integer, then the set's
 * byte length, an unsigned 64-bit integer, all big-endian.
 */
export const PSI_SET_PART_HEADER_BYTES = 16;

const MAX_PART_COUNT = 0xffff_ffff;

/**
 * The most bytes a received PSI set may declare when its message kind may hold
 * at most `elementBound` elements: {@link PSI_ENCODED_ELEMENT_BYTES} per element
 * plus {@link PSI_SET_MAX_FRAMING_BYTES}. The element count is the smaller of
 * `elementBound` and {@link MAX_PSI_DECODE_ELEMENTS}, the two ceilings the
 * element scan applies once the parts are joined.
 */
export function psiSetByteBound(elementBound: number): number {
  return (
    Math.min(elementBound, MAX_PSI_DECODE_ELEMENTS) *
      PSI_ENCODED_ELEMENT_BYTES +
    PSI_SET_MAX_FRAMING_BYTES
  );
}

/**
 * The reason a round puts on the abort it sends the partner in place of a set
 * of this party's own over {@link MAX_PSI_DECODE_ELEMENTS}. A fixed literal,
 * like every abort reason (see `sendAbort`).
 */
export const PSI_SET_TOO_LARGE_ABORT_REASON = "a PSI set is too large to send";

/**
 * The abort reason a party sends when the partner's set for a linkage key is
 * larger than this party can process: at the terms exchange
 * (`checkPartnerRoundCapacity` in exchange.ts) or at the first part of the set
 * ({@link receivePsiSet}). A fixed literal, as every abort reason must be (see
 * `sendAbort`).
 */
export const PARTNER_SET_OVER_CAPACITY_ABORT_REASON =
  "the partner cannot process a set as large as the one you send for a " +
  "linkage key";

/**
 * The refusal a party raises at the first part of a partner's set whose
 * declared length is within what the agreed record counts admit but over the
 * `ceilingElements` values its connection can process.
 */
export function partnerSetOverCeilingMessage(ceilingElements: number): string {
  return (
    "Too large for this browser: your partner's set for this linkage key " +
    `holds more than the ${ceilingElements} values a browser exchange can ` +
    "match, so the exchange stopped before receiving it and told your " +
    "partner. Ask your partner to split their input into smaller files and " +
    "run one exchange for each, or run this exchange with the command-line " +
    "application on a host with enough memory."
  );
}

/**
 * The refusal a round raises, before building the set, on a set of this
 * party's own whose `elementCount` values exceed
 * {@link MAX_PSI_DECODE_ELEMENTS}, the most any receiver admits.
 */
export function ownSetTooLargeMessage(elementCount: number): string {
  return (
    "Too large to send: the set this party sends for this linkage key " +
    `holds ${elementCount} values, over the ${MAX_PSI_DECODE_ELEMENTS} one ` +
    "set can hold, so the exchange stopped before sending it and told your " +
    `partner. ${SPLIT_INPUT_REMEDY}`
  );
}

/**
 * The largest length a frame, envelope included, can have and still pack to a
 * frame a WebRTC receiver bounded at `maxFrameBytes` admits; 0 when none fits.
 */
function largestWebRtcFrameBytes(maxFrameBytes: number): number {
  let admitted = 0;
  let refused = maxFrameBytes + 1;
  while (refused - admitted > 1) {
    const mid = Math.floor((admitted + refused) / 2);
    if (webrtcFrameExceedsBound(binaryPackByteStringLength(mid), maxFrameBytes))
      refused = mid;
    else admitted = mid;
  }
  return admitted;
}

/**
 * How many set bytes one part sent on `conn` holds: the most that fits the
 * per-frame bound the partner's receive path applies, after the part header
 * and the connection's envelope. A WebRTC channel's bound is its partner's
 * frame bound, a file-sync channel's the message-file bound; a connection
 * stating neither is held to {@link MAX_FRAME_SIZE_BYTES}. The one place the
 * part size is chosen.
 */
export function psiSetPartPayloadBytes(conn: MessageConnection): number {
  const envelopeBytes = conn.outboundFrameOverheadBytes?.() ?? 0;
  const frameOverheadBytes = envelopeBytes + PSI_SET_PART_HEADER_BYTES;
  const candidates: Array<number> = [];
  const webRtcBound = conn.outboundWebRtcFrameBound?.();
  if (webRtcBound !== undefined)
    candidates.push(largestWebRtcFrameBytes(webRtcBound) - frameOverheadBytes);
  const fileBound = conn.outboundFileSyncFrameBound?.();
  if (fileBound !== undefined)
    candidates.push(
      fileBound -
        fileSyncMessageFileBytes(PSI_SET_PART_HEADER_BYTES, envelopeBytes),
    );
  if (candidates.length === 0)
    candidates.push(MAX_FRAME_SIZE_BYTES - frameOverheadBytes);
  const payloadBytes = Math.min(...candidates);
  if (payloadBytes < 1)
    throw new Error(
      "the connection's frame bound leaves no room for a PSI set part: " +
        `${payloadBytes} bytes after its header and envelope`,
    );
  return payloadBytes;
}

/**
 * The frames that send `set` in parts of at most `payloadBytes` set bytes
 * each, in order, built one at a time. An empty set is one part with no set
 * bytes.
 */
export function* psiSetParts(
  set: Uint8Array,
  payloadBytes: number,
): Generator<Uint8Array> {
  const count = Math.max(1, Math.ceil(set.byteLength / payloadBytes));
  if (count > MAX_PART_COUNT)
    throw new Error(
      `a PSI set of ${set.byteLength} bytes needs ${count} parts`,
    );
  for (let index = 0; index < count; index++) {
    const payload = set.subarray(
      index * payloadBytes,
      (index + 1) * payloadBytes,
    );
    const part = new Uint8Array(PSI_SET_PART_HEADER_BYTES + payload.byteLength);
    const header = new DataView(part.buffer);
    header.setUint32(0, index);
    header.setUint32(4, count);
    header.setBigUint64(8, BigInt(set.byteLength));
    part.set(payload, PSI_SET_PART_HEADER_BYTES);
    yield part;
  }
}

/** Sends `set` on `conn` in parts sized by {@link psiSetPartPayloadBytes}. */
export async function sendPsiSet(
  conn: MessageConnection,
  set: Uint8Array,
): Promise<void> {
  for (const part of psiSetParts(set, psiSetPartPayloadBytes(conn)))
    await conn.send(part);
}

/**
 * Receives one PSI set sent by {@link sendPsiSet} and returns its bytes,
 * joined. Each part is read as {@link receivePsiBinaryFrame} reads a frame, so
 * a partner's abort in place of any part ends the round as a peer abort. The
 * set's declared length is checked against `maxSetBytes` before a buffer is
 * allocated for it, and each part's header against the part expected next and
 * against the first part's. A part with no set bytes is refused unless it is
 * the only part of an empty set, so a partner cannot hold the receive reading
 * empty parts. Any deviation is a {@link ProtocolRefusalError}.
 *
 * A set whose declared length is within `maxSetBytes` but over
 * `capacity.setBytes` is this party's own limit rather than a deviation: the
 * partner is sent {@link PARTNER_SET_OVER_CAPACITY_ABORT_REASON} and a
 * {@link RoundCapacityError} is raised, before any buffer is allocated.
 *
 * @param what - The set the round awaits, named in every refusal.
 * @param maxSetBytes - The most bytes the set may hold under the protocol
 *   ({@link psiSetByteBound}).
 * @param capacity - This party's own ceiling on the set, when it is under
 *   `maxSetBytes`: its bytes and the element count they are derived from.
 */
export async function receivePsiSet(
  conn: MessageConnection,
  participantId: string,
  what: string,
  maxSetBytes: number,
  capacity?: { readonly setBytes: number; readonly elements: number },
): Promise<Uint8Array> {
  const refuse = (detail: string): ProtocolRefusalError =>
    new ProtocolRefusalError(
      `${participantId} protocol error: inbound PSI ${what} ${detail}`,
    );
  let set: Uint8Array | undefined;
  let count = 1;
  let setBytes = 0;
  let filled = 0;
  for (let expected = 0; expected < count; expected++) {
    const part = await receivePsiBinaryFrame(conn, participantId, what);
    if (part.byteLength < PSI_SET_PART_HEADER_BYTES)
      throw refuse(`part ${expected} is shorter than its header`);
    const header = new DataView(
      part.buffer,
      part.byteOffset,
      PSI_SET_PART_HEADER_BYTES,
    );
    const index = header.getUint32(0);
    const declaredCount = header.getUint32(4);
    const declaredBytes = header.getBigUint64(8);
    if (index < expected) throw refuse(`repeats part ${index}`);
    if (index > expected) throw refuse(`is missing part ${expected}`);
    if (expected === 0) {
      if (declaredBytes > BigInt(maxSetBytes))
        throw refuse(
          `declares ${declaredBytes} bytes, over the ${maxSetBytes} the ` +
            "agreed record counts admit",
        );
      if (capacity !== undefined && declaredBytes > BigInt(capacity.setBytes)) {
        await sendAbort(conn, [PARTNER_SET_OVER_CAPACITY_ABORT_REASON]);
        throw new RoundCapacityError(
          partnerSetOverCeilingMessage(capacity.elements),
          "set-first-part",
        );
      }
      setBytes = Number(declaredBytes);
      count = declaredCount;
      if (count < 1 || count > Math.max(1, setBytes))
        throw refuse(`declares ${count} parts for a set of ${setBytes} bytes`);
      if (count > 1) set = new Uint8Array(setBytes);
    } else if (declaredCount !== count || declaredBytes !== BigInt(setBytes)) {
      throw refuse(`part ${index} declares a different set than part 0`);
    }
    const payload = part.subarray(PSI_SET_PART_HEADER_BYTES);
    if (payload.byteLength === 0 && setBytes > 0)
      throw refuse(`part ${index} holds no set bytes`);
    if (payload.byteLength > setBytes - filled)
      throw refuse(`part ${index} runs past the set's declared length`);
    if (set === undefined) set = payload;
    else set.set(payload, filled);
    filled += payload.byteLength;
  }
  if (filled !== setBytes)
    throw refuse("ends short of the set's declared length");
  return set ?? new Uint8Array(0);
}
