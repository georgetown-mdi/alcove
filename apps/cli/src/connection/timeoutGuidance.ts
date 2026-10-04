// The sentence a timed-out wait appends to name the setting that bounds it.
// inactivity_timeout_ms has no flag, so the failure message is the operator's
// only pointer to it. A partner that never arrived is named through core's
// failure-cause catalog instead, with the remedy in ../failureRemedy.ts.

/**
 * Appended to a failure where a present partner, or the server between the
 * parties, stopped answering within the peer-inactivity budget.
 */
export const INACTIVITY_TIMEOUT_GUIDANCE =
  "inactivity_timeout_ms under connection.options in the configuration sets " +
  "how long this wait lasts";
