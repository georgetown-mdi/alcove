import { sftpUrlDirectoryFault } from "@alcove/core";

/*
 * The fixed tokens a `POST /api/jobs` refusal states in its body, so the browser
 * can show copy the operator can act on.
 *
 * Other create rejections hold no reason token: a busy slot answers with the
 * running exchange's id, a refused composition with `{ error }`, and the rest
 * with an empty body. These are about CONSOLE state the intent does not
 * state -- its mounts, its saved connection -- so the server names the
 * refusal, and only the refusal. A token is an enumerated word, never
 * a path, a mount name, or a message: the copy it selects lives in the console's
 * own copy layer (`failureFor` in `@exchange/useInviterExchange`).
 */

/** The token for a filedrop run refused because a shared folder holds
 * this party's signing identity. */
export const SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL =
  "signing-identity-in-rendezvous";

/** The token for a direct (zero-setup) sftp run refused because the saved
 * connection pins more than one host-key fingerprint, which the run cannot
 * pass on. */
export const SFTP_FINGERPRINT_LIST_REFUSAL = "sftp-fingerprint-list";

/** The token for a direct (zero-setup) sftp run refused because the saved
 * connection's remote directory is `/` or has a `.` or `..` segment, which
 * the run's `sftp://` URL cannot state. */
export const SFTP_URL_DIRECTORY_REFUSAL = "sftp-url-directory";

/** The token for a run of the opened configuration refused because the
 * working folder holds no `.alcove.key` beside it. */
export const MOUNTED_KEY_FILE_ABSENT_REFUSAL = "mounted-key-file-absent";

/** The token for a run of the opened configuration refused because the
 * `.alcove.key` beside it cannot be read as a key file. */
export const MOUNTED_KEY_FILE_INVALID_REFUSAL = "mounted-key-file-invalid";

/** The token for a run of the opened configuration refused because a newer
 * Alcove wrote the `.alcove.key` beside it. */
export const MOUNTED_KEY_FILE_NEWER_REFUSAL = "mounted-key-file-newer";

/** The token for a signed run of the opened configuration refused because
 * that configuration states signing paths of its own and the operator did not
 * convert it to the console's. */
export const MOUNTED_SIGNING_PATHS_UNCONVERTED_REFUSAL =
  "mounted-signing-paths-unconverted";

/** The token for a signed webrtc run of the opened configuration refused
 * because the file it runs in place signs with an identity file other than
 * the console's. */
export const MOUNTED_SIGNING_IDENTITY_MISMATCH_REFUSAL =
  "mounted-signing-identity-mismatch";

/** The token for a webrtc run of the opened configuration refused because the
 * working folder's `alcove.yaml` is no longer one the console runs in place:
 * gone, one the console cannot open, or another channel. */
export const OPENED_CONFIGURATION_NOT_RUNNABLE_REFUSAL =
  "opened-configuration-not-runnable";

/** The token for an sftp run refused because a credential file of the saved
 * connection is one of the console's own files. */
export const SFTP_CREDENTIAL_CONSOLE_FILE_REFUSAL =
  "sftp-credential-console-file";

/** The token for a webrtc run refused because the working folder already
 * holds an `alcove.yaml` or `.alcove.key`, which the run would write when it
 * starts. */
export const WORKING_FOLDER_CONFIGURATION_PRESENT_REFUSAL =
  "working-folder-configuration-present";

/** The token for a webrtc run refused because the working folder holds the
 * `alcove.yaml` and `.alcove.key` an earlier exchange on this console wrote,
 * and the run is not a retry of that exchange's invitation. */
export const WORKING_FOLDER_CONSOLE_EXCHANGE_REFUSAL =
  "working-folder-console-exchange";

/** The token for a webrtc run that could not start because the working
 * folder refused the write of its `alcove.yaml` and `.alcove.key`. The one
 * token on a `500` rather than a `400`. */
export const WORKING_FOLDER_UNWRITABLE_REFUSAL = "working-folder-unwritable";

/** The token for a webrtc run refused because its invitation names a
 * coordination server other than the one the console holds. */
export const COORDINATION_SERVER_CHANGED_REFUSAL =
  "coordination-server-changed";

/** Every refusal token a create rejection can name. The union, the allowlist
 * over a rejection's body, and the browser's copy table all derive from it, so
 * a token added here does not compile until that table gives it copy. */
const JOB_CREATE_REFUSAL_REASONS = [
  SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL,
  SFTP_FINGERPRINT_LIST_REFUSAL,
  SFTP_URL_DIRECTORY_REFUSAL,
  MOUNTED_KEY_FILE_ABSENT_REFUSAL,
  MOUNTED_KEY_FILE_INVALID_REFUSAL,
  MOUNTED_KEY_FILE_NEWER_REFUSAL,
  MOUNTED_SIGNING_PATHS_UNCONVERTED_REFUSAL,
  MOUNTED_SIGNING_IDENTITY_MISMATCH_REFUSAL,
  OPENED_CONFIGURATION_NOT_RUNNABLE_REFUSAL,
  SFTP_CREDENTIAL_CONSOLE_FILE_REFUSAL,
  WORKING_FOLDER_CONFIGURATION_PRESENT_REFUSAL,
  WORKING_FOLDER_CONSOLE_EXCHANGE_REFUSAL,
  WORKING_FOLDER_UNWRITABLE_REFUSAL,
  COORDINATION_SERVER_CHANGED_REFUSAL,
] as const;

/** The refusal tokens a create rejection can name. */
export type JobCreateRefusalReason =
  (typeof JOB_CREATE_REFUSAL_REASONS)[number];

/** Whether a value read off a create rejection's body is a refusal token this
 * bundle knows. An unknown token is treated as no token at all, so an older
 * browser against a newer console falls back to the generic copy. */
export function isJobCreateRefusalReason(
  value: unknown,
): value is JobCreateRefusalReason {
  return (JOB_CREATE_REFUSAL_REASONS as ReadonlyArray<unknown>).includes(value);
}

const ZERO_SETUP_SFTP_REFUSAL_REASONS = [
  SFTP_URL_DIRECTORY_REFUSAL,
  SFTP_FINGERPRINT_LIST_REFUSAL,
] as const satisfies ReadonlyArray<JobCreateRefusalReason>;

/** The refusals a direct (zero-setup) sftp run raises over the saved
 * connection itself, before any job exists. */
export type ZeroSetupSftpRefusalReason =
  (typeof ZERO_SETUP_SFTP_REFUSAL_REASONS)[number];

/** The fields of a saved sftp connection a direct run's refusal reads. */
export interface ZeroSetupSftpRefusalInput {
  path?: string;
  inboundPath?: string;
  hostKeyFingerprint: string | ReadonlyArray<string>;
}

/** A direct (zero-setup) sftp run's verdict on a saved connection: the
 * refusal, or the single fingerprint the run pins when it runs. */
export type ZeroSetupSftpCheck =
  | { refusal: typeof SFTP_URL_DIRECTORY_REFUSAL }
  | { refusal: typeof SFTP_FINGERPRINT_LIST_REFUSAL }
  | { refusal: undefined; hostKeyFingerprint: string };

/**
 * Whether a direct (zero-setup) sftp run takes this saved connection: refused
 * for a remote directory (the inbound half, for a split pair) with no
 * `sftp://` URL form, then for a fingerprint list, which the run's
 * single-valued fingerprint flag cannot pass on. Job create throws on the
 * refusal and the connection's projection states it, so the quick-exchange
 * step refuses exactly the connections a run would.
 */
export function zeroSetupSftpCheck(
  connection: ZeroSetupSftpRefusalInput,
): ZeroSetupSftpCheck {
  const urlPath = connection.inboundPath ?? connection.path;
  if (urlPath !== undefined && sftpUrlDirectoryFault(urlPath) !== undefined)
    return { refusal: SFTP_URL_DIRECTORY_REFUSAL };
  if (typeof connection.hostKeyFingerprint !== "string")
    return { refusal: SFTP_FINGERPRINT_LIST_REFUSAL };
  return {
    refusal: undefined,
    hostKeyFingerprint: connection.hostKeyFingerprint,
  };
}

/** Whether a value read off a connection projection is a direct-run refusal
 * this bundle knows. An unknown token is treated as none, leaving job create
 * to refuse the run. */
export function isZeroSetupSftpRefusalReason(
  value: unknown,
): value is ZeroSetupSftpRefusalReason {
  return (ZERO_SETUP_SFTP_REFUSAL_REASONS as ReadonlyArray<unknown>).includes(
    value,
  );
}
