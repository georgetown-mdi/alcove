// The send-side half of the WebRTC data-channel frame bound
// (docs/spec/TRANSPORT_BOUNDS.md, "WebRTC data-channel inbound bound"). The PSI
// set part size (psi/psiSetParts.ts) goes through `webrtcFrameExceedsBound`, so
// it agrees with the receivers on where the bound falls.

import {
  MAX_WEBRTC_FRAME_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
} from "./binaryPackBounds";

/**
 * Byte length past which PeerJS splits a packed message into chunks: the
 * pinned `peerjs`'s `util.chunkedMTU` (docs/spec/DEPENDENCY_PINS.md).
 */
export const PEERJS_CHUNK_MTU = 16_300;

/**
 * The most bytes a PeerJS chunk envelope adds around its payload slice: a
 * four-entry map header, the four key strings (`__peerData`, `n`, `data`,
 * `total`), three integers at BinaryPack's widest integer marker (nine bytes
 * each), and the payload's `bin16` header, the widest a slice of at most
 * {@link PEERJS_CHUNK_MTU} bytes takes.
 */
const MAX_PEERJS_CHUNK_ENVELOPE_BYTES = 1 + 11 + 2 + 5 + 6 + 3 * 9 + 3;

/**
 * Bytes one encrypted PSI element takes in a serialized set: a 33-byte
 * compressed curve point plus its protobuf tag and length byte. A set of `n`
 * elements serializes to at least `n` times this (docs/spec/PROTOCOL.md, "The
 * memory ceiling, and the CSV intake cap").
 */
export const PSI_ENCODED_ELEMENT_BYTES = 35;

/**
 * The most bytes a serialized PSI set adds to {@link PSI_ENCODED_ELEMENT_BYTES}
 * per element, reached by a server setup: the tag and length of its element
 * list, a varint of at most 5 bytes under any bound below 2^35 bytes. Measured
 * on the vendored library: a setup of 10^6 values adds 5 and one of 7,669,585
 * or more adds 6, a request adds 2, a response none.
 */
export const PSI_SET_MAX_FRAMING_BYTES = 6;

/**
 * Length of the BinaryPack frame a byte array of `payloadBytes` bytes packs
 * to: the payload plus the `fixraw`, `bin16`, or `bin32` header its length
 * selects.
 */
export function binaryPackByteStringLength(payloadBytes: number): number {
  if (payloadBytes <= 0x0f) return payloadBytes + 1;
  if (payloadBytes <= 0xffff) return payloadBytes + 3;
  return payloadBytes + 5;
}

/**
 * The most bytes a WebRTC receiver charges against its frame bound for one
 * packed frame of `packedFrameBytes` bytes. A chunked frame is charged per
 * chunk, each at least {@link MIN_CHUNK_RESIDENT_BYTES} and with the widest
 * envelope added, an upper bound for both receivers: the web app counts chunk
 * payloads, the CLI whole datagrams.
 */
export function webrtcFrameReceiveCharge(packedFrameBytes: number): number {
  if (packedFrameBytes <= PEERJS_CHUNK_MTU) return packedFrameBytes;
  const chunks = Math.ceil(packedFrameBytes / PEERJS_CHUNK_MTU);
  const lastSlice = packedFrameBytes - (chunks - 1) * PEERJS_CHUNK_MTU;
  const chargeFor = (slice: number): number =>
    Math.max(slice + MAX_PEERJS_CHUNK_ENVELOPE_BYTES, MIN_CHUNK_RESIDENT_BYTES);
  return (chunks - 1) * chargeFor(PEERJS_CHUNK_MTU) + chargeFor(lastSlice);
}

/**
 * Whether the partner's WebRTC receive path could refuse a packed frame of
 * `packedFrameBytes` bytes. Every sender-side refusal of this bound applies it.
 *
 * @param maxFrameBytes - The receiver's bound, {@link MAX_WEBRTC_FRAME_BYTES}
 *   unless a test lowers it.
 */
export function webrtcFrameExceedsBound(
  packedFrameBytes: number,
  maxFrameBytes: number = MAX_WEBRTC_FRAME_BYTES,
): boolean {
  return webrtcFrameReceiveCharge(packedFrameBytes) > maxFrameBytes;
}
