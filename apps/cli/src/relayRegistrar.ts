// Which relay registrar a CLI run registers at (infra/relay/README.md, The
// registrar). The request, its answer classification, and the enrollment made
// with the relay-owner token are core's (`relayRegistrarClient.ts`), shared
// with the web app, and re-exported here.

import {
  ConnectionError,
  failureCauseSentence,
  hasMintedTurnEntry,
  markFailureCause,
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
  REMOVED_EXCHANGE_ID_TEXT,
  sendRelayRegistration,
} from "@alcove/core";
export type {
  RelayRegistrarAnswer,
  RelayRegistrarTransport,
  RelayRegistrationOutcome,
} from "@alcove/core";

/**
 * The registrar a run registers its rotated relay key at: the connection's
 * `relay_registrar`, when one of this party's own `turn` entries has its
 * credential minted from the shared secret. A run lists its own entries
 * whether or not an invitation's relay is listed beside them, so that relay
 * does not change the answer. `undefined` otherwise.
 */
export function relayRegistrarForRun(
  connection: ConnectionConfig,
): RelayRegistrar | undefined {
  if (connection.channel !== "webrtc") return undefined;
  const registrar = connection.relayRegistrar;
  if (registrar === undefined || !hasMintedTurnEntry(connection.turn))
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
