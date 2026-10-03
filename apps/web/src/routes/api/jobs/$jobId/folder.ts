import { createFileRoute } from "@tanstack/react-router";

import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";

/**
 * `GET /api/jobs/:jobId/folder` -- which of a run's files its folder holds, and
 * whether the console still holds the run.
 *
 * Feature-gated and id-validated. Answers for the exchange the console holds and
 * for a folder a server restart left behind under a valid id, so the console can
 * offer to keep or discard that folder and name what a discard deletes. The body
 * is `{ live, results, record, sharedSecret, receipt, log }`, every field a
 * boolean: presence only, never a file's content, size, or path. `404` when no
 * such folder exists.
 */
export const Route = createFileRoute("/api/jobs/$jobId/folder")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const jobId = validateJobIdParam(params.jobId);
        if (jobId === null) return jobEmptyResponse(404);

        const view = await gate.manager.describeJobFolder(jobId);
        if (view === null) return jobEmptyResponse(404);
        return jobJsonResponse({ live: view.live, ...view.contents });
      },
    },
  },
});
