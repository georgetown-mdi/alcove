// The sentences a timed-out wait appends to name the setting that bounds it.
// inactivity_timeout_ms has no flag, so the failure message is the operator's
// only pointer to it.

/**
 * Appended to a failure where the partner did not arrive in time. An online
 * `alcove invite` bounds that wait by --accept-timeout instead, so both are
 * named.
 */
export const PEER_TIMEOUT_GUIDANCE =
  "--peer-timeout sets how long to wait for a partner to arrive, or " +
  "--accept-timeout for an online invitation";

/**
 * Appended to a failure where a present partner, or the server between the
 * parties, stopped answering within the peer-inactivity budget.
 */
export const INACTIVITY_TIMEOUT_GUIDANCE =
  "inactivity_timeout_ms under connection.options in the configuration sets " +
  "how long this wait lasts";
