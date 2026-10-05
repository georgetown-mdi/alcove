// Which relay registrar a CLI run registers at (infra/relay/README.md, The
// registrar). The request, its answer classification, and the enrollment made
// with the relay-owner token are core's (`relayRegistrarClient.ts`), shared
// with the web app, and re-exported here.

import {
  ConnectionError,
  failureCauseSentence,
  hasMintedTurnEntry,
  markFailureCause,
  selectRunRelay,
} from "@alcove/core";
import type {
  ConnectionConfig,
  FailureCauseOfKind,
  RelayRegistrar,
} from "@alcove/core";

export {
  enrollRelayKey,
  RELAY_REGISTRAR_REQUEST_TIMEOUT_MS,
  relayRegistrarLabel,
  relayRegistrationBody,
  relayRegistrationNotice,
  REMOVED_CREDENTIAL_TEXT,
  sendRelayRegistration,
} from "@alcove/core";
export type {
  RelayRegistrarAnswer,
  RelayRegistrarTransport,
  RelayRegistrationOutcome,
} from "@alcove/core";

/**
 * The registrar a run registers its rotated relay key at: the connection's
 * `relay_registrar`, when the run relays through this party's own `turn`
 * entries and one of them has its credential minted from the shared secret.
 * `undefined` otherwise -- a run relaying through the relay a partner's
 * invitation named registers nothing, since the party supplying a relay is
 * the one that registers at it.
 */
export function relayRegistrarForRun(
  connection: ConnectionConfig,
): RelayRegistrar | undefined {
  if (connection.channel !== "webrtc") return undefined;
  const registrar = connection.relayRegistrar;
  if (registrar === undefined) return undefined;
  const { turn } = selectRunRelay(connection);
  if (turn?.source !== "own" || !hasMintedTurnEntry(turn.servers))
    return undefined;
  return registrar;
}

/**
 * The `transport` failure (69) for a registrar request that got no answer for
 * the reason `cause` names: `attempted` states what the request was for, the
 * catalog sentence states what happened, and `next` what this run leaves to
 * the operator. The cause is attached, so the remedy follows it.
 */
export function relayRegistrarUnreachableError(
  attempted: string,
  cause: FailureCauseOfKind<"relay-registrar-unreachable">,
  next: string,
): ConnectionError {
  return markFailureCause(
    new ConnectionError(
      `${attempted}. ${failureCauseSentence(cause)} ${next}`,
      "transport",
    ),
    cause,
  );
}
