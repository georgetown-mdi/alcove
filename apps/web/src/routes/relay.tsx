import { createFileRoute } from "@tanstack/react-router";

import { RelaySettingsScreen } from "@exchange/RelaySettingsScreen";
import { isConsoleBuild } from "@utils/clientConfig";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/relay")({
  component: RelaySettingsScreen,
  head: () => ({
    meta: seo({
      title: "Relay server - Alcove",
      description: isConsoleBuild()
        ? "Set the relays your side of an exchange uses."
        : "Set the relays and the coordination server your side of an exchange uses.",
    }),
  }),
});
