import { createFileRoute } from "@tanstack/react-router";

import { Lobby } from "@exchange/Lobby";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/quick")({
  component: Lobby,
  head: () => ({
    meta: seo({
      title: "Alcove - encrypted matching and sharing",
      description:
        "Find records you have in common without sharing PII, then exchange data about those records.",
    }),
  }),
});
