import { triggerBlobDownload } from "@components/blobDownload";

import {
  SAMPLE_INVITER_CSV,
  SAMPLE_INVITER_FILE_NAME,
  SAMPLE_PARTNER_CSV,
  SAMPLE_PARTNER_FILE_NAME,
} from "@psi/sampleData";

/** Download both sample CSVs (inviter then partner) client-side. Nothing is
 * uploaded; the bytes come from the shared `@psi/sampleData` module. */
export function downloadSampleCsvs(): void {
  triggerBlobDownload(SAMPLE_INVITER_FILE_NAME, SAMPLE_INVITER_CSV, "text/csv");
  triggerBlobDownload(SAMPLE_PARTNER_FILE_NAME, SAMPLE_PARTNER_CSV, "text/csv");
}

/** Build the in-memory {@link File} the inviter seed reads: the inviter sample
 * CSV, passed through the same intake as a dropped file. */
export function sampleInviterFile(): File {
  return new File([SAMPLE_INVITER_CSV], SAMPLE_INVITER_FILE_NAME, {
    type: "text/csv",
  });
}
