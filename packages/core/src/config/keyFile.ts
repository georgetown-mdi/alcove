/**
 * The `.alcove.key` file: one schema and one serializer every application that
 * reads or writes the file uses.
 */

import { z } from "zod";

import { MS_PER_DAY } from "../utils/msPerDay";
import { SHARED_SECRET_REGEX } from "./connection";

/** Contents of a `.alcove.key` file. */
export interface KeyFile {
  /** Shared secret; injected into the connection config at runtime. */
  sharedSecret: string;
  /** ISO 8601 datetime after which the shared secret should be considered expired. */
  expires?: string;
  /**
   * ISO 8601 datetime a key exchange began at that has not yet saved its rotated
   * secret. Written just before the key exchange starts and dropped by the write
   * that stores the rotated secret, so a file still holding it at the next run
   * records a rotation that may have completed on the partner's side only.
   */
  rotationInFlightSince?: string;
  /**
   * ISO 8601 datetime the secret this file holds was rotated to, when a relay
   * registrar has not yet confirmed that it holds the relay key derived from
   * that secret. Written by the rotation itself and dropped once the registrar
   * confirms, so a file still holding it at the next run records a
   * registration that run retries before it dials.
   */
  relayRegistrationPendingSince?: string;
}

/** The rule a key file's `sharedSecret` is held to, stated without its value. */
export const KEY_FILE_SHARED_SECRET_FORMAT_MESSAGE =
  "sharedSecret must be a base64url-encoded 32-byte value (43 base64url " +
  "characters; final character must be in [AEIMQUYcgkosw048])";

/**
 * Each key-file field's own schema, for a document that embeds some of the
 * fields under a stricter policy of its own.
 */
export const KEY_FILE_FIELD_SCHEMAS = {
  sharedSecret: z
    .string()
    .regex(
      SHARED_SECRET_REGEX,
      KEY_FILE_SHARED_SECRET_FORMAT_MESSAGE +
        ". Ask your partner for a new invitation, or create one with " +
        "'alcove invite' and have your partner accept it",
    ),
  expires: z.iso.datetime().optional(),
  rotationInFlightSince: z.iso.datetime().optional(),
  relayRegistrationPendingSince: z.iso.datetime().optional(),
} as const;

/** The key file's validator. A field outside {@link KeyFile} is dropped. */
export const KeyFileSchema: z.ZodType<KeyFile> = z.object(
  KEY_FILE_FIELD_SCHEMAS,
);

const KEY_FILE_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(KEY_FILE_FIELD_SCHEMAS),
);

/** Stands in for an unread field whose name may hold a shared secret. */
export const KEY_FILE_REDACTED_FIELD_NAME = "<redacted>";

const SECRET_SHAPED_RUN = /[A-Za-z0-9_-]{32,}/;

/**
 * The names of the top-level fields of a parsed key file that
 * {@link KeyFileSchema} does not read and so drops, in the file's order, for a
 * reader to name to the operator. Returns names only: a value may be the
 * secret. A name containing a run of 32 or more base64url characters, which
 * may be all or most of a secret, is replaced by
 * {@link KEY_FILE_REDACTED_FIELD_NAME}. Empty for anything other than a plain
 * object.
 */
export function keyFileUnreadFieldNames(document: unknown): Array<string> {
  if (typeof document !== "object" || document === null) return [];
  if (Array.isArray(document)) return [];
  return Object.keys(document)
    .filter((name) => !KEY_FILE_FIELD_NAMES.has(name))
    .map((name) =>
      SECRET_SHAPED_RUN.test(name) ? KEY_FILE_REDACTED_FIELD_NAME : name,
    );
}

/**
 * The bytes of a `.alcove.key` holding `data`: pretty-printed JSON with a
 * trailing newline, holding only the {@link KeyFile} fields `data` sets.
 * Validates nothing; a writer checks the secret's shape itself.
 */
export function serializeKeyFile(data: KeyFile): string {
  const known = Object.fromEntries(
    Object.entries(data).filter(([name]) => KEY_FILE_FIELD_NAMES.has(name)),
  );
  return JSON.stringify(known, null, 2) + "\n";
}

/**
 * The `expires` a rotated shared secret takes under a `tokenMaxAgeDays` policy:
 * `now` plus that many days, as an ISO 8601 UTC instant, so the rotated secret
 * cannot outlive the policy. `now` is a parameter so the stamp is the moment
 * of rotation the caller observed.
 *
 * The config schemas bound `tokenMaxAgeDays` at parse; this refuses a caller
 * that bypassed them, before a broken expiry reaches storage.
 *
 * @throws {RangeError} if `tokenMaxAgeDays` is not a positive integer (a zero
 *   or negative age would stamp an already-expired secret, a fraction a
 *   sub-day bound), or if the computed expiry is outside the range an ISO
 *   8601 string with a four-digit year can state.
 */
export function rotatedKeyExpires(
  tokenMaxAgeDays: number,
  now: number,
): string {
  if (!Number.isInteger(tokenMaxAgeDays) || tokenMaxAgeDays <= 0)
    throw new RangeError(
      "tokenMaxAgeDays must be a positive integer; got " +
        String(tokenMaxAgeDays),
    );
  const expires = new Date(now + tokenMaxAgeDays * MS_PER_DAY);
  if (Number.isNaN(expires.getTime()) || expires.getUTCFullYear() > 9999)
    throw new RangeError(
      "tokenMaxAgeDays is too large; the computed expiry is outside the " +
        "supported date range",
    );
  return expires.toISOString();
}
