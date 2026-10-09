import {
  JobApiConfigError,
  jobEmptyResponse,
  jobJsonResponse,
} from "@jobs/gate";
import {
  MAX_SIGNALING_AUTHOR_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import { SignalingServerAuthoringSupersededError } from "@jobs/jobManager";
import { SignalingServerUnreachableError } from "@jobs/signalingServer";

import { defineJobRoute } from "../jobRoute";

import type { SignalingServerProjection } from "@jobContract/signalingServer";

/**
 * `/api/jobs/webrtc` -- the coordination server a webrtc job dials. Shares
 * `gateJobRoute` (404 when the API is disabled, no-store, no CORS), as
 * `/api/jobs/sftp` does.
 *
 * - `GET` reports `{ configured: false }`, or `{ configured: true, host,
 *   port?, path, secure, webAppOrigin?, warnings }`.
 * - `PUT` authors it from `{ address }`: a `ws:`/`wss:` server, or an
 *   `http:`/`https:` web app address resolved through the server that app
 *   publishes. A refused address is a `400 { error }`, a web app that cannot
 *   be read a `502 { error }`, each one sentence of what happened and one of
 *   what to do; a later `PUT` or `DELETE` taking effect during that read
 *   makes it a `409`.
 * - `DELETE` forgets it (idempotent `204`).
 *
 * `POST /api/jobs` gains no connection field: a webrtc job dials only the
 * server authored here.
 */
export const route = defineJobRoute({
  path: "/api/jobs/webrtc",
  handlers: {
    GET: ({ request }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;
      const server = gate.manager.signalingServerProjection();
      return jobJsonResponse(
        server === null
          ? { configured: false }
          : { configured: true, ...server },
      );
    },
    PUT: async ({ request }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;

      const body = await readJobRequestBody(
        request,
        MAX_SIGNALING_AUTHOR_BODY_BYTES,
      );
      if (body.kind === "too-large") return jobEmptyResponse(413);
      if (body.kind === "invalid") return jobEmptyResponse(400);

      let server: SignalingServerProjection;
      try {
        server = await gate.manager.authorSignalingServer(body.value);
      } catch (error) {
        if (error instanceof JobApiConfigError)
          return jobJsonResponse({ error: error.message }, 400);
        if (error instanceof SignalingServerUnreachableError)
          return jobJsonResponse({ error: error.message }, 502);
        if (error instanceof SignalingServerAuthoringSupersededError)
          return jobEmptyResponse(409);
        return jobEmptyResponse(500);
      }
      return jobJsonResponse({ configured: true, ...server });
    },
    DELETE: ({ request }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;
      gate.manager.clearAuthoredSignalingServer();
      return jobEmptyResponse(204);
    },
  },
});
