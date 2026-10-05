import { createFileRoute } from "@tanstack/react-router";

import { jobJsonResponse, readJobApiConfig } from "@jobs/gate";
import { gateJobRoute } from "@jobs/routeSupport";
import { isConsoleOwnedFolderName } from "@jobs/consoleOwnedFiles";
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
 * bytes are read. The console's own top-level files -- the key file, the
 * configuration and its saved copy, the signing certificate, and the job
 * working directories -- are left out, so the picker never offers the
 * exchange's secret as a credential.
 */
export const Route = createFileRoute("/api/jobs/mounts/folder/entries")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const gate = gateJobRoute(request);
        if (gate.kind === "response") return gate.response;
        const subPath = new URL(request.url).searchParams.getAll("subPath");
        const listing = listMountEntries(readJobApiConfig().dataRoot, subPath);
        return jobJsonResponse({
          configured: true,
          readable: listing.readable,
          entries:
            subPath.length === 0
              ? listing.entries.filter(
                  (entry) => !isConsoleOwnedFolderName(entry.name),
                )
              : listing.entries,
        });
      },
    },
  },
});
