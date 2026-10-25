import { createFileRoute, redirect } from "@tanstack/react-router";

import { RelaySettingsScreen } from "@exchange/RelaySettingsScreen";
import { isConsoleBuild } from "@utils/clientConfig";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/relay")({
  // The page saves browser storage that only an exchange run in the browser
  // reads, and the console runs none. A console relay is set on the review
  // step of an invitation it creates, so the route opens that flow.
  beforeLoad: () => {
    if (isConsoleBuild()) throw redirect({ to: "/exchange", replace: true });
  },
  component: RelaySettingsScreen,
  head: () => ({
    meta: seo({
      title: "Relay server - Alcove",
      description:
        "Set the relays and the coordination server your side of an exchange uses.",
    }),
  }),
});
