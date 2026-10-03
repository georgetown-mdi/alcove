import { createFileRoute } from "@tanstack/react-router";

import { jobJsonResponse, readJobApiConfig } from "@jobs/gate";
import { gateJobRoute } from "@jobs/routeSupport";
import { listMountEntries } from "@jobs/mountBrowse";

/**
 * `GET /api/jobs/mounts/folder/entries?subPath=...&subPath=...` -- list the
 * console's mounted working folder (`JOB_DATA_ROOT`), which the credential
 * picker browses when no separate secrets directory is mounted. Shares
 * `gateJobRoute`, and the browse contract of the secrets listing beside it:
 * `subPath` is a repeated query parameter, one segment per value, each admitted
 * by the single-segment shape rule and re-confined to the folder by realpath
 * before any read.
 *
 * The body is `{ configured: true, readable, entries }`, the secrets listing's
 * shape; the working folder is always configured while the API is on. No file
 * bytes are read.
 */
export const Route = createFileRoute("/api/jobs/mounts/folder/entries")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const subPath = new URL(request.url).searchParams.getAll("subPath");
        return jobJsonResponse({
          configured: true,
          ...listMountEntries(readJobApiConfig().dataRoot, subPath),
        });
      },
    },
  },
});
