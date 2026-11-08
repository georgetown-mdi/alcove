/**
 * The TURN entry of a browser run's ICE server list, and the credential it
 * holds. A module of its own so that the relay check presents the run's own
 * entry while a test stubbing `./rendezvous` leaves it in place.
 */

import {
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  deriveRelayKey,
  mintRelayCredential,
} from "@alcove/core";

/**
 * Lifetime of the relay credential a run mints. It must outlast the peer wait
 * (`DEFAULT_PEER_WAIT_TIMEOUT_MS` in ./waitForConnection.ts) and the exchange
 * after it, and core refuses anything over one hour, so it is that ceiling.
 */
export const RELAY_CREDENTIAL_TTL_SECONDS = RELAY_CREDENTIAL_MAX_TTL_SECONDS;

/** The label in a minted credential's username, `<expiry>:<label>`. */
const RELAY_CREDENTIAL_LABEL = "alcove";

/**
 * The ICE server entry of `turn`, holding the credential a run mints at `now`
 * from the relay key the exchange's shared secret derives: the entry
 * `buildIceServers` in ./rendezvous.ts lists, and the one the relay check
 * presents.
 */
export async function turnIceServer(
  turn: ReadonlyArray<string>,
  sharedSecret: string,
  now: Date,
): Promise<RTCIceServer> {
  const { username, credential } = await mintRelayCredential({
    key: await deriveRelayKey(sharedSecret),
    label: RELAY_CREDENTIAL_LABEL,
    ttlSeconds: RELAY_CREDENTIAL_TTL_SECONDS,
    now,
  });
  return { urls: [...turn], username, credential };
}
