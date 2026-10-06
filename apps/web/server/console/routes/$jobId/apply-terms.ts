import { gateJobRoute, validateJobIdParam } from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { ConsoleShuttingDownError } from "@jobs/jobManager";

import { defineJobRoute } from "../../jobRoute";

/**
 * `POST /api/jobs/:jobId/apply-terms` -- apply the partner's changed linkage
 * terms a run of the opened configuration stopped on to the mounted
 * `alcove.yaml`, by running the CLI's `alcove apply` on the proposal the run
 * wrote (docs/spec/SERVER_JOB_API.md, "Applying a partner's terms change").
 *
 * No request body. `404` on a malformed or unknown id and on a job with no
 * proposal to apply; `409` (empty body) while an apply runs or the run's
 * child has not exited; `503` once the console is shutting down. A completed
 * attempt is `200 { "status" }`: `applied`, `refused`, `timeout`, `error`,
 * `configuration-changed`, or `run-terms-differ`.
 */
export const route = defineJobRoute({
  path: "/api/jobs/$jobId/apply-terms",
  handlers: {
    POST: async ({ request, params }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;
      const jobId = validateJobIdParam(params.jobId);
      if (jobId === null) return jobEmptyResponse(404);

      let result: Awaited<ReturnType<typeof gate.manager.applyTermsProposal>>;
      try {
        result = await gate.manager.applyTermsProposal(jobId);
      } catch (error) {
        if (error instanceof ConsoleShuttingDownError)
          return jobEmptyResponse(503);
        return jobEmptyResponse(500);
      }
      if (result.kind === "unavailable") return jobEmptyResponse(404);
      if (result.kind === "busy") return jobEmptyResponse(409);
      return jobJsonResponse({ status: result.kind });
    },
  },
});
