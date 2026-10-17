// The words a CLI run, the acceptance review and `alcove doctor relay` use for
// the TURN urls `connection.allowed_relays` keeps and leaves out
// (`selectRunRelay` in core). Operator page: docs/EXCHANGE_REFERENCE.md,
// connection.allowed_relays.

import { redactAndSanitizeForDisplay } from "@alcove/core";
import type { RunRelaySelection, RunTurnServer } from "@alcove/core";

/** The mark of a TURN url the setting keeps. */
export const KEPT_BY_ALLOWED_RELAYS = "kept by connection.allowed_relays";

/** The mark of a TURN url the setting leaves out. */
export const LEFT_OUT_BY_ALLOWED_RELAYS =
  "left out by connection.allowed_relays";

/** What the setting decides, and what it does not. */
export const ALLOWED_RELAYS_SCOPE =
  "connection.allowed_relays decides which relays your side connects " +
  "through, enrolls at and names in the invitations it creates; your own " +
  "connection.relay_registrar, where set, still receives each rotated " +
  "relay key. Your " +
  "partner's side can still connect through a relay it leaves out; to keep " +
  "your network address off such a relay, also set ice_transport_policy: " +
  "relay.";

/**
 * The acceptance review's line under the invitation's relay when the
 * configuration it keeps or writes sets no `allowed_relays`.
 */
export const ALLOWED_RELAYS_UNSET =
  "A run may connect through this relay. To leave it out, set " +
  "connection.allowed_relays.";

/** What to do when a run that left relays out did not connect. */
export const ALLOWED_RELAYS_REMEDY =
  "to let a run try a relay left out, add its host to " +
  "connection.allowed_relays, or remove the setting";

/** A TURN url as a run's own line names it: an invitation's escaped. */
export function runTurnUrlForDisplay(server: RunTurnServer): string {
  return server.source === "own"
    ? server.url
    : redactAndSanitizeForDisplay(server.url);
}

function urlList(servers: ReadonlyArray<RunTurnServer>): string {
  return servers.map(runTurnUrlForDisplay).join(", ");
}

/**
 * The line a run prints when the connection sets `allowed_relays`: the TURN
 * urls it keeps and the ones it leaves out, then {@link ALLOWED_RELAYS_SCOPE}.
 */
export function allowedRelaysRunNotice(selection: RunRelaySelection): string {
  const kept = selection.turn ?? [];
  const leftOut = selection.turnLeftOut ?? [];
  const keeps =
    kept.length === 0 ? "keeps no TURN url" : `keeps ${urlList(kept)}`;
  const leaves =
    leftOut.length === 0 ? "leaves out none" : `leaves out ${urlList(leftOut)}`;
  return `connection.allowed_relays ${keeps} and ${leaves} for this run. ${ALLOWED_RELAYS_SCOPE}`;
}
