import { z } from "zod";

import {
  ConsoleShuttingDownError,
  RelayCheckBusyError,
} from "@jobs/jobManager";
import {
  MAX_RELAY_CHECK_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";

import { defineJobRoute } from "../jobRoute";

import type { RelayCheckOffer } from "@jobs/relayCheck";

/** The strict start body: the digest of the configuration the operator was shown. */
const relayCheckBodySchema = z.strictObject({
  configurationDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

function offerEnvelope(offer: RelayCheckOffer): Record<string, unknown> {
  if (offer.kind === "unavailable")
    return { status: "unavailable", reason: offer.reason };
  return {
    status: "available",
    configurationDigest: offer.configurationDigest,
    statement: offer.statement,
  };
}

/**
 * `GET /api/jobs/relay-check` -- the hosts a relay check of the working
 * folder's `alcove.yaml` and `.alcove.key` contacts and those it does not,
 * read from the file and contacting nothing, or why there is nothing to
 * check. `POST /api/jobs/relay-check` -- run the CLI's `doctor relay --json`
 * over that pair, when the file is still the one the digest names, and
 * answer the verdict with each check's headline composed by core and every
 * string escaped and bounded (docs/spec/SERVER_JOB_API.md, Checking the
 * relay).
 *
 * The POST body is `{ configurationDigest }` alone, under a tight byte cap.
 * `409` (empty body) while a check runs, `409 { "reason": "exchange-running" }`
 * while an exchange's child is running, `503` once the console is shutting
 * down. A check that ran and failed is a `200` category, never a `502`.
 */
export const route = defineJobRoute({
  path: "/api/jobs/relay-check",
  handlers: {
    GET: ({ request }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;
      try {
        return jobJsonResponse(offerEnvelope(gate.manager.relayCheckOffer()));
      } catch {
        return jobEmptyResponse(500);
      }
    },
    POST: async ({ request }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;

      const body = await readJobRequestBody(
        request,
        MAX_RELAY_CHECK_BODY_BYTES,
      );
      if (body.kind === "too-large") return jobEmptyResponse(413);
      if (body.kind === "invalid") return jobEmptyResponse(400);
      const parsed = relayCheckBodySchema.safeParse(body.value);
      if (!parsed.success) return jobEmptyResponse(400);

      let result: Awaited<ReturnType<typeof gate.manager.checkRelay>>;
      try {
        result = await gate.manager.checkRelay({
          configurationDigest: parsed.data.configurationDigest,
        });
      } catch (error) {
        if (error instanceof RelayCheckBusyError) return jobEmptyResponse(409);
        if (error instanceof ConsoleShuttingDownError)
          return jobEmptyResponse(503);
        return jobEmptyResponse(500);
      }
      switch (result.kind) {
        case "exchange-running":
          return jobJsonResponse({ reason: "exchange-running" }, 409);
        case "unavailable":
          return jobJsonResponse(offerEnvelope(result));
        case "verdict":
          return jobJsonResponse({
            status: "verdict",
            overall: result.overall,
            checks: result.checks,
          });
        default:
          return jobJsonResponse({ status: result.kind });
      }
    },
  },
});
