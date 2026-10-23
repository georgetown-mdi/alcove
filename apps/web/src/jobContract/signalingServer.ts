import { z } from "zod";

import {
  MAX_RELAY_LOCATOR_URLS,
  MAX_RELAY_LOCATOR_URL_LENGTH,
  RelayRegistrarSchema,
  TurnUrlSchema,
  maxCodeUnits,
  relayLocatorFromOwnRelay,
  webSocketRelayUrlSchema,
} from "@alcove/core";

import type { RelayLocator, RelayRegistrar } from "@alcove/core";

/**
 * The relay the console's own invitations name: TURN urls, each written into
 * the run's `alcove.yaml` as a `connection.turn` entry with no username or
 * credential, so the run mints its credential from the shared secret, a
 * WebSocket relay url, written as `connection.websocket_relay`, and the
 * registrar that relay keeps the exchange's relay key at, where it runs one.
 * Contract: docs/spec/SERVER_JOB_API.md, "The coordination server".
 */
export interface JobOwnRelay {
  /** Non-empty when present; absent where the relay is a WebSocket relay
   * alone. */
  turn?: Array<string>;
  /** The `wss://` url of a WebSocket relay. */
  websocket?: string;
  /** Only beside a `turn` url, as core's `relay_registrar` rule requires. */
  relayRegistrar?: RelayRegistrar;
}

/** How the refusal of an `ownRelay` the console's rules refuse begins, so the
 * browser shows it on the relay fields rather than on the address. */
export const OWN_RELAY_REFUSED_PREFIX = "The relay is refused: ";

/** {@link JobOwnRelay}'s validator: core's `turn` url rule under the bounds
 * of an invitation's relay, core's `websocket_relay` rule, and core's
 * registrar rule, which also holds a registrar to a `turn` url. An entry is a
 * url and nothing else, so no credential is representable. */
export const jobOwnRelaySchema: z.ZodType<JobOwnRelay> = z
  .strictObject(
    {
      turn: z
        .array(TurnUrlSchema.check(maxCodeUnits(MAX_RELAY_LOCATOR_URL_LENGTH)))
        .min(1, { message: "the relay names no turn url" })
        .max(MAX_RELAY_LOCATOR_URLS, {
          message: `the relay names more than ${MAX_RELAY_LOCATOR_URLS} turn urls`,
        })
        .optional(),
      websocket: webSocketRelayUrlSchema(
        "the relay's websocket url",
      ).optional(),
      relayRegistrar: RelayRegistrarSchema.optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? `the relay has no ${issue.keys.length === 1 ? "key" : "keys"} ` +
            `${issue.keys.join(", ")}; it holds only turn urls, a websocket ` +
            "url, and a registrar"
          : undefined,
    },
  )
  .refine(
    (relay) => relay.turn !== undefined || relay.websocket !== undefined,
    { message: "the relay names no turn or websocket url" },
  )
  .refine(
    (relay) => relay.relayRegistrar === undefined || relay.turn !== undefined,
    {
      message:
        "the relay's registrar registers the key its turn urls mint their " +
        "credential from, so it requires a turn url",
    },
  );

/**
 * The relay locator an invitation the console creates names for `relay`, as
 * `alcove invite` names a configuration's own relay: its TURN urls, its
 * WebSocket relay url, and beside that url the registrar's exchange id, which
 * the relay holds the key under. The registrar's address is this party's own
 * and is not named.
 */
export function ownRelayInvitationLocator(
  relay: JobOwnRelay | undefined,
): RelayLocator | undefined {
  if (relay === undefined) return undefined;
  return relayLocatorFromOwnRelay({
    turn: relay.turn,
    websocket: relay.websocket,
    websocketExchangeId: relay.relayRegistrar?.exchangeId,
  });
}

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
