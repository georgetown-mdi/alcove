import { Anchor, VisuallyHidden } from "@mantine/core";

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import { SAMPLE_PARTNER_FILE_NAME } from "@psi/sampleData";
import styles from "@styles/app.module.css";

import { downloadSamplePartnerCsv } from "./sampleData";

const PARTNER_FILE_DOWNLOADED = `The partner CSV, ${SAMPLE_PARTNER_FILE_NAME}, was downloaded for the other tab.`;
const PARTNER_FILE_RETRY = "download the partner CSV";

/**
 * Where the sample's partner file went, shown while the inviter's sample is
 * loaded and the terms are still open: the lobby and the in-place load each
 * download it, and a page load or the browser can drop that download, so the
 * line offers it again. Announced politely when it appears.
 */
export function SamplePartnerFileStatus() {
  const announcement = useDeferredAnnouncement(
    `${PARTNER_FILE_DOWNLOADED} If it did not arrive, ${PARTNER_FILE_RETRY} again.`,
  );
  return (
    <>
      <p className={styles.demoNoticeDetail}>
        {PARTNER_FILE_DOWNLOADED} If it did not arrive,{" "}
        <Anchor
          inherit
          component="button"
          type="button"
          onClick={downloadSamplePartnerCsv}
        >
          {PARTNER_FILE_RETRY}
        </Anchor>{" "}
        again.
      </p>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </VisuallyHidden>
    </>
  );
}
