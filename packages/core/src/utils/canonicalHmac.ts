import { writeCanonicalBytes } from "./canonical.js";
import { hmacSha256 } from "./crypto.js";

const INITIAL_CAPACITY = 1 << 12;

/**
 * The bytes `canonicalBytes(value)` returns, built from
 * {@link writeCanonicalBytes}'s chunks without first holding the encoding as
 * one string, whose length the engine caps. The returned view may sit at the
 * start of a larger buffer.
 *
 * @throws {CanonicalEncodingError} if `value` contains anything outside the
 *   canonical domain.
 */
export function canonicalBytesPastStringCap(
  value: unknown,
): Uint8Array<ArrayBuffer> {
  let buffer = new Uint8Array(INITIAL_CAPACITY);
  let length = 0;
  writeCanonicalBytes(value, (chunk) => {
    const needed = length + chunk.length;
    if (needed > buffer.length) {
      let capacity = buffer.length * 2;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(chunk, length);
    length = needed;
  });
  return buffer.subarray(0, length);
}

/**
 * Equals `hmacSha256(key, canonicalBytes(value))`, for a value whose encoding
 * may be longer than the engine's longest string: a record commitment or a
 * receipt payload MAC, whose data grows with the exchange.
 *
 * @throws {CanonicalEncodingError} if `value` contains anything outside the
 *   canonical domain.
 */
export async function canonicalHmacSha256(
  key: Uint8Array<ArrayBuffer>,
  value: unknown,
): Promise<Uint8Array<ArrayBuffer>> {
  return hmacSha256(key, canonicalBytesPastStringCap(value));
}
