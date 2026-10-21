import { Anchor, VisuallyHidden } from "@mantine/core";

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import { SAMPLE_PARTNER_FILE_NAME } from "@psi/sampleData";
import styles from "@styles/app.module.css";

import { downloadSamplePartnerCsv } from "./sampleData";

const PARTNER_FILE_NEEDED = `The other tab needs the partner CSV, ${SAMPLE_PARTNER_FILE_NAME}. If you do not have it,`;
const PARTNER_FILE_RETRY = "download the partner CSV";

/**
 * Which file the other tab needs, shown while the inviter's sample is loaded
 * and the terms are still open: the lobby and the in-place load each download
 * it, a direct visit downloads nothing, and the browser can drop a download,
 * so the line names the file and offers it. Announced politely when it
 * appears.
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
