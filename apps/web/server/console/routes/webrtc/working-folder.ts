import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { gateJobRoute } from "@jobs/routeSupport";

import { INVITATION_DIGEST_PATTERN } from "@jobContract/signalingServer";

import { defineJobRoute } from "../../jobRoute";

/**
 * `GET /api/jobs/webrtc/working-folder?invitation=<digest>` -- whether a
 * webrtc create of the invitation `invitation` names runs over the pair in
 * the working folder, as a retry of it does, and the allowed relays that
 * pair's `alcove.yaml` states, which the console's accept review starts
 * from. Shares `gateJobRoute`, as `/api/jobs/webrtc` does.
 *
 * `invitation` is the lowercase hex sha256 digest of the invitation's
 * original shared secret, the digest the console records the pair under;
 * anything else is an empty `400`. The body is `{ held: false }`, or
 * `{ held: true, allowedRelays? }`. Nothing is written.
 */
export const route = defineJobRoute({
  path: "/api/jobs/webrtc/working-folder",
  handlers: {
    GET: ({ request }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;
      const invitation = new URL(request.url).searchParams.getAll("invitation");
      if (
        invitation.length !== 1 ||
        !INVITATION_DIGEST_PATTERN.test(invitation[0])
      )
        return jobEmptyResponse(400);
      return jobJsonResponse(gate.manager.workingFolderPairFor(invitation[0]));
    },
  },
});
