import {
  callProvisionEndpoint,
  provisionEndpointLabel,
  provisionModeOf,
  provisionRequest,
  redactAndSanitizeForDisplay,
  requestProvisionedServerAddress,
  serverProvisionOf,
} from "@alcove/core";
import type { ConnectionConfig, ProvisionedServerAddress } from "@alcove/core";

import { resolveServerProvisionAtSignRefs } from "./util/atSignRefs";

/**
 * Send the wake call a connection's start-mode `server.provision` block
 * states, once, before the run's first connection to the server; a no-op when
 * it states none or a create-mode one, whose address `alcove invite` already
 * wrote into `server`. Rejects with the classified failure
 * {@link callProvisionEndpoint} raises, which the caller's exit boundary maps
 * to 64 or 69.
 */
export async function wakeProvisionedServer(
  connection: ConnectionConfig,
  log: { info: (message: string) => void },
): Promise<void> {
  const provision = serverProvisionOf(connection);
  if (provision === undefined || provisionModeOf(provision) !== "start") return;
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
