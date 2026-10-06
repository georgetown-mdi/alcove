import path from "node:path";

import {
  getLogger,
  operatorSuppliedText,
  recordFileStamp,
  redactAndRenderOperatorSuppliedText,
  sanitizeErrorForDisplay,
  serializeDualSignedRecord,
} from "@alcove/core";
import type { DualSignedRecord } from "@alcove/core";

import { writeFileOwnerOnly } from "./fileUtils";

// File custody for the dual-signed exchange record (the signed-receipt step's
// output). Mirrors recordFile.ts: a timestamped default path in the run's
// folder, atomic owner-only writes. See docs/spec/EXCHANGE_RECORD.md,
// Dual-signed record file.

/** Basename stem for the default dual-signed record file. */
export const DEFAULT_RECEIPT_BASENAME = "alcove-receipt";

/**
 * The dual-signed record's default path in a run's folder:
 * `alcove-receipt-<time>.json`, with the stamp of the run's self-attested
 * record ({@link recordFileStamp}), so the receipt and record files for one
 * exchange share it.
 */
export function receiptFilePathIn(folder: string, createdAt: string): string {
  return path.join(
    folder,
    `${DEFAULT_RECEIPT_BASENAME}-${recordFileStamp(createdAt)}.json`,
  );
}

/**
 * Write the dual-signed record to disk atomically and owner-only via
 * {@link writeFileOwnerOnly}, so a mid-write abort leaves it complete or
 * absent. Non-fatal by design, like the self-attested record
 * (`recordFile.ts`): a write failure is logged as a warning and returned as
 * a message, composed RAW for the caller's own event-stream escaping
 * (docs/spec/CLI_EVENTS.md, `warning`).
 */
export function writeDualSignedRecord(
  record: DualSignedRecord,
  folder: string,
  createdAt: string,
  loggerName: string,
): string | undefined {
  const log = getLogger(loggerName);
  const receiptFilePath = receiptFilePathIn(folder, createdAt);
  try {
    writeFileOwnerOnly(receiptFilePath, serializeDualSignedRecord(record));
    log.info(
      "wrote dual-signed exchange record (both parties' signatures and " +
        `certificates over the agreed terms and data commitments) to ` +
        redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(receiptFilePath),
        ),
    );
    return undefined;
  } catch (err) {
    log.warn(
      "the exchange and signature swap succeeded but the dual-signed record " +
        `could not be written (${sanitizeErrorForDisplay(err)}); ` +
        "the results above are unaffected and the exchange need not be re-run",
    );
    return (
      `the dual-signed record could not be written to ${receiptFilePath}; the ` +
      "exchange and its signature swap succeeded and need not be re-run, so " +
      "this exchange has no receipt file"
    );
  }
}
