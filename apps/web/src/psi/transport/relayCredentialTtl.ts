import { RELAY_CREDENTIAL_MAX_TTL_SECONDS } from "@alcove/core";

/**
 * Lifetime of the relay credential a run mints. It must outlast the peer wait
 * (`DEFAULT_PEER_WAIT_TIMEOUT_MS` in `./waitForConnection`) and the exchange
 * after it, and core refuses anything over one hour, so it is that ceiling. A
 * module of its own, so the default relay's enrollment reads it without
 * loading the rendezvous.
 */
export const RELAY_CREDENTIAL_TTL_SECONDS = RELAY_CREDENTIAL_MAX_TTL_SECONDS;
