// The sentence a timed-out wait appends to say how to lengthen it.
// inactivity_timeout_ms has no flag, so the failure message is the operator's
// only pointer to it.

import { INACTIVITY_TIMEOUT_KEY } from "@alcove/core";

/**
 * What to raise for a slow partner. A message whose limit clause already names
 * the setting gets "that limit", so the setting is named once per message.
 */
export const raiseInactivityLimit = (limitNamed: boolean): string =>
  `raise ${limitNamed ? "that limit" : INACTIVITY_TIMEOUT_KEY} under ` +
  "connection.options in the configuration";

/**
 * Appended to a failure where a present partner, or the server between the
 * parties, stopped answering within the time inactivity_timeout_ms allows.
 */
export const inactivityTimeoutGuidance = (limitNamed: boolean): string =>
  `If the partner or server is only slow, ${raiseInactivityLimit(limitNamed)}`;

/** The guidance for a message whose limit clause names the setting. */
export const INACTIVITY_TIMEOUT_GUIDANCE = inactivityTimeoutGuidance(true);
