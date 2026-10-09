import {
  DirectoryListingBoundsError,
  DISPLAY_TRUNCATION_MARKER,
  MAX_FILE_NAME_BYTES,
  redactPrivateKeyMaterial,
  type TransportOperationStalledError,
} from "@alcove/core";

import { fittedCauseLink } from "./causeLink";
import { transportOperationStalledError } from "./sftpLivenessGuard";

/**
 * Directory-listing bounds shared by `LocalFSClient` and the SFTP adapter,
 * refused before the listing is materialized:
 * docs/spec/TRANSPORT_BOUNDS.md#directory-listing-bound.
 */

/** Maximum entries a transport directory listing enumerates, of any type. */
export const MAX_DIRECTORY_ENTRIES = 8192;

/**
 * Maximum UTF-8 byte length of one entry's filename, measured by
 * {@link filenameByteLength}: core's `MAX_FILE_NAME_BYTES`.
 */
export const MAX_FILENAME_BYTES = MAX_FILE_NAME_BYTES;

/**
 * The name's UTF-8 length in bytes. For a decoded string this is the length of
 * its re-encoding, which over-counts bytes that were not valid UTF-8;
 * `LocalFSClient` measures the raw on-disk bytes instead.
 */
export function filenameByteLength(name: string): number {
  return Buffer.byteLength(name, "utf8");
}

const DIRECTORY_LINK_LABEL = "directory: ";

/**
 * The labelled `directory:` cause link both refusals below include, fitted here
 * because `dirPath` is bounded nowhere upstream and can come from a partner
 * invitation: docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format.
 */
function directoryLink(dirPath: string): string {
  // eslint-disable-next-line no-restricted-syntax -- an offline-accept config seeds this directory from the partner's invitation, so it keeps the escape.
  return fittedCauseLink(DIRECTORY_LINK_LABEL, dirPath);
}

/**
 * The terminal error for a directory over {@link MAX_DIRECTORY_ENTRIES}
 * entries, with `dirPath` in its own cause link.
 */
export function directoryTooLargeError(
  dirPath: string,
  max: number,
): DirectoryListingBoundsError {
  return new DirectoryListingBoundsError(
    `the shared folder contains more than ${max} entries; refusing to ` +
      `enumerate it to avoid an unbounded memory allocation`,
    { details: [directoryLink(dirPath)] },
  );
}

/**
 * The terminal error for an entry name over {@link MAX_FILENAME_BYTES}. Only a
 * raw 64-character slice of the name is kept, a memory bound; the true length
 * is reported as a number: `nameBytes` where the caller measured raw bytes,
 * otherwise `name` re-encoded. `dirPath` and `name` come from different
 * parties, so each takes its own cause link and neither can crowd out the
 * other.
 */
export function filenameTooLongError(
  dirPath: string,
  name: string,
  max: number,
  nameBytes: number = filenameByteLength(name),
): DirectoryListingBoundsError {
  // The name is longer than the slice, so the marker is unconditional.
  // Redaction runs before the marker is appended, so a planted BEGIN marker in
  // the slice cannot consume it under the fail-closed dangling rule.
  const shown = `${redactPrivateKeyMaterial(
    name.slice(0, 64),
  )}${DISPLAY_TRUNCATION_MARKER}`;
  return new DirectoryListingBoundsError(
    `the shared folder contains an entry whose filename is ` +
      `${nameBytes} bytes, exceeding the maximum of ${max}; ` +
      `refusing to process it`,
    {
      details: [directoryLink(dirPath), `entry name: ${shown}`],
    },
  );
}

/**
 * Maximum `readdir` round-trips one SFTP `list()` issues, so empty non-EOF
 * batches cannot loop forever:
 * docs/spec/TRANSPORT_LIVENESS.md#per-operation-liveness-bounds.
 */
export const MAX_LISTING_READDIR_BATCHES = 2 * MAX_DIRECTORY_ENTRIES;

/**
 * The terminal liveness error for a listing over
 * {@link MAX_LISTING_READDIR_BATCHES} round-trips, of the same type as the
 * other transport stalls.
 */
export function listingStalledByBatchCountError(
  dirPath: string,
  max: number,
): TransportOperationStalledError {
  return transportOperationStalledError(
    "directory listing",
    dirPath,
    `made no progress over ${max} readdir round-trips without reaching ` +
      `end-of-directory`,
  );
}

/**
 * The terminal liveness error for a listing past the wall-clock deadline
 * ({@link ./sftpLivenessGuard.SFTP_STALL_DEADLINE_MS}).
 */
export function listingStalledByTimeoutError(
  dirPath: string,
  deadlineMs: number,
): TransportOperationStalledError {
  return transportOperationStalledError(
    "directory listing",
    dirPath,
    `did not complete within ${deadlineMs} ms (the server withheld a ` +
      `directory-read response)`,
  );
}
