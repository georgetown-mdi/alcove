// Envelope version 2, the chunked AEAD envelope: the layout, nonce and
// additional data of docs/spec/CHANNEL_SECURITY.md, "The chunked envelope,
// version 2".
//
//   version (1) || seq (8, big-endian) || chunk_0 || ... || chunk_(n-1)
//   chunk_k = AES-256-GCM(IV_k, AAD_k) of plaintext bytes [k*C, (k+1)*C)

/** Envelope version 2's plaintext bytes in each chunk but the last. */
export const AEAD_CHUNK_PLAINTEXT_BYTES = 16_777_216;

/** The GCM tag ending each chunk. */
export const AEAD_TAG_BYTES = 16;

/** The version byte and the 8-byte sequence number ahead of the chunks. */
export const CHUNKED_ENVELOPE_HEADER_BYTES = 1 + 8;

/** The shortest chunk: one plaintext byte and the tag. */
const MIN_CHUNK_BYTES = 1 + AEAD_TAG_BYTES;

/** The chunks a plaintext of `plaintextBytes` (type tag included) takes. */
export function chunkCount(plaintextBytes: number, chunkBytes: number): number {
  return Math.max(1, Math.ceil(plaintextBytes / chunkBytes));
}

/** The envelope length of a plaintext of `plaintextBytes`, type tag included. */
export function chunkedEnvelopeBytes(
  plaintextBytes: number,
  chunkBytes: number,
): number {
  return (
    CHUNKED_ENVELOPE_HEADER_BYTES +
    plaintextBytes +
    AEAD_TAG_BYTES * chunkCount(plaintextBytes, chunkBytes)
  );
}

/** Chunk `index`'s IV: the index, then the frame's sequence number. */
export function chunkIv(seq: number, index: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
  const view = new DataView(iv.buffer);
  view.setUint32(0, index, false);
  view.setBigUint64(4, BigInt(seq), false);
  return iv;
}

/** Chunk `index`'s additional data: version, sequence number, index, final flag. */
export function chunkAdditionalData(
  version: number,
  seq: number,
  index: number,
  final: boolean,
): Uint8Array<ArrayBuffer> {
  const aad = new Uint8Array(14) as Uint8Array<ArrayBuffer>;
  const view = new DataView(aad.buffer);
  aad[0] = version;
  view.setBigUint64(1, BigInt(seq), false);
  view.setUint32(9, index, false);
  aad[13] = final ? 1 : 0;
  return aad;
}

/**
 * The chunk layout of an envelope `envelopeBytes` long, or undefined for a
 * length no sender writes: shorter than one chunk of one byte, or ending in a
 * chunk shorter than that.
 */
export function chunkLayout(
  envelopeBytes: number,
  chunkBytes: number,
): { chunks: number; plaintextBytes: number } | undefined {
  const body = envelopeBytes - CHUNKED_ENVELOPE_HEADER_BYTES;
  if (body < MIN_CHUNK_BYTES) return undefined;
  const stride = chunkBytes + AEAD_TAG_BYTES;
  const chunks = Math.ceil(body / stride);
  if (body - (chunks - 1) * stride < MIN_CHUNK_BYTES) return undefined;
  return { chunks, plaintextBytes: body - AEAD_TAG_BYTES * chunks };
}

/**
 * Encrypts `typeTag || payload` into a version-2 envelope for frame `seq`,
 * chunk by chunk from `payload`, so the plaintext is never copied whole.
 * Rejects with the runtime's error where an encryption fails.
 */
export async function encryptChunked(
  key: CryptoKey,
  version: number,
  seq: number,
  typeTag: number,
  payload: Uint8Array,
  chunkBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintextBytes = 1 + payload.length;
  const chunks = chunkCount(plaintextBytes, chunkBytes);
  const envelope = new Uint8Array(
    chunkedEnvelopeBytes(plaintextBytes, chunkBytes),
  ) as Uint8Array<ArrayBuffer>;
  envelope[0] = version;
  new DataView(envelope.buffer).setBigUint64(1, BigInt(seq), false);
  let out = CHUNKED_ENVELOPE_HEADER_BYTES;
  for (let index = 0; index < chunks; index++) {
    const start = index * chunkBytes;
    const end = Math.min(plaintextBytes, start + chunkBytes);
    let chunk: Uint8Array;
    if (index === 0) {
      const first = new Uint8Array(end);
      first[0] = typeTag;
      first.set(payload.subarray(0, end - 1), 1);
      chunk = first;
    } else chunk = payload.subarray(start - 1, end - 1);
    const encryptedChunk = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: chunkIv(seq, index),
          additionalData: chunkAdditionalData(
            version,
            seq,
            index,
            index === chunks - 1,
          ),
        },
        key,
        chunk as Uint8Array<ArrayBuffer>,
      ),
    );
    envelope.set(encryptedChunk, out);
    out += encryptedChunk.length;
  }
  return envelope;
}

/**
 * Decrypts version-2 `envelope` of frame `seq` in place, chunk by chunk, each
 * chunk's plaintext written over the envelope's own bytes ahead of the chunks
 * still to decrypt. Returns the plaintext, `typeTag || payload`, as a view of
 * `envelope` once the final chunk verifies; returns undefined on a length no
 * sender writes or a chunk whose tag fails, with any plaintext already
 * written overwritten with zeros.
 */
export async function decryptChunkedInPlace(
  key: CryptoKey,
  envelope: Uint8Array<ArrayBuffer>,
  seq: number,
  chunkBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const layout = chunkLayout(envelope.length, chunkBytes);
  if (layout === undefined) return undefined;
  const version = envelope[0]!;
  const stride = chunkBytes + AEAD_TAG_BYTES;
  const plainStart = CHUNKED_ENVELOPE_HEADER_BYTES;
  let written = 0;
  for (let index = 0; index < layout.chunks; index++) {
    const from = plainStart + index * stride;
    const to = Math.min(envelope.length, from + stride);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: chunkIv(seq, index),
          additionalData: chunkAdditionalData(
            version,
            seq,
            index,
            index === layout.chunks - 1,
          ),
        },
        key,
        envelope.subarray(from, to),
      );
    } catch {
      envelope.fill(0, plainStart, plainStart + written);
      return undefined;
    }
    envelope.set(new Uint8Array(plain), plainStart + written);
    written += plain.byteLength;
  }
  return envelope.subarray(plainStart, plainStart + written);
}
