import { createFileRoute } from "@tanstack/react-router";

import { RelaySettingsScreen } from "@exchange/RelaySettingsScreen";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/relay")({
  component: RelaySettingsScreen,
  head: () => ({
    meta: seo({
      title: "Relay server - Alcove",
      description:
        "Set the relays and the coordination server your side of an exchange uses.",
    }),
  }),
});
