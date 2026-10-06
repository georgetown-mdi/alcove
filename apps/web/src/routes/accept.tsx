import { createFileRoute } from "@tanstack/react-router";

import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/accept")({
  // The inviter's deep link points here (ACCEPT_ROUTE_PATH in psi/invitation.ts).
  component: AcceptorScreen,
  head: () => ({
    meta: seo({
      title: "Accept an invitation - Alcove",
      description:
        "Review the terms your partner proposed, then run the exchange.",
    }),
  }),
});
