import path from "node:path";

import {
  getLogger,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  sanitizeErrorForDisplay,
  serializeAgreedTerms,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@alcove/core";
import type {
  AgreedTerms,
  ExchangeRecord,
  VerificationKeys,
} from "@alcove/core";

import { writeFileOwnerOnly } from "./fileUtils";

/** Basename stem of the record file. */
export const DEFAULT_RECORD_BASENAME = "alcove-record";

/**
 * The stamp a run's file names share: the record's own `createdAt` timestamp
 * made filesystem-safe (colons and the fractional-second dot replaced with
 * hyphens).
 */
export function recordFileStamp(createdAt: string): string {
  return createdAt.replace(/[:.]/g, "-");
}

/**
 * The self-attested record's path in a run's folder:
 * `alcove-record-<time>.json`, with the stamp {@link recordFileStamp} derives.
 */
export function recordFilePathIn(folder: string, createdAt: string): string {
  return path.join(
    folder,
    `${DEFAULT_RECORD_BASENAME}-${recordFileStamp(createdAt)}.json`,
  );
}

/**
 * Derive the private verification-keys path from a record path: the record path
 * with a `.keys.json` suffix in place of a trailing `.json` (or appended when the
 * record path does not end in `.json`). Keeps the two files visibly paired.
 *
 * Operates on the suffix directly rather than via `path.join`, which would
 * normalize away a leading `./` and leave the paired record and keys paths
 * with inconsistent prefixes in log messages.
 */
export function keysPathFor(recordPath: string): string {
  return recordPath.endsWith(".json")
    ? `${recordPath.slice(0, -".json".length)}.keys.json`
    : `${recordPath}.keys.json`;
}

/**
 * Derive the agreed-terms path from a record path, as {@link keysPathFor}
 * derives the keys path: a `.terms.json` suffix in place of a trailing `.json`.
 * `alcove verify-receipt` looks for the file here.
 */
export function agreedTermsPathFor(recordPath: string): string {
  return recordPath.endsWith(".json")
    ? `${recordPath.slice(0, -".json".length)}.terms.json`
    : `${recordPath}.terms.json`;
}

/** Concrete file destinations for the record and its verification keys. */
export interface RecordPaths {
  /** Shareable record (commitments + non-secret summary). */
  recordFilePath: string;
  /** Private verification keys (per-commitment salts only, no matched data). */
  keysFilePath: string;
}

/**
 * The record and keys paths in a run's folder, derived from the record's
 * `createdAt`. The keys path is derived from the record path so the two stay
 * visibly paired.
 */
export function recordPathsFor(folder: string, createdAt: string): RecordPaths {
  const recordFilePath = recordFilePathIn(folder, createdAt);
  return { recordFilePath, keysFilePath: keysPathFor(recordFilePath) };
}

/**
 * What {@link writeExchangeRecord} did: the paths both files reached, or the
 * message stating the failure.
 */
export type RecordWriteResult =
  { kind: "written"; paths: RecordPaths } | { kind: "failed"; message: string };

// Written only after the record: the file is a convenience for
// verify-receipt, so a failed write leaves the record whole and costs only
// the flags that supply the same terms.
function writeAgreedTermsBesideRecord(
  recordFilePath: string,
  agreedTerms: AgreedTerms,
  loggerName: string,
): void {
  const log = getLogger(loggerName);
  const termsFilePath = agreedTermsPathFor(recordFilePath);
  const termsFileDisplay = redactAndRenderOperatorSuppliedText(
    operatorSuppliedText(termsFilePath),
  );
  const remedy =
    "to check the record's agreed-terms hash, pass alcove verify-receipt " +
    "--config-file and --partner-terms";
  try {
    writeFileOwnerOnly(termsFilePath, serializeAgreedTerms(agreedTerms));
    log.info(
      `wrote both parties' agreed terms to ${termsFileDisplay}, for alcove ` +
        "verify-receipt to check the record's agreed-terms hash",
    );
  } catch (err) {
    log.warn(
      `the agreed terms could not be written to ${termsFileDisplay} ` +
        `(${sanitizeErrorForDisplay(err)}); the record is unaffected; ${remedy}`,
    );
  }
}

/**
 * Write the record (shareable) and its verification keys (private) to disk,
 * each atomically and owner-only via {@link writeFileOwnerOnly} -- keys
 * first, so a mid-write death leaves the salts recoverable even when the
 * record is not (crash-ordering scope: docs/spec/CREDENTIAL_STORAGE.md).
 * Non-fatal by design: a write failure is logged as a warning and returned
 * as a `failed` result's message, composed RAW for the caller's own
 * event-stream escaping (docs/spec/CLI_EVENTS.md, `warning`), and handles a
 * completed run's record and a terminated one identically
 * (docs/spec/EXCHANGE_RECORD.md, When a record is owed). Given
 * `agreedTerms`, a record that was written gets the agreed-terms file beside
 * it (docs/spec/EXCHANGE_RECORD.md, Agreed-terms file).
 */
export function writeExchangeRecord(
  folder: string,
  record: ExchangeRecord,
  keys: VerificationKeys,
  loggerName: string,
  agreedTerms?: AgreedTerms,
): RecordWriteResult {
  const log = getLogger(loggerName);
  const { recordFilePath, keysFilePath } = recordPathsFor(
    folder,
    record.createdAt,
  );
  // Track the keys write so a partial failure (keys written, record write
  // throws) can tell the user about the orphaned private file below.
  let keysWritten = false;
  // Read off the record's own outcome rather than passed in beside it, so the
  // file and the prose about it can never disagree (docs/spec/EXCHANGE_RECORD.md,
  // When a record is owed).
  const terminated = record.outcome === "receipt-swap-terminated";
  // The one arm on which the record narrows who received the disclosure: the
  // partner presented a certificate that is not the pinned identity, so the
  // self-asserted name beside it is in doubt. Read off the record for the
  // reason the outcome is (docs/spec/EXCHANGE_RECORD.md, When a record is owed).
  const certificateMismatch = record.certificateMismatchObserved;
  try {
    writeFileOwnerOnly(keysFilePath, serializeVerificationKeys(keys));
    keysWritten = true;
    writeFileOwnerOnly(recordFilePath, serializeExchangeRecord(record));
    // Both writes have now succeeded; log them in write order (keys first,
    // then record). The two messages are emitted together here, not interleaved
    // between the writes -- a failed record write goes to the catch below, which
    // names the orphaned keys file instead.
    log.info(
      `wrote private verification keys to ${redactAndRenderOperatorSuppliedText(
        operatorSuppliedText(keysFilePath),
      )}; keep them private -- ` +
        "with the record they can open the commitments, but they hold only " +
        "per-commitment salts (no matched data)",
    );
    log.info(
      "wrote self-attested exchange record (a local audit artifact, NOT a " +
        `signed or non-repudiable receipt) to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(recordFilePath),
        )}` +
        (terminated
          ? "; it records a disclosure this run made before the run " +
            "terminated, and states that no receipt accompanies it"
          : "") +
        (certificateMismatch
          ? ". It states that the partner presented a certificate that " +
            "is not the one pinned for them, so the partner name in the " +
            "record is what they claimed and not what this run confirmed"
          : ""),
    );
    if (agreedTerms !== undefined)
      writeAgreedTermsBesideRecord(recordFilePath, agreedTerms, loggerName);
    return { kind: "written", paths: { recordFilePath, keysFilePath } };
  } catch (err) {
    log.warn(
      (terminated
        ? "the exchange disclosed before it failed, but the audit record of " +
          "that disclosure could not be written"
        : "the exchange and results succeeded but the audit record could not " +
          "be written") +
        ` (${sanitizeErrorForDisplay(err)}); ` +
        (terminated
          ? "the disclosure still occurred and now has no local record"
          : "the results above are unaffected and the exchange need not be " +
            "re-run"),
    );
    // The keys are written before the record, so a record-write failure leaves
    // the keys file on disk. Name it: though it holds no matched data, it is
    // still private material, so the user should delete it or protect it rather
    // than silently orphan it.
    if (keysWritten) {
      log.warn(
        `the private verification keys were already written to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(keysFilePath),
        )} ` +
          "before this failure; they hold only salts (no matched data) but are " +
          "still private -- delete them or keep them private",
      );
    }
    return {
      kind: "failed",
      message: terminated
        ? `the audit record could not be written to ${recordFilePath}; the ` +
          "exchange disclosed before it failed, so that disclosure has no " +
          "record"
        : `the audit record could not be written to ${recordFilePath}; the ` +
          "exchange and its results succeeded and need not be re-run, so " +
          "this exchange has no record",
    };
  }
}
