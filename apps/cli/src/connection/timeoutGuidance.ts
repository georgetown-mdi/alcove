// The sentence a timed-out wait appends to say how to lengthen it.
// inactivity_timeout_ms has no flag, so the failure message is the operator's
// only pointer to it.

/**
 * Appended to a failure where a present partner, or the server between the
 * parties, stopped answering within the time inactivity_timeout_ms allows.
 */
export const INACTIVITY_TIMEOUT_GUIDANCE =
  "If the partner or server is only slow, raise inactivity_timeout_ms under " +
  "connection.options in the configuration";
