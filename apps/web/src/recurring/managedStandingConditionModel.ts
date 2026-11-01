/**
 * The pure display derivation for a record's standing condition: the unanswered
 * evidence that this device's secret may no longer be the partnership's, kept
 * beside the run bookkeeping so a later no-show or a later success does not carry
 * it off (see docs/spec/MANAGED_EXCHANGE_RECORD.md, the `standingCondition` row).
 *
 * This is the condition's OWN surface, not a reading of the last run: it renders
 * wherever one stands, including on a record whose last run succeeded, and it
 * holds the clearance the operator reaches from a page where the condition has
 * gone unanswered. What clears a condition, and why a successful run is not one
 * of them, is
 * docs/MANAGED_EXCHANGE.md, "A standing condition outlives the run that raised
 * it"; the two-outcome gate the unexplained tier routes through is the one the
 * live Tier-2 failure uses ({@link ../psi/managed/managedFailureConfirmation.ts}).
 *
 * No React and no store: the copy is composed from the record's own local fields,
 * so it is unit-testable in Node and the component stays thin over it.
 */

import {
  PARTNER_SECRET_NOT_SAVED_KEPT_CLOSING,
  PARTNER_SECRET_NOT_SAVED_KEPT_REMEDY,
  PARTNER_SECRET_NOT_SAVED_PROBLEM,
  PARTNER_SECRET_NOT_SAVED_SUCCEEDED_SINCE,
  PARTNER_SECRET_NOT_SAVED_TITLE,
} from "@psi/managed/managedFailureCopy";
import {
  managedStandingConditionTier,
  partnerStorageReach,
} from "@psi/managed/managedFailureTiers";
import { raisedStandingCondition } from "@psi/managed/managedExchangeRecord";

import { dateTimeLabel } from "@psi/formatting";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managed/managedLocalStateShape";
import type { ManagedStandingTier } from "@psi/managed/managedFailureTiers";

/** How the operator clears a standing condition from the exchange's page.
 *
 * - `"confirmation"` -- through the two-outcome gate: a partner who confirms
 *   their identity and a real failure on their side clears it, and anything that
 *   does not add up does not, routing to the compromise response instead. The one
 *   tier where a failed-closed handshake has no benign explanation, so the
 *   operator's out-of-band work is what settles it.
 * - `"acknowledge"` -- with the short control below the copy. A tier whose
 *   explanation the record already holds gets no attack checklist
 *   (docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack"), so
 *   acknowledging what it states is the whole of it. */
export type ManagedStandingClearance = "confirmation" | "acknowledge";

/** The standing condition as the exchange's page renders it. */
export interface ManagedStandingConditionView {
  /** The tier the condition resolves to. The page compares it against the state
   * a live run's own failure landed on: where the two are the same, that state
   * already carries this recovery, and a second copy of it beside the first would
   * offer the operator two of every control. */
  tier: ManagedStandingTier;
  /** The alert's title: the state, not a verdict on who caused it. */
  title: string;
  /** What stands, since when, and what resolves it. */
  message: string;
  /** How the operator clears it from this page. */
  clearance: ManagedStandingClearance;
  /** When the re-invite recovery beside it applies: `"if-runs-keep-failing"`
   * where the message names the next run as the step, `"none"` where a run
   * since then succeeded, and now where absent. */
  reinvite?: "if-runs-keep-failing" | "none";
}

/** The label on the acknowledge control. Short, and it states what the click
 * does rather than what the operator believes: the record keeps no account of
 * why a condition was cleared. */
export const STANDING_CONDITION_CLEAR_LABEL = "Clear this";

/** The line every tier ends on: the condition outlives the runs after it, so an
 * operator does not read a state nothing has answered as settled. */
const STANDS_UNTIL =
  "Runs since then do not settle it, including any that succeeded.";

/**
 * The standing condition's view for a record, or `undefined` for a record holding
 * none. The instant is the condition's own `since` -- the run that raised it --
 * never the last run's, which may since be a no-show or a success.
 *
 * `local` supplies the import marker, which decides whether a restore since the
 * last success explains a failed-closed handshake. The tiering itself is the
 * record modules' ({@link managedStandingConditionTier}), so this surface and the
 * failure tiers cannot disagree about what a condition means. `now` decides
 * whether the record's previous secret would still be offered
 * ({@link partnerStorageReach}).
 */
export function managedStandingConditionView(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedStandingConditionView | undefined {
  const condition = raisedStandingCondition(record);
  if (condition === undefined) return undefined;
  const when = dateTimeLabel(new Date(condition.since));
  const tier = managedStandingConditionTier(condition, local);
  switch (tier) {
    case "storage":
      return {
        tier,
        title: "A run could not save this exchange's new secret",
        message:
          `A run on ${when} changed this exchange's secret and could not save ` +
          "the change, so your partner may hold a secret this device does not. " +
          `Re-invite your partner to reconnect. ${STANDS_UNTIL}`,
        clearance: "acknowledge",
      };
    case "partner-storage":
      return partnerStorageView(record, when, now);
    case "imported":
      return {
        tier,
        title: "This exchange was restored from a backup or key file",
        message:
          `A run on ${when} could not verify your partner, and this exchange ` +
          "was restored from a backup or key file since its last successful " +
          "run. Such a secret can " +
          "be one your partnership has rotated past, which explains it. " +
          `Re-invite your partner to reconnect. ${STANDS_UNTIL}`,
        clearance: "acknowledge",
      };
    default:
      return {
        tier,
        title: "A run failed and has not been explained",
        message:
          `A run on ${when} connected but could not verify your partner, and ` +
          "nothing on this device explains why. That can be an ordinary " +
          "problem on your partner's side - or a sign someone is interfering, " +
          "which is why it is still here: confirm with your partner before you " +
          `re-invite them. ${STANDS_UNTIL}`,
        clearance: "confirmation",
      };
  }
}

/** The partner-storage condition's view, by what the record can still do
 * ({@link partnerStorageReach}). */
function partnerStorageView(
  record: ManagedExchangeRecord,
  when: string,
  now: number,
): ManagedStandingConditionView {
  const stopped = `A run on ${when} stopped because ${PARTNER_SECRET_NOT_SAVED_PROBLEM}.`;
  const base = {
    tier: "partner-storage" as const,
    title: PARTNER_SECRET_NOT_SAVED_TITLE,
    clearance: "acknowledge" as const,
  };
  switch (partnerStorageReach(record, now)) {
    case "succeeded-since":
      return {
        ...base,
        message: `${stopped} ${PARTNER_SECRET_NOT_SAVED_SUCCEEDED_SINCE}`,
        reinvite: "none",
      };
    case "kept":
      return {
        ...base,
        message:
          `${stopped} ${PARTNER_SECRET_NOT_SAVED_KEPT_REMEDY} ` +
          PARTNER_SECRET_NOT_SAVED_KEPT_CLOSING,
        reinvite: "if-runs-keep-failing",
      };
    case "not-kept":
      return {
        ...base,
        message:
          `${stopped} Scheduled runs keep running but cannot reach your ` +
          "partner, and running the exchange again cannot either. Re-invite " +
          `your partner to reconnect. ${STANDS_UNTIL}`,
      };
  }
}
