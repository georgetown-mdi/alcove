import { gateJobRoute } from "@jobs/routeSupport";
import { jobJsonResponse } from "@jobs/gate";
import { resolveConsoleImage } from "@jobs/consoleImage";

import { defineJobRoute } from "../jobRoute";

/**
 * `GET /api/jobs/image` -- the registry and digest of the image this console
 * runs, as its launcher passed them (`JOB_IMAGE_REGISTRY`, `JOB_IMAGE_DIGEST`).
 * Shares `gateJobRoute` (404 when the API is disabled, no-store, no CORS).
 *
 * The body is `{ registry, digest? }`: `registry` is `docker.io` or `ghcr.io`,
 * the default when the variable is unset or not one of the two, and `digest` is
 * present only when the variable has the shape of an image digest. Both are
 * public facts of a release, and nothing else of the environment is in the
 * body. The static `image` segment cannot be captured as a job id: ids are
 * validated as canonical v4 UUIDs before any use, which `image` is not.
 */
export const route = defineJobRoute({
  path: "/api/jobs/image",
  handlers: {
    GET: ({ request }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;
      return jobJsonResponse(resolveConsoleImage());
    },
  },
});
