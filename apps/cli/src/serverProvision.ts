import {
  callProvisionEndpoint,
  provisionEndpointLabel,
  provisionRequest,
  redactAndSanitizeForDisplay,
  serverProvisionOf,
} from "@alcove/core";
import type { ConnectionConfig } from "@alcove/core";

/**
 * Send the wake call a connection's `server.provision` block states, once,
 * before the run's first connection to the server; a no-op when it states
 * none. Rejects with the classified failure {@link callProvisionEndpoint}
 * raises, which the caller's exit boundary maps to 64 or 69.
 */
export async function wakeProvisionedServer(
  connection: ConnectionConfig,
  log: { info: (message: string) => void },
): Promise<void> {
  const provision = serverProvisionOf(connection);
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
