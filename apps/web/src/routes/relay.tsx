import { createFileRoute } from "@tanstack/react-router";

import { RelaySettingsScreen } from "@exchange/RelaySettingsScreen";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/relay")({
  component: RelaySettingsScreen,
  head: () => ({
    meta: seo({
      title: "Relay server - Alcove",
      description:
        "Set the TURN relay your side of an exchange connects through.",
    }),
  }),
});
