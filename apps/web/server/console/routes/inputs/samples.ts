import { createFileRoute } from "@tanstack/react-router";

import {
  SampleInputsUnwritableError,
  writeSampleInputs,
} from "@jobs/sampleInputs";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { gateJobRoute } from "@jobs/routeSupport";
import { useJobInputDir } from "@jobs/workInputs";

/**
 * `POST /api/jobs/inputs/samples` -- write the two synthetic sample CSVs into
 * the work-input directory the console lists, so the operator picks the sample
 * there. Shares `gateJobRoute`. Takes no body: the names and the content are
 * the server's own constants.
 *
 * `200` `{ files: [{ name, written }] }`, where `written: false` is a file
 * already at that name, left as it was. A directory the console cannot write
 * into (a read-only input mount) is `409` `{ error: "unwritable" }`, holding
 * no path or OS error.
 */
export const Route = createFileRoute("/api/jobs/inputs/samples")({
  server: {
    handlers: {
      POST: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const inputDir = useJobInputDir();
        if (inputDir === undefined) return jobEmptyResponse(404);
        try {
          return jobJsonResponse(writeSampleInputs(inputDir));
        } catch (error) {
          if (error instanceof SampleInputsUnwritableError)
            return jobJsonResponse({ error: "unwritable" }, 409);
          throw error;
        }
      },
    },
  },
});
