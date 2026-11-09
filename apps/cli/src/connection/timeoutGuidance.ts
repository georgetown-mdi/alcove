// The sentence a timed-out wait appends to say how to lengthen it: the
// --inactivity-timeout flag for the next run, or the configuration key it
// overrides.

import { INACTIVITY_TIMEOUT_KEY } from "@alcove/core";
import type { InactivityLimitSource } from "@alcove/core";

/** The flag that sets {@link INACTIVITY_TIMEOUT_KEY} for one run. */
export const INACTIVITY_TIMEOUT_FLAG = "--inactivity-timeout";

/**
 * What to raise for a slow partner. A message whose limit clause already names
 * the setting gets "that limit", so the setting is named once per message.
 */
export const raiseInactivityLimit = (limitNamed: boolean): string =>
  `run again with a longer ${INACTIVITY_TIMEOUT_FLAG}, or raise ` +
  `${limitNamed ? "that limit" : INACTIVITY_TIMEOUT_KEY} under ` +
  "connection.options in the configuration";

/**
 * Appended to a failure where a present partner, or the server between the
 * parties, stopped answering within the time the connection allows.
 */
export const inactivityTimeoutGuidance = (
  limit: InactivityLimitSource,
): string =>
  "If the partner or server is only slow, " +
  raiseInactivityLimit(limit === "setting");

/** The guidance for a message whose limit clause names the setting. */
export const INACTIVITY_TIMEOUT_GUIDANCE = inactivityTimeoutGuidance("setting");
