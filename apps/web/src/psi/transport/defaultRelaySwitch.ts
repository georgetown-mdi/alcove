/**
 * The words of the switch, in an exchange's Connection settings, that turns
 * on a default relay the build offers switched off
 * (`VITE_DEFAULT_RELAY_MODE=opt-in`), and of the failure alerts that point at
 * it. Which relay a run then lists: ./defaultRelay.ts.
 */

/** The switch's label. */
export const DEFAULT_RELAY_SWITCH_LABEL = "Use this site's relay server";

/**
 * What the failure alert of an inviter's run whose connection did not open
 * adds to its own message where the build offers its default relay switched
 * off, the run did not list it, and the run's allowed relays keep it
 * (`failedWithDefaultRelayOff` in ./iceGathering.ts).
 */
export const INVITER_DEFAULT_RELAY_OFF_REMEDY =
  "This exchange does not use this site's relay server. If a network " +
  "blocks direct connections, choose Start over with a fresh invitation, " +
  "turn it on under Connection settings, and send your partner the new " +
  "invitation.";

/** The same, for an accepting party's run. */
export const ACCEPTOR_DEFAULT_RELAY_OFF_REMEDY =
  "This exchange does not use this site's relay server. If a network " +
  "blocks direct connections, reload this page, turn it on under " +
  "Connection settings, and accept the invitation again.";
