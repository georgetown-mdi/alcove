import { z } from "zod";

import {
  MAX_RELAY_LOCATOR_URLS,
  MAX_RELAY_LOCATOR_URL_LENGTH,
  RelayRegistrarSchema,
  TurnUrlSchema,
  maxCodeUnits,
} from "@alcove/core";

import type { RelayLocator, RelayRegistrar } from "@alcove/core";

/**
 * The relay the console's own invitations name: TURN urls, each written into
 * the run's `alcove.yaml` as a `connection.turn` entry with no username or
 * credential, so the run mints its credential from the shared secret, and the
 * registrar that relay keeps the exchange's relay key at, where it runs one.
 * Contract: docs/spec/SERVER_JOB_API.md, "The coordination server".
 */
export interface JobOwnRelay {
  turn: Array<string>;
  relayRegistrar?: RelayRegistrar;
}

/** {@link JobOwnRelay}'s validator: core's `turn` url rule under the bounds
 * of an invitation's relay, and core's registrar rule. An entry is a url and
 * nothing else, so no credential is representable. */
export const jobOwnRelaySchema: z.ZodType<JobOwnRelay> = z.strictObject(
  {
    turn: z
      .array(TurnUrlSchema.check(maxCodeUnits(MAX_RELAY_LOCATOR_URL_LENGTH)))
      .min(1, { message: "the relay names no turn url" })
      .max(MAX_RELAY_LOCATOR_URLS, {
        message: `the relay names more than ${MAX_RELAY_LOCATOR_URLS} turn urls`,
      }),
    relayRegistrar: RelayRegistrarSchema.optional(),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `the relay has no ${issue.keys.length === 1 ? "key" : "keys"} ` +
          `${issue.keys.join(", ")}; it holds only turn urls and a registrar`
        : undefined,
  },
);

/**
 * The coordination server a console webrtc job dials, as `GET` and `PUT
 * /api/jobs/webrtc` report it. Nothing in it is a credential. Contract:
 * docs/spec/SERVER_JOB_API.md, "The coordination server".
 */
export interface SignalingServerProjection {
  host: string;
  /** Absent for the scheme's default port. */
  port?: number;
  /** The server's mount, ending in `/`. */
  path: string;
  /** Whether the run dials it over `wss:`. */
  secure: boolean;
  /** The web app whose published file named the server, when the operator
   * gave the web app's address rather than the server's. */
  webAppOrigin?: string;
  /** The relay an accepted invitation names, which only an acceptor's run
   * uses. */
  invitationRelay?: RelayLocator;
  /** The relay set for this console's own invitations, which only an
   * inviter's run uses. */
  ownRelay?: JobOwnRelay;
  /** Advisories about the address, each shown to the operator as written. */
  warnings: Array<string>;
}
