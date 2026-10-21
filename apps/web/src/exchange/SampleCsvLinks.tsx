import { Anchor } from "@mantine/core";

import {
  downloadSampleInviterCsv,
  downloadSamplePartnerCsv,
} from "./sampleData";

/** "download the inviter sample CSV or download the partner sample CSV", each
 * a link downloading that one sample file. The link text carries the verb, so
 * the caller supplies none. */
export function SampleCsvLinks() {
  return (
    <>
      <Anchor
        inherit
        component="button"
        type="button"
        onClick={downloadSampleInviterCsv}
      >
        download the inviter sample CSV
      </Anchor>{" "}
      or{" "}
      <Anchor
        inherit
        component="button"
        type="button"
        onClick={downloadSamplePartnerCsv}
      >
        download the partner sample CSV
      </Anchor>
    </>
  );
}
