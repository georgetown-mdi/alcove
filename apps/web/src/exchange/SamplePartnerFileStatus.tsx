import { Anchor, VisuallyHidden } from "@mantine/core";

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import { SAMPLE_PARTNER_FILE_NAME } from "@psi/sampleData";
import styles from "@styles/app.module.css";

import { downloadSamplePartnerCsv } from "./sampleData";

const PARTNER_FILE_NEEDED = `Another tab of this browser can accept the invitation with the sample partner file it offers. A different browser needs the partner CSV, ${SAMPLE_PARTNER_FILE_NAME}. To get it,`;
const PARTNER_FILE_RETRY = "download the partner CSV";

/**
 * How the other side gets the partner sample, shown while the inviter's
 * sample is loaded and the terms are still open: another tab of this browser
 * is offered it in place, while a different browser needs the downloaded
 * file. Loading the sample, from the lobby or in place, downloads nothing,
 * so the line names the file and offers it for download. Announced politely
 * when it appears.
 */
export function SamplePartnerFileStatus() {
  const announcement = useDeferredAnnouncement(
    `${PARTNER_FILE_NEEDED} ${PARTNER_FILE_RETRY}.`,
  );
  return (
    <>
      <p className={styles.demoNoticeDetail}>
        {PARTNER_FILE_NEEDED}{" "}
        <Anchor
          inherit
          component="button"
          type="button"
          onClick={downloadSamplePartnerCsv}
        >
          {PARTNER_FILE_RETRY}
        </Anchor>
        .
      </p>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </VisuallyHidden>
    </>
  );
}
