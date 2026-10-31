/**
 * The `.alcove.key` file: one schema and one serializer every application that
 * reads or writes the file uses.
 */

import { z } from "zod";

import { MS_PER_DAY } from "../utils/msPerDay";
import { NEW_INVITATION_REMEDY } from "../auth";
import { SHARED_SECRET_REGEX } from "./connection";
import {
  newerFormatMemberMessage,
  newerFormatVersionMessage,
} from "./formatVersion";
import type { RotationHistoryEntry } from "../rotationHistory";

/**
 * The key file format version this build reads and writes: the file's
 * `version` field, which {@link serializeKeyFile} always writes and
 * {@link KeyFileSchema} reads as 1 when absent.
 */
export const KEY_FILE_FORMAT_VERSION = 1;

/**
 * Contents of a `.alcove.key` file, less its `version`, which only the
 * schema and the serializer handle.
 */
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
  /**
   * The secret a rotation this side stored as initiator replaced, kept until
   * the partner's frame shows it stored the same next secret, so a run cut
   * between the two stores heals at the next run.
   */
  previousSharedSecret?: string;
  /** The `expires` {@link previousSharedSecret} had as the current secret. */
  previousExpires?: string;
  /** The verifiers of the secrets this file retired, newest first. */
  rotationHistory?: RotationHistoryEntry[];
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
      KEY_FILE_SHARED_SECRET_FORMAT_MESSAGE + `. ${NEW_INVITATION_REMEDY}`,
    ),
  expires: z.iso.datetime().optional(),
  rotationInFlightSince: z.iso.datetime().optional(),
  relayRegistrationPendingSince: z.iso.datetime().optional(),
  previousSharedSecret: z
    .string()
    .regex(
      SHARED_SECRET_REGEX,
      "previousSharedSecret must be a base64url-encoded 32-byte value",
    )
    .optional(),
  previousExpires: z.iso.datetime().optional(),
  rotationHistory: z
    .array(
      z
        .object({
          verifier: z
            .string()
            .regex(
              SHARED_SECRET_REGEX,
              "each rotationHistory verifier must be a base64url-encoded " +
                "32-byte value",
            ),
          expires: z.iso.datetime().optional(),
        })
        .strict(),
    )
    .optional(),
} as const;

const KEY_FILE_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(KEY_FILE_FIELD_SCHEMAS),
);

/** Stands in for an unread field whose name may hold a shared secret. */
export const KEY_FILE_REDACTED_FIELD_NAME = "<redacted>";

const SECRET_SHAPED_RUN = /[A-Za-z0-9_-]{32,}/;

const KEY_FILE_NEWER_REMEDY =
  "Use the version of Alcove that wrote the key file, or a newer one.";

function keyFileFieldNameForDisplay(name: string): string {
  return SECRET_SHAPED_RUN.test(name) ? KEY_FILE_REDACTED_FIELD_NAME : name;
}

const KeyFileVersionSchema = z.looseObject({
  version: z
    .int()
    .min(1)
    .max(KEY_FILE_FORMAT_VERSION, {
      error: (issue) =>
        newerFormatVersionMessage(
          "The key file",
          Number(issue.input),
          KEY_FILE_FORMAT_VERSION,
          KEY_FILE_NEWER_REMEDY,
        ),
    })
    .optional(),
});

const KeyFileFieldsSchema = z.looseObject({
  version: z.unknown().optional(),
  ...KEY_FILE_FIELD_SCHEMAS,
});

/** A refusal of members a newer Alcove wrote, named through the display rule. */
function newerKeyFileMembersIssue(
  path: ReadonlyArray<PropertyKey>,
  names: ReadonlyArray<string>,
): z.core.$ZodIssue {
  return {
    code: "custom",
    path: [...path],
    message: newerFormatMemberMessage(
      "The key file",
      names.map(keyFileFieldNameForDisplay),
      KEY_FILE_NEWER_REMEDY,
    ),
  };
}

/**
 * The key file's validator. A field outside {@link KeyFile} and `version`, at
 * the top level or inside a rotation history entry, and a version above
 * {@link KEY_FILE_FORMAT_VERSION}, is refused as written by a newer Alcove;
 * the refusal names the field through the display rule and never a value. The
 * version is checked first, so a newer file is refused by its version alone,
 * and a file with an unknown field by that refusal alone, not beside field
 * errors whose remedy differs. The unknown fields are read
 * from the input's own keys, so a member Zod's output would absorb, such as
 * `__proto__`, is refused too. The result holds the {@link KeyFile} fields,
 * without `version`.
 */
export const KeyFileSchema: z.ZodType<KeyFile, unknown> = z
  .unknown()
  .transform((raw, ctx): KeyFile => {
    const refuse = (issues: ReadonlyArray<z.core.$ZodIssue>): KeyFile => {
      for (const issue of issues)
        ctx.issues.push({ ...issue, input: undefined });
      return z.NEVER;
    };
    const version = KeyFileVersionSchema.safeParse(raw);
    if (!version.success) return refuse(version.error.issues);
    const unknown = Object.keys(raw as object).filter(
      (name) => name !== "version" && !KEY_FILE_FIELD_NAMES.has(name),
    );
    const fields = KeyFileFieldsSchema.safeParse(raw);
    const fieldIssues = fields.success ? [] : fields.error.issues;
    const newerMembers = fieldIssues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? [newerKeyFileMembersIssue(issue.path, issue.keys)]
        : [],
    );
    if (unknown.length > 0)
      newerMembers.push(newerKeyFileMembersIssue([], unknown));
    if (newerMembers.length > 0) return refuse(newerMembers);
    if (!fields.success) return refuse(fieldIssues);
    const { version: _version, ...known } = fields.data;
    return known as KeyFile;
  });

/**
 * The names of the top-level fields of a parsed key file that a reader keeping
 * only `keptFields` does not read, in the file's order, for it to name to the
 * operator; `version` counts as read. Returns names only: a value may be the
 * secret. A name containing a run of 32 or more base64url characters, which
 * may be all or most of a secret, is replaced by
 * {@link KEY_FILE_REDACTED_FIELD_NAME}. Empty for anything other than a plain
 * object.
 */
export function keyFileUnreadFieldNames(
  document: unknown,
  keptFields: ReadonlySet<string> = KEY_FILE_FIELD_NAMES,
): Array<string> {
  if (typeof document !== "object" || document === null) return [];
  if (Array.isArray(document)) return [];
  return Object.keys(document)
    .filter((name) => name !== "version" && !keptFields.has(name))
    .map(keyFileFieldNameForDisplay);
}

/**
 * The bytes of a `.alcove.key` holding `data`: pretty-printed JSON with a
 * trailing newline, the format version first, holding only the
 * {@link KeyFile} fields `data` sets. Validates nothing; a writer checks the
 * secret's shape itself.
 */
export function serializeKeyFile(data: KeyFile): string {
  const known = Object.fromEntries(
    Object.entries(data).filter(([name]) => KEY_FILE_FIELD_NAMES.has(name)),
  );
  return (
    JSON.stringify({ version: KEY_FILE_FORMAT_VERSION, ...known }, null, 2) +
    "\n"
  );
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
