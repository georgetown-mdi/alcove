import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { writeCanonicalBytes } from "./canonical.js";

/**
 * HMAC-SHA-256 under `key` over the canonical encoding of `value`: the value
 * `hmacSha256(key, canonicalBytes(value))` returns, computed incrementally over
 * {@link writeCanonicalBytes} so the encoding is never held as one string or
 * one byte array, and its length is not bounded by the engine's longest
 * string. For a record commitment or a receipt payload MAC, whose data grows
 * with the exchange.
 *
 * @throws {CanonicalEncodingError} if `value` contains anything outside the
 *   canonical domain.
 */
export function canonicalHmacSha256(
  key: Uint8Array<ArrayBuffer>,
  value: unknown,
): Uint8Array<ArrayBuffer> {
  const mac = hmac.create(sha256, key);
  writeCanonicalBytes(value, (chunk) => mac.update(chunk));
  return mac.digest();
}
