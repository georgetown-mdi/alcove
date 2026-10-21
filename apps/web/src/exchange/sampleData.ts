import { triggerBlobDownload } from "@components/blobDownload";

import {
  SAMPLE_INVITER_CSV,
  SAMPLE_INVITER_FILE_NAME,
  SAMPLE_PARTNER_CSV,
  SAMPLE_PARTNER_FILE_NAME,
} from "@psi/sampleData";

// One file per click: a browser may hold or block the second of two downloads
// started by one click, so no control here downloads both sample CSVs at once.

/** Download the inviter sample CSV client-side. Nothing is uploaded; the bytes
 * come from the shared `@psi/sampleData` module. */
export function downloadSampleInviterCsv(): void {
  triggerBlobDownload(SAMPLE_INVITER_FILE_NAME, SAMPLE_INVITER_CSV, "text/csv");
}

/** Download the partner sample CSV, for the side that accepts the invitation. */
export function downloadSamplePartnerCsv(): void {
  triggerBlobDownload(SAMPLE_PARTNER_FILE_NAME, SAMPLE_PARTNER_CSV, "text/csv");
}

/** Build the in-memory {@link File} the inviter seed reads: the inviter sample
 * CSV, passed through the same intake as a dropped file. */
export function sampleInviterFile(): File {
  return new File([SAMPLE_INVITER_CSV], SAMPLE_INVITER_FILE_NAME, {
    type: "text/csv",
  });
}

/** Build the in-memory {@link File} the acceptor's sample choice selects: the
 * partner sample CSV, passed through the same intake as a dropped file. */
export function samplePartnerFile(): File {
  return new File([SAMPLE_PARTNER_CSV], SAMPLE_PARTNER_FILE_NAME, {
    type: "text/csv",
  });
}
