// The file-sync message envelope, `version || type || seq || payload`:
//
//   byte 0      MESSAGE_ENVELOPE_VERSION
//   byte 1      MESSAGE_TYPE_OBJECT (UTF-8 JSON) or MESSAGE_TYPE_BINARY (raw)
//   bytes 2..9  per-session sequence number, 8-byte big-endian
//   bytes 10..  payload, never converted to a string
//
// See docs/spec/FILE_SYNC.md#file-taxonomy.
//
// MESSAGE_ENVELOPE_VERSION is byte 0 of each party's first message file, the
// one that holds its version hello, and stays 1 permanently so a reader of any
// version reads that frame; later frames hold the version the key exchange
// negotiated (envelopeVersionForFrame).
/** @internal */
export const MESSAGE_ENVELOPE_VERSION = 1;

/**
 * The envelope version of a message file: {@link MESSAGE_ENVELOPE_VERSION} for
 * a party's first, and the negotiated version for each later one where the
 * key exchange negotiated one.
 *
 * @internal exported for the envelope-version test.
 */
export function envelopeVersionForFrame(
  firstFrame: boolean,
  negotiated: number | undefined,
): number {
  return firstFrame
    ? MESSAGE_ENVELOPE_VERSION
    : (negotiated ?? MESSAGE_ENVELOPE_VERSION);
}
/** @internal */
export const MESSAGE_TYPE_OBJECT = 0;
/** @internal */
export const MESSAGE_TYPE_BINARY = 1;
/** @internal */
export const MESSAGE_HEADER_BYTES = 10;

export const messageTypeLabel = (type: number): string =>
  type === MESSAGE_TYPE_BINARY ? "Uint8Array" : "Object";

// Assigns every header byte, so an allocUnsafe target leaks none.
const writeMessageHeader = (
  out: Buffer,
  type: number,
  seq: number,
  version: number,
): void => {
  out[0] = version;
  out[1] = type;
  out.writeBigUInt64BE(BigInt(seq), 2);
};

/**
 * Serialize only the envelope header. The send path writes it and the payload
 * as two chunks, so the payload is never copied to prepend it.
 *
 * @internal exported for the file-sync transport tests.
 */
export function serializeFileSyncMessageHeader(
  type: number,
  seq: number,
  version: number = MESSAGE_ENVELOPE_VERSION,
): Buffer {
  const header = Buffer.allocUnsafe(MESSAGE_HEADER_BYTES);
  writeMessageHeader(header, type, seq, version);
  return header;
}

/**
 * Serialize a whole message file's bytes, for tests that inject one; the send
 * path uses {@link serializeFileSyncMessageHeader}.
 *
 * @internal exported for the file-sync transport tests.
 */
export function serializeFileSyncMessage(
  type: number,
  seq: number,
  payload: Uint8Array,
): Buffer {
  const out = Buffer.allocUnsafe(MESSAGE_HEADER_BYTES + payload.length);
  writeMessageHeader(out, type, seq, MESSAGE_ENVELOPE_VERSION);
  out.set(payload, MESSAGE_HEADER_BYTES);
  return out;
}

export interface DeserializedMessage {
  type: number;
  seq: number;
  // A view onto the source buffer, not a copy.
  payload: Uint8Array;
}

/**
 * Byte 0 is not the envelope version the frame should hold: most likely a
 * partner on an incompatible Alcove version, which the read path reports.
 */
export class IncompatibleEnvelopeVersionError extends Error {
  constructor(
    readonly foundVersion: number,
    readonly expectedVersion: number,
  ) {
    super(`unsupported message envelope version ${foundVersion}`);
    this.name = "IncompatibleEnvelopeVersionError";
  }
}

/**
 * Parse a message file's bytes into its envelope fields, throwing on any
 * structural failure. The payload is not decoded, so a frame past Node's
 * maximum string length can be read.
 */
export function deserializeFileSyncMessage(
  raw: Uint8Array,
  expectedVersion: number = MESSAGE_ENVELOPE_VERSION,
): DeserializedMessage {
  if (raw.length > 0 && raw[0] !== expectedVersion)
    throw new IncompatibleEnvelopeVersionError(raw[0], expectedVersion);
  if (raw.length < MESSAGE_HEADER_BYTES)
    throw new Error("message envelope is shorter than its header");
  const type = raw[1];
  if (type !== MESSAGE_TYPE_OBJECT && type !== MESSAGE_TYPE_BINARY)
    throw new Error(`unknown message payload type ${type}`);
  // Compared as a BigInt before narrowing, since Number() loses precision
  // above MAX_SAFE_INTEGER.
  const seqBig = new DataView(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength,
  ).getBigUint64(2, false);
  if (seqBig > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("message envelope sequence number exceeds safe range");
  const seq = Number(seqBig);
  return { type, seq, payload: raw.subarray(MESSAGE_HEADER_BYTES) };
}
