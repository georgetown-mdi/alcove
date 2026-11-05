import { createFileRoute, redirect } from "@tanstack/react-router";

import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { isConsoleBuild } from "@utils/clientConfig";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/saved/$id")({
  // The recurring run surface exists only in the hosted browser build; a console
  // build has no managed store, so it never reaches a saved exchange.
  beforeLoad: () => {
    if (isConsoleBuild()) throw redirect({ to: "/" });
  },
  component: RunRoute,
  head: () => ({
    meta: seo({
      title: "Recurring exchange - Alcove",
      description:
        "A recurring exchange saved in this browser, with its runs and settings.",
    }),
  }),
});

function RunRoute() {
  const { id } = Route.useParams();
  // Key by id so navigating between two saved exchanges remounts the surface.
  // This route matches once on the dynamic param and would otherwise keep its
  // state, letting exchange A's leftovers -- including a live re-invite token --
  // render on exchange B's page.
  return <ManagedRunSurface key={id} id={id} />;
}
