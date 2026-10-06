import { createFileRoute } from "@tanstack/react-router";

import { DirectExchangeScreen } from "@exchange/DirectExchangeScreen";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/direct")({
  component: DirectExchangeScreen,
  head: () => ({
    meta: seo({
      title: "Quick exchange - Alcove",
      description:
        "Run an exchange you have already arranged, against a server you and your partner agreed on.",
    }),
  }),
});
