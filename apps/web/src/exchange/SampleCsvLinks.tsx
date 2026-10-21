import { Anchor } from "@mantine/core";

import {
  downloadSampleInviterCsv,
  downloadSamplePartnerCsv,
} from "./sampleData";

/** "the inviter CSV or the partner CSV", each a link downloading that one
 * sample file; the caller supplies the leading "download". */
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
        inviter CSV
      </Anchor>{" "}
      or the{" "}
      <Anchor
        inherit
        component="button"
        type="button"
        onClick={downloadSamplePartnerCsv}
      >
        partner CSV
      </Anchor>
    </>
  );
}
