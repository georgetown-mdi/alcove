import { createFileRoute } from "@tanstack/react-router";

import { Lobby } from "@exchange/Lobby";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/quick")({
  component: Lobby,
  head: () => ({
    meta: seo({
      title: "Alcove - encrypted matching and sharing",
      description:
        "Match records with a partner using data that remains encrypted. Then exchange the fields you select for the records you have in common.",
    }),
  }),
});
