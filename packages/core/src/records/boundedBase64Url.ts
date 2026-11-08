import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";

/**
 * The length cap on a base64url crypto value a record file or a partner
 * frame holds: a hash, MAC, salt or nonce is 32 bytes (43 unpadded
 * characters), a coordinate 32 bytes, a signature 64 bytes (86). The cap is
 * far above any of them yet refuses a megabyte-scale hostile string at parse,
 * before any decoding or signature work. It bounds the stored exchange
 * record and verification keys as well as the receipt and certificate a
 * partner sends.
 */
export const MAX_BASE64URL_LENGTH = 256;

/**
 * An unpadded base64url string of at most {@link MAX_BASE64URL_LENGTH} code
 * units. Length-capped, not length-locked: a reader decodes the value and
 * checks its exact byte length there, so no width is pinned here.
 */
export const boundedBase64UrlSchema = z
  .string()
  .check(maxCodeUnits(MAX_BASE64URL_LENGTH))
  .regex(/^[A-Za-z0-9_-]+$/, "must be an unpadded base64url string");
