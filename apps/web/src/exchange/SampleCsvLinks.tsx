import { Anchor, VisuallyHidden } from "@mantine/core";

import {
  downloadSampleInviterCsv,
  downloadSamplePartnerCsv,
} from "./sampleData";

/** "the inviter CSV or the partner CSV", each a link downloading that one
 * sample file; the caller supplies the leading "download". Each link's
 * accessible name is the whole action, "Download inviter sample CSV". */
export function SampleCsvLinks() {
  return (
    <>
      the{" "}
      <Anchor
        inherit
        component="button"
        type="button"
        onClick={downloadSampleInviterCsv}
      >
        <VisuallyHidden>Download </VisuallyHidden>inviter{" "}
        <VisuallyHidden>sample </VisuallyHidden>CSV
      </Anchor>{" "}
      or the{" "}
      <Anchor
        inherit
        component="button"
        type="button"
        onClick={downloadSamplePartnerCsv}
      >
        <VisuallyHidden>Download </VisuallyHidden>partner{" "}
        <VisuallyHidden>sample </VisuallyHidden>CSV
      </Anchor>
    </>
  );
}
