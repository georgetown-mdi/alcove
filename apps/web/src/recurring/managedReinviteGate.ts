/**
 * Why the exchange's page is not offering a fresh invitation. Both re-invite
 * controls read these -- the failure recovery's near the top and the
 * configuration section's far below -- so the operator meets the same words
 * whichever one they reached for, and a withheld control says what withheld it
 * rather than sitting inert.
 *
 * The two withhold for different lengths of time. A run in flight is a wait: the
 * control comes back when the run ends, whatever its outcome, and a run of this
 * window still waiting for its partner can be stopped
 * ({@link ./managedRunHolder.ts} holds that copy). A standing compromise
 * response is not waited out -- it ends only when one of the three acts that
 * clear a standing condition clears it (see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `standingCondition` row).
 */

/**
 * The operator answered a failure gate "something does not add up", so this
 * channel is the one they flagged. Shown where a control was withheld away from
 * the response's own copy, which states the rest of what to do.
 */
export const REINVITE_COMPROMISE_REASON =
  "You answered that something does not add up, so no fresh invitation is " +
  "offered on this channel. Reach your partner on a different trusted channel " +
  "first.";
