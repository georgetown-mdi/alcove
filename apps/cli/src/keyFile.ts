import fs from "node:fs";
import {
  KEY_FILE_SHARED_SECRET_FORMAT_MESSAGE,
  KeyFileSchema,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  MS_PER_DAY,
  NEW_INVITATION_REMEDY,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  rotatedKeyExpires,
  SHARED_SECRET_REGEX,
  serializeKeyFile,
  UsageError,
} from "@alcove/core";

import {
  detectFileConflicts,
  FileExistsError,
  warnIfFileOverPermissive,
  writeFileOwnerOnly,
} from "./fileUtils";
import { decodeAndValidateInvitation } from "./invitationDecode";
import { parseSensitiveJson } from "./sensitiveFile";

import type { KeyFile } from "@alcove/core";

export type { KeyFile } from "@alcove/core";

/**
 * Default path for the key file written by the provisioning commands (`invite`,
 * `accept`, and a zero-setup run with `--save`). Matches the default the
 * `exchange` command reads from, so a key written here is found without an
 * explicit `--key-file`.
 */
export const DEFAULT_KEY_PATH = "./.alcove.key";

/**
 * Load and parse a `.alcove.key` file; returns `undefined` if absent.
 *
 * `warnOnPermissive` (default `true`) emits the over-permissive-file warning. Set
 * it `false` only when re-reading a file already loaded (and warned about) this
 * run -- e.g. the post-exchange expiry re-check -- so the warning is not doubled.
 */
export function loadKeyFile(
  keyFilePath: string,
  opts: { warnOnPermissive?: boolean } = {},
): KeyFile | undefined {
  // Read, then parse through the sensitive-file chokepoint. A read failure (other
  // than ENOENT) propagates its errno -- a path plus code, no file content. The
  // JSON parse can echo a span of the source, and this file holds the shared
  // secret, so it routes through parseSensitiveJson, which reports path-only (see
  // sensitiveFile.ts). The KeyFileSchema error below names the field and its
  // format rule, never the value, so it is left to propagate.
  let source: string;
  try {
    source = fs.readFileSync(keyFilePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const raw = parseSensitiveJson(
    source,
    messageWithOperatorText`key file at ${operatorSuppliedText(keyFilePath)}`,
  );
  const result = KeyFileSchema.parse(raw);
  if (opts.warnOnPermissive !== false)
    warnIfFileOverPermissive(keyFilePath, "shared secret");
  return result;
}

/**
 * Build the `.alcove.key` contents to persist after a successful key exchange.
 * When `tokenMaxAgeDays` is set, `expires` is stamped by core's
 * {@link rotatedKeyExpires}; when omitted, the rotated token holds no
 * `expires`.
 *
 * @throws {UsageError} (exit 64, bad input) when `tokenMaxAgeDays` is one
 *   {@link rotatedKeyExpires} refuses, so a broken expiry never reaches disk.
 */
export function buildRotatedKeyFile(
  rotatedSecret: string,
  tokenMaxAgeDays: number | undefined,
  now: number,
): KeyFile {
  if (tokenMaxAgeDays === undefined) return { sharedSecret: rotatedSecret };
  let expires: string;
  try {
    expires = rotatedKeyExpires(tokenMaxAgeDays, now);
  } catch (err: unknown) {
    if (err instanceof RangeError)
      throw new UsageError(`buildRotatedKeyFile: ${err.message}`);
    throw err;
  }
  return { sharedSecret: rotatedSecret, expires };
}

/** Result of {@link checkKeyFileExpiry}. */
export type KeyFileExpiryStatus = "ok" | "expiring-soon" | "expired";

/**
 * Classify a key file's expiry against the current time. Pure -- a function of
 * the key file and `now` only -- so it is straightforward to unit-test.
 *
 * - `"expired"`: `expires` is set and at or before `now`.
 * - `"expiring-soon"`: `expires` is set, still in the future, and the remaining
 *   time is at most `warnThresholdDays` days. Reachable only when a threshold is
 *   supplied; without one, an unexpired token is always `"ok"`.
 * - `"ok"`: no `expires`, `expires` far enough out, or no threshold given.
 *
 * `warnThresholdDays` is a key-file-agnostic input: the max-age policy
 * (`tokenMaxAgeDays`) is a connection-config concern, so the caller computes the
 * threshold and passes it here rather than this helper knowing the policy field.
 * Absent threshold means the caller cannot determine "expiring soon" (no max-age
 * policy is in force), so only the unconditional `"expired"` hard stop applies.
 */
export function checkKeyFileExpiry(
  keyFile: KeyFile,
  now: number,
  opts: { warnThresholdDays?: number } = {},
): KeyFileExpiryStatus {
  if (keyFile.expires === undefined) return "ok";
  const expiresMs = new Date(keyFile.expires).getTime();
  // Fail closed on an unparseable timestamp: loadKeyFile validates `expires`
  // as an ISO datetime, so this path only reaches a caller that bypasses that
  // validation directly. NaN <= now is false, so an unguarded compare would
  // read a malformed value as "ok"; the hard stop is the default for a
  // security control (see keyFile.test.ts, "checkKeyFileExpiry treats an
  // unparseable expires as expired (fail closed)").
  if (Number.isNaN(expiresMs) || expiresMs <= now) return "expired";
  const { warnThresholdDays } = opts;
  if (
    warnThresholdDays !== undefined &&
    expiresMs - now <= warnThresholdDays * MS_PER_DAY
  )
    return "expiring-soon";
  return "ok";
}

/**
 * Serialize and write a {@link KeyFile} to disk, owner-read-only. Overwrites an
 * existing file by default, as key rotation (`buildRotatedKeyFile` and its
 * callers) requires. Pass `exclusive: true` to instead refuse -- atomically,
 * closing the window a separate existence pre-check would leave open -- when a
 * key file already exists at `keyFilePath`; the caller maps the resulting
 * {@link FileExistsError} to its own user-facing message (see
 * {@link provisionKeyFileFromInvitation}).
 */
export function saveKeyFile(
  keyFilePath: string,
  data: KeyFile,
  options: { exclusive?: boolean } = {},
): void {
  // Belt-and-suspenders runtime validation before the write: the type system
  // does not enforce the base64url format, and a caller other than
  // runProtocol (`invite` / `accept`, via provisionConfigAndKey) can supply a
  // malformed shared secret that loadKeyFile would later reject. UsageError
  // (not a plain Error) so the CLI classifies it as bad input (exit 64)
  // rather than a transport failure (exit 69).
  if (!SHARED_SECRET_REGEX.test(data.sharedSecret))
    throw new UsageError(
      "saveKeyFile: " + KEY_FILE_SHARED_SECRET_FORMAT_MESSAGE,
    );
  writeFileOwnerOnly(keyFilePath, serializeKeyFile(data), options);
}

/**
 * Record in the key file at `keyFilePath` that a key exchange is starting, before
 * it can rotate the secret the file holds. The rotated-secret write
 * ({@link buildRotatedKeyFile}) holds no marker, so the same atomic write that
 * stores the new secret clears it.
 *
 * A marker already present is kept with its first instant: the rotation it
 * records has not completed since. Nothing is written when no key file is at the
 * path, or when it holds a secret other than `sharedSecret` -- the online
 * `invite` and `accept` write their key file only after the handshake, so there
 * is no stored secret to mark.
 *
 * A throw leaves the shared secret unchanged, but not always the file: the
 * write renames into place before it flushes the directory, so a failed flush
 * can leave the marker written.
 */
export function markRotationInFlight(
  keyFilePath: string,
  sharedSecret: string,
  now: number,
): void {
  const current = loadKeyFile(keyFilePath, { warnOnPermissive: false });
  if (current === undefined || current.sharedSecret !== sharedSecret) return;
  if (current.rotationInFlightSince !== undefined) return;
  saveKeyFile(keyFilePath, {
    ...current,
    rotationInFlightSince: new Date(now).toISOString(),
  });
}

/**
 * Remove the rotation-in-flight marker from the key file at `keyFilePath`
 * through the same atomic owner-only write that set it, once the key exchange
 * has failed closed: this side did not rotate, and that failure is the outcome
 * the operator reads. Nothing is written when the file holds no marker or a
 * secret other than `sharedSecret`.
 */
export function clearRotationInFlight(
  keyFilePath: string,
  sharedSecret: string,
): void {
  const current = loadKeyFile(keyFilePath, { warnOnPermissive: false });
  if (current === undefined || current.sharedSecret !== sharedSecret) return;
  if (current.rotationInFlightSince === undefined) return;
  const { rotationInFlightSince: _cleared, ...unmarked } = current;
  saveKeyFile(keyFilePath, unmarked);
}

/**
 * Remove the pending relay registration from the key file at `keyFilePath`
 * once the registrar has confirmed it holds the relay key derived from
 * `sharedSecret`. Nothing is written when the file holds no pending
 * registration or a secret other than `sharedSecret`.
 */
export function clearRelayRegistrationPending(
  keyFilePath: string,
  sharedSecret: string,
): void {
  const current = loadKeyFile(keyFilePath, { warnOnPermissive: false });
  if (current === undefined || current.sharedSecret !== sharedSecret) return;
  if (current.relayRegistrationPendingSince === undefined) return;
  const { relayRegistrationPendingSince: _cleared, ...confirmed } = current;
  saveKeyFile(keyFilePath, confirmed);
}

/**
 * What a run states when its key file holds a rotation-in-flight marker: an
 * earlier key exchange began and did not save its rotated secret, so the partner
 * may hold a secret this file does not. The benign reading rests on the failures
 * it predicts, so it is stated as conditional on them, and an authentication
 * failure keeps the confirm-first step (docs/CLI.md, "Out-of-sync tokens").
 */
export function rotationInFlightNotice(
  keyFilePath: string,
  since: string,
): string {
  return (
    `The key file at ${redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(keyFilePath),
    )} records a key exchange that began at ${since} and did not save its ` +
    "rotated shared secret: a run stopped or failed partway through the key " +
    "exchange, and your partner may have saved a secret this key file does " +
    "not hold. If this run fails authentication or never meets your partner, " +
    "the two of you probably hold different secrets. " +
    `${NEW_INVITATION_REMEDY} It is described under "Out-of-sync tokens" in ` +
    "docs/CLI.md. If neither of you had a run stop partway, confirm with " +
    "your partner over a channel you trust before asking for a new " +
    "invitation."
  );
}

/**
 * The already-provisioned refusal, shared by the pre-check and the write-side
 * guard in {@link provisionKeyFileFromInvitation} so both refuse with the
 * identical message regardless of which one catches the conflict.
 */
function alreadyProvisionedError(keyFilePath: string): UsageError {
  const message = messageWithOperatorText`--invitation cannot provision the key file at ${operatorSuppliedText(
    keyFilePath,
  )} ${ALREADY_PROVISIONED_REMEDY}`;
  return keepOperatorSuppliedText(new UsageError(message.text), message);
}

/** What {@link alreadyProvisionedError} states behind the key file's path. */
const ALREADY_PROVISIONED_REMEDY =
  "because one already exists: it is already provisioned. After the first " +
  "exchange the shared secret rotates, so the original invitation " +
  "can no longer establish a valid key. To re-provision, remove the file. " +
  `${NEW_INVITATION_REMEDY} Or drop --invitation to run with the ` +
  "existing key.";

/**
 * Provision the key file at `keyFilePath` from an invitation code (the same
 * encoded token `alcove accept` takes; `@path`-capable), for the party that
 * composed an exchange in the web app and downloaded a config that never held
 * the secret. The fail-closed ordering (already-provisioned refusal before
 * decode, decode-and-validate before any write, exclusive write closing the
 * check-then-write race) and the expiry contrast with `accept`'s acceptor
 * copy: docs/spec/EXCHANGE_FILE.md, "exchange --invitation fail-closed
 * ordering" and "The secret's path".
 */
export async function provisionKeyFileFromInvitation(
  invitation: string,
  keyFilePath: string,
): Promise<void> {
  if (detectFileConflicts([keyFilePath]).length > 0)
    throw alreadyProvisionedError(keyFilePath);
  const token = await decodeAndValidateInvitation(invitation);
  try {
    saveKeyFile(
      keyFilePath,
      { sharedSecret: token.sharedSecret, expires: token.expires },
      { exclusive: true },
    );
  } catch (err) {
    if (err instanceof FileExistsError)
      throw alreadyProvisionedError(keyFilePath);
    throw err;
  }
}
