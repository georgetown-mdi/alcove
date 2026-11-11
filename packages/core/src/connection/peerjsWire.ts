import { unpack } from "peerjs-js-binarypack";

import { ConnectionError } from "../errors";
import { encodeBinaryPackValue } from "./binaryPackEncode";
import {
  binaryByteLength,
  binaryBytes,
  inheritsFromBinaryWithoutBeingBinary,
} from "./binaryValue";
import { PEERJS_CHUNK_MTU } from "./webrtcOutboundBound";

/**
 * The PeerJS DataConnection wire, written out rather than obtained by running
 * PeerJS: the CLI drives werift's `RTCPeerConnection` directly and speaks
 * PeerJS-compatible framing on the raw data channel, so a browser PeerJS peer on
 * the other end sees exactly what another PeerJS peer would send
 * (docs/notes/cli-webrtc-stack.md, "The PeerJS wire the CLI speaks").
 *
 * Every shape here was measured against the installed `peerjs` 1.5.5 and
 * `peerjs-js-binarypack` 2.1.0 rather than read off their sources, so each
 * upgrade of either is re-verified against them (docs/spec/WEBRTC_STACK.md). What was
 * measured: the chunk envelope's four keys and their order, the 16,300-byte
 * chunking threshold, the close sentinel's exact object, the
 * truthy-`__peerData` receive dispatch, and the fact that `pack` encodes a
 * `Uint8Array`, an `ArrayBuffer` and a Node `Buffer` to identical bytes. The
 * round-trip tests in test/connection/peerjsWire.test.ts pin those bytes
 * as fixtures, so a bump that moves the encoding fails there rather than at a
 * partner's browser.
 *
 * This module is the framing only. The bounds that make the receive path safe
 * against a hostile peer live beside it in `webrtcInboundBounds.ts`, which is
 * the only thing that should call {@link classifyInboundValue} in production.
 */

/**
 * Byte length past which PeerJS splits a packed message into chunks
 * (`peerjs`'s `util.chunkedMTU`), defined in core beside the send-side frame
 * check that charges for it. Well under the 65,536-byte SCTP message ceiling
 * both peers negotiate, so it is a PeerJS convention rather than a transport
 * limit -- which is exactly why it has to be matched: a browser peer
 * reassembles by this envelope, not by anything SCTP knows about.
 */
export { PEERJS_CHUNK_MTU };

/**
 * The `serialization` value the CLI advertises on its OFFER. Critical rather
 * than a preference: the receiving PeerJS peer selects its DataConnection
 * subclass from this field, and only the `binary` subclass implements the chunk
 * envelope below, so a mismatch is a protocol break
 * (docs/notes/cli-webrtc-stack.md).
 */
export const PEERJS_SERIALIZATION = "binary";

/**
 * First chunk-envelope message id. PeerJS's counter starts at 1, and the receive
 * dispatch keys off `__peerData` being TRUTHY, so an id of 0 would be treated as a
 * plain application frame holding a `__peerData` property. Starting at 1 is
 * therefore part of the wire, not an off-by-one.
 */
const FIRST_MESSAGE_ID = 1;

/** One inbound BinaryPack value, classified by the PeerJS receive dispatch. */
export type InboundValue =
  /** The in-band clean-close sentinel; the peer is done sending. */
  | { kind: "close" }
  /** One slice of a chunked frame, to be reassembled by message id. */
  | {
      kind: "chunk";
      messageId: number;
      index: number;
      total: number;
      data: Uint8Array;
    }
  /** A complete application frame. */
  | { kind: "data"; value: unknown };

/** A frame the peer sent that this side cannot interpret as any wire shape. */
function malformedFrameError(detail: string): ConnectionError {
  return new ConnectionError(
    `the peer sent a malformed WebRTC frame: ${detail}`,
    "protocol",
  );
}

/** What {@link classifyInboundValue} says of a value that inherits from binary
 * data without being binary. The web app's PeerJS wrap refuses the same value
 * in the same words. */
const INHERITS_FROM_BINARY_DETAIL =
  "it decodes to an object that inherits from binary data but is not binary";

/**
 * The refusal of a frame once the encryption layer requires binary frames
 * ({@link admitsBinaryOnlyFrame}). Kind `security`, the class the encryption
 * layer gives a frame that is not binary. It holds no peer-controlled bytes.
 */
export function nonBinaryFrameError(): ConnectionError {
  return new ConnectionError(
    "the peer sent a WebRTC frame that is not binary after the channel was " +
      "encrypted, so it was refused",
    "security",
  );
}

/** Whether `marker` is a BinaryPack binary value's: `fixraw`, `raw16` or
 * `raw32`. */
function isRawMarker(marker: number | undefined): boolean {
  return (
    marker !== undefined &&
    ((marker >= 0xa0 && marker <= 0xaf) || marker === 0xda || marker === 0xdb)
  );
}

/** Where the binary value at `at` ends, or `undefined` if no binary value
 * starts there or it runs past the end. */
function rawEnd(bytes: Uint8Array, at: number): number | undefined {
  const marker = bytes[at];
  if (marker === undefined) return undefined;
  let headerBytes: number;
  let size: number;
  if (marker >= 0xa0 && marker <= 0xaf) {
    headerBytes = 1;
    size = marker & 0x0f;
  } else if (marker === 0xda && at + 3 <= bytes.length) {
    headerBytes = 3;
    size = (bytes[at + 1] << 8) | bytes[at + 2];
  } else if (marker === 0xdb && at + 5 <= bytes.length) {
    headerBytes = 5;
    size =
      ((bytes[at + 1] << 24) >>> 0) +
      ((bytes[at + 2] << 16) | (bytes[at + 3] << 8) | bytes[at + 4]);
  } else {
    return undefined;
  }
  const end = at + headerBytes + size;
  return end <= bytes.length ? end : undefined;
}

/** The bytes after each BinaryPack number marker that is not a fixint. */
const NUMBER_MARKER_WIDTHS: ReadonlyMap<number, number> = new Map([
  [0xca, 4],
  [0xcb, 8],
  [0xcc, 1],
  [0xcd, 2],
  [0xce, 4],
  [0xcf, 8],
  [0xd0, 1],
  [0xd1, 2],
  [0xd2, 4],
  [0xd3, 8],
]);

function numberEnd(bytes: Uint8Array, at: number): number | undefined {
  const marker = bytes[at];
  if (marker === undefined) return undefined;
  if (marker < 0x80 || marker >= 0xe0) return at + 1;
  const width = NUMBER_MARKER_WIDTHS.get(marker);
  if (width === undefined) return undefined;
  const end = at + 1 + width;
  return end <= bytes.length ? end : undefined;
}

/** The four keys of a chunk envelope, as the packer writes each: a `fixstr`. */
const CHUNK_ENVELOPE_KEYS: ReadonlyArray<{
  readonly name: string;
  readonly packed: Uint8Array;
}> = ["__peerData", "n", "data", "total"].map((name) => ({
  name,
  packed: packValue(name),
}));

/** The `fixmap` marker of a map of four entries, the chunk envelope's. */
const FOUR_ENTRY_MAP_MARKER = 0x84;

/** Whether `bytes` are one chunk envelope: a map of the four envelope keys,
 * each once, `data` holding a binary value and the other three a number, and
 * nothing after it. */
function isChunkEnvelopeBytes(bytes: Uint8Array): boolean {
  if (bytes[0] !== FOUR_ENTRY_MAP_MARKER) return false;
  const seen = new Set<string>();
  let at = 1;
  for (let entry = 0; entry < 4; entry += 1) {
    const key = CHUNK_ENVELOPE_KEYS.find(
      ({ packed }) =>
        at + packed.length <= bytes.length &&
        packed.every((byte, offset) => bytes[at + offset] === byte),
    );
    if (key === undefined || seen.has(key.name)) return false;
    seen.add(key.name);
    at += key.packed.length;
    const end = key.name === "data" ? rawEnd(bytes, at) : numberEnd(bytes, at);
    if (end === undefined) return false;
    at = end;
  }
  return at === bytes.length;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Whether `bytes` are a frame a receiver admits once the encryption layer
 * requires binary frames, read off the wire bytes before anything is decoded:
 * a binary value at the root, or, for a datagram rather than a reassembled
 * frame, a chunk envelope holding a binary slice or the close sentinel.
 */
export function admitsBinaryOnlyFrame(
  bytes: Uint8Array,
  position: "datagram" | "reassembled",
): boolean {
  if (isRawMarker(bytes[0])) return true;
  if (position === "reassembled") return false;
  return isChunkEnvelopeBytes(bytes) || sameBytes(bytes, CLOSE_SENTINEL_BYTES);
}

/**
 * Coerce a binary data-channel message to a `Uint8Array` view without
 * copying. werift's `onmessage` delivers a Node `Buffer` for binary, a
 * string for a text-mode peer, and nothing for a zero-length binary message;
 * none is a PeerJS binary frame and each is refused as malformed -- an empty
 * view unpacks to the number `0` (measured), which would otherwise pass as a
 * bogus application frame `0`. A WebRTC data channel has a per-message type,
 * so either shape is possible on the same channel.
 *
 * @throws {ConnectionError} of kind `protocol` on a non-binary or empty datagram.
 */
export function toFrameBytes(data: unknown): Uint8Array {
  const view = binaryBytes(data);
  if (view === undefined) {
    throw malformedFrameError("it is not a binary datagram");
  }
  if (view.byteLength === 0) {
    throw malformedFrameError("it is an empty datagram");
  }
  return view;
}

/**
 * BinaryPack-encode one application value, into the bytes PeerJS's binary
 * DataConnection `_send` puts on the wire before chunking.
 *
 * Core's {@link encodeBinaryPackValue} rather than the library's own `pack`:
 * the library descends one call frame per element and overflows the stack a few
 * thousand matched records in, while the encoder walks the frame with an
 * explicit stack and emits the same bytes (docs/spec/WEBRTC_TRANSPORT.md).
 */
export function packValue(value: unknown): Uint8Array {
  return new Uint8Array(encodeBinaryPackValue(value));
}

/** The PeerJS in-band clean-close sentinel, packed and ready to send. */
export function packCloseSentinel(): Uint8Array {
  return packValue({ __peerData: { type: "close" } });
}

/** The close sentinel's bytes, which every sender packs identically. */
const CLOSE_SENTINEL_BYTES = packCloseSentinel();

/**
 * Split an already-packed frame into the chunk envelopes PeerJS would put on the
 * wire, or return it whole when it is at or under the MTU. The envelope's key
 * order (`__peerData`, `n`, `data`, `total`) matches PeerJS's chunker so the
 * emitted bytes are identical, not merely equivalent.
 */
export function chunkPacked(
  packed: Uint8Array,
  messageId: number,
  chunkMtu: number = PEERJS_CHUNK_MTU,
): Array<Uint8Array> {
  if (packed.byteLength <= chunkMtu) return [packed];
  const total = Math.ceil(packed.byteLength / chunkMtu);
  const chunks: Array<Uint8Array> = [];
  for (let start = 0; start < packed.byteLength; start += chunkMtu) {
    chunks.push(
      packValue({
        __peerData: messageId,
        n: chunks.length,
        data: packed.subarray(
          start,
          Math.min(packed.byteLength, start + chunkMtu),
        ),
        total,
      }),
    );
  }
  return chunks;
}

/**
 * Encodes outbound application frames as the datagrams a PeerJS peer expects.
 * Holds the per-connection chunk message-id counter, so one instance belongs to
 * one data channel: ids only have to be distinct among the reassemblies in
 * flight at once, and a monotonic per-connection counter is the same discipline
 * PeerJS applies per page.
 */
export class PeerJsFrameEncoder {
  private nextMessageId = FIRST_MESSAGE_ID;

  constructor(private readonly chunkMtu: number = PEERJS_CHUNK_MTU) {}

  /** The datagrams for one application frame, in send order. */
  encode(value: unknown): Array<Uint8Array> {
    const packed = packValue(value);
    if (packed.byteLength <= this.chunkMtu) return [packed];
    return chunkPacked(packed, this.nextMessageId++, this.chunkMtu);
  }
}

/** Is `value` a non-array object, the only shape the wire's envelopes take? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A chunk index/count that indexes a real slice: a non-negative safe integer. */
function isChunkOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Classify one already-unpacked inbound value by PeerJS's receive dispatch:
 * a truthy `__peerData` is either the close sentinel or a chunk, and
 * anything else is a complete application frame.
 *
 * The chunk branch validates the envelope's shape (every field is
 * peer-chosen): `total` must be a positive integer, `n` must be in
 * `[0, total)`, and `data` must be bytes. The numeric CAPS (how many
 * chunks, how many bytes, how many reassemblies at once) are not applied
 * here -- they belong to `webrtcInboundBounds.ts`, which owns the memory
 * envelope.
 *
 * A value that inherits from binary data without being binary is refused
 * too: no sender packs one, and a receiver that took it for bytes would throw
 * on reading them.
 *
 * @throws {ConnectionError} of kind `protocol` if the value has a
 *         `__peerData` that is neither the close sentinel nor a well-formed
 *         chunk envelope, or inherits from binary data without being binary.
 */
export function classifyInboundValue(unpacked: unknown): InboundValue {
  if (inheritsFromBinaryWithoutBeingBinary(unpacked)) {
    throw malformedFrameError(INHERITS_FROM_BINARY_DETAIL);
  }
  if (!isPlainObject(unpacked)) return { kind: "data", value: unpacked };
  const peerData = unpacked.__peerData;
  if (!peerData) return { kind: "data", value: unpacked };
  if (isPlainObject(peerData)) {
    if (peerData.type === "close") return { kind: "close" };
    throw malformedFrameError(
      "its __peerData is an object that is not the close sentinel",
    );
  }
  if (typeof peerData !== "number" || !Number.isSafeInteger(peerData)) {
    throw malformedFrameError("its chunk message id is not an integer");
  }
  const { n, total, data } = unpacked;
  if (!isChunkOrdinal(total) || total < 1) {
    throw malformedFrameError("its chunk count is not a positive integer");
  }
  if (!isChunkOrdinal(n) || n >= total) {
    throw malformedFrameError("its chunk index is outside the declared count");
  }
  if (binaryByteLength(data) === undefined) {
    throw malformedFrameError("its chunk payload is not binary");
  }
  return {
    kind: "chunk",
    messageId: peerData,
    index: n,
    total,
    data: toFrameBytes(data),
  };
}

/**
 * BinaryPack-decode one inbound datagram. Kept beside the encoder so both
 * directions name the same library entry points, and so the one cast covering
 * `unpack`'s declared `ArrayBuffer` parameter (it reads any `Uint8Array` view,
 * measured) sits in one place.
 *
 * @throws {ConnectionError} of kind `protocol` on a truncated or malformed body;
 *         `unpack`'s own throw holds a span of peer bytes, so it is replaced
 *         rather than wrapped.
 */
export function unpackFrame(bytes: Uint8Array): unknown {
  try {
    return unpack(bytes as unknown as ArrayBuffer);
  } catch {
    throw malformedFrameError("its BinaryPack body could not be decoded");
  }
}

/**
 * Join a completed reassembly's slices into the packed frame they encode.
 * `parts` is indexed by chunk ordinal and must be dense; the caller
 * (`webrtcInboundBounds.ts`) only calls this once every ordinal has arrived.
 */
export function concatChunks(parts: Array<Uint8Array>): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}
