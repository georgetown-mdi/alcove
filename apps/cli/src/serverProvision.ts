import {
  callProvisionEndpoint,
  InternalConsistencyError,
  provisionEndpointLabel,
  provisionModeOf,
  provisionRequest,
  redactAndSanitizeForDisplay,
  requestProvisionedServerAddress,
  serverProvisionOf,
} from "@alcove/core";
import type {
  ConnectionConfig,
  ProvisionedServerAddress,
  ServerProvision,
} from "@alcove/core";

import { resolveServerProvisionAtSignRefs } from "./util/atSignRefs";

/**
 * The start-mode `server.provision` block a run wakes its server through, or
 * `undefined` when the connection states none or a create-mode one, whose
 * address `alcove invite` already wrote into `server`.
 */
export function startModeProvisionOf(
  connection: ConnectionConfig,
): ServerProvision | undefined {
  const provision = serverProvisionOf(connection);
  if (provision === undefined || provisionModeOf(provision) !== "start")
    return undefined;
  return provision;
}

/**
 * The start-mode block `connection` states, in the form `read` holds it: the
 * same block from `--server-provision` with its auth `@path` references read
 * at argument parsing (`serverProvisionRead`), while the connection keeps the
 * references so the configuration it saves records them and not the secret.
 * `undefined` when the connection states no start-mode block. A block the
 * connection states with no `read` is an {@link InternalConsistencyError}
 * rather than a wake call sending an unread reference.
 */
export function startModeProvisionAsRead(
  connection: ConnectionConfig,
  read: ServerProvision | undefined,
): ServerProvision | undefined {
  if (startModeProvisionOf(connection) === undefined) return undefined;
  if (read === undefined)
    throw new InternalConsistencyError(
      "internal error: the connection states a server.provision block whose " +
        "credential references were not read",
    );
  return read;
}

/**
 * Send the wake call a start-mode block states, once, before the run's first
 * connection to the server; a no-op on `undefined`. The block's auth must
 * already hold values rather than `@path` references. Rejects with the
 * classified failure {@link callProvisionEndpoint} raises, which the caller's
 * exit boundary maps to 64 or 69.
 */
export async function wakeServerThrough(
  provision: ServerProvision | undefined,
  log: { info: (message: string) => void },
): Promise<void> {
  if (provision === undefined) return;
  // Validated before the log line below, so a block callProvisionEndpoint
  // would refuse (an invalid host, say) is never announced as a wake under
  // way; callProvisionEndpoint's own call to this is redundant but cheap and
  // pure, and keeps the request-building logic in one place.
  provisionRequest(provision);
  log.info(
    `waking the server through ${redactAndSanitizeForDisplay(provisionEndpointLabel(provision))}`,
  );
  await callProvisionEndpoint(provision);
}

/**
 * {@link wakeServerThrough} for a connection whose `@path` references were
 * already read, as `alcove exchange` reads them at configuration load.
 */
export async function wakeProvisionedServer(
  connection: ConnectionConfig,
  log: { info: (message: string) => void },
): Promise<void> {
  await wakeServerThrough(startModeProvisionOf(connection), log);
}

/**
 * Have a connection's create-mode `server.provision` endpoint make a new
 * server, and resolve to the address it returns; `undefined` when the
 * connection states no block or a start-mode one. The block's auth `@path`
 * references are read here, since the invite reads its connection block
 * without resolving them. Rejects with the classified failure
 * {@link requestProvisionedServerAddress} raises.
 */
export async function createProvisionedServer(
  connection: ConnectionConfig,
  log: { info: (message: string) => void },
): Promise<ProvisionedServerAddress | undefined> {
  const stated = serverProvisionOf(connection);
  if (stated === undefined || provisionModeOf(stated) !== "create")
    return undefined;
  const provision = resolveServerProvisionAtSignRefs(stated);
  provisionRequest(provision);
  log.info(
    `creating a server through ${redactAndSanitizeForDisplay(provisionEndpointLabel(provision))}`,
  );
  return requestProvisionedServerAddress(provision);
}
