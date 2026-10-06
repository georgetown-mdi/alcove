import { createFileRoute } from "@tanstack/react-router";

import { VerifyReceiptScreen } from "@exchange/VerifyReceiptScreen";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/verify")({
  component: VerifyReceiptScreen,
  head: () => ({
    meta: seo({
      title: "Verify an exchange record - Alcove",
      description:
        "Check an exchange record you kept against the exchange it describes.",
    }),
  }),
});
