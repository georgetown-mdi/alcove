/**
 * Notification copy shared between the next-visit alert and the unattended
 * runner's between-visit notification: the repeated-miss coordination state
 * (threshold, title, and the two phrasings every surface that reports repeated
 * misses holds), the title over each recorded failure tier, and the
 * single-column shortfall's delimiter remedy.
 *
 * It sits below the product directories because two readers need it and they are
 * in different layers: the saved-exchanges list and the per-exchange detail view
 * read the repeated-miss state through
 * {@link ../../recurring/scheduleSurfacingModel.ts}, the next-visit alert reads
 * the failure titles through {@link ../../recurring/managedRunLaunchModel.ts},
 * and the unattended runner's between-visit notification
 * ({@link ./betweenVisitNotice.ts}) reads both directly -- `psi/` cannot import
 * `recurring/`. One definition of each is what keeps the notification and the
 * next visit saying the same thing.
 *
 * Pure: the record's `consecutiveMisses` is read verbatim, and nothing here
 * advances or anticipates a write the runner has not made.
 */

import { MAX_WEBRTC_FRAME_BYTES } from "@alcove/core";

import type {
  ManagedExchangeSchedule,
  TooLargeReading,
} from "./managedExchangeRecord";

/**
 * The consecutive-miss count at which a surface escalates from naming the last
 * run's outcome to the coordination prompt. Normative value and the reasoning
 * behind it: docs/spec/MANAGED_EXCHANGE_RECORD.md, the `consecutiveMisses` row,
 * and docs/MANAGED_EXCHANGE.md, "Retry and repeated misses".
 */
export const REPEATED_MISS_ESCALATION = 2;

/** The escalated coordination state, phrased for every surface: the list's quiet
 * line, the notification's body, and the detail view's prompt. */
export interface RepeatedMissCoordination {
  /** The consecutive-miss count the record holds, at or above
   * {@link REPEATED_MISS_ESCALATION}. */
  misses: number;
  /** The one-line form: the state and both checks, deferring the rest to the
   * exchange's own surface. */
  line: string;
  /** The detail view's coordination prompt. */
  prompt: string;
}

/** The title over the coordination state. It names the state, not a fault: which
 * side was absent is exactly what the record cannot know. */
export const REPEATED_MISS_TITLE = "Runs are not happening on schedule";

/**
 * The coordination state a run of missed windows earns, or `undefined` below
 * the escalation threshold (a single miss demands nothing beyond the last
 * run's own outcome). Both phrasings name BOTH checks, the partner and this
 * device's own clock, since a drifted clock produces exactly this pattern;
 * neither offers to pause anything -- the agreed cadence stands
 * (docs/MANAGED_EXCHANGE.md, "Repeated misses surface, they do not
 * auto-pause").
 */
export function repeatedMissCoordination(
  schedule: ManagedExchangeSchedule,
): RepeatedMissCoordination | undefined {
  const misses = schedule.consecutiveMisses;
  if (misses < REPEATED_MISS_ESCALATION) return undefined;
  return {
    misses,
    line: `${misses} scheduled runs in a row have not happened; check with your partner, and check this device's clock.`,
    prompt: `${misses} scheduled runs in a row have not happened. Ask your partner whether they are still running this exchange, and check this device's clock -- if it is wrong, your run window and theirs never overlap. Nothing has been paused: the schedule stands, and the count resets after a successful run.`,
  };
}

/** The title over the benign input failure tier. */
export const INPUT_FAILURE_TITLE = "Your input file could not be used";

/** The title over the benign linkage-shortfall failure tier. */
export const TERMS_SHORTFALL_FAILURE_TITLE =
  "Your input file cannot match on everything this exchange agreed to";

/** The title over the benign terms-change failure tier. */
export const TERMS_CHANGE_FAILURE_TITLE =
  "Your partner's linkage terms changed";

/** The bound one WebRTC message holds, as the too-large copy states it. */
export const WEBRTC_MESSAGE_BOUND_LABEL = `${(
  MAX_WEBRTC_FRAME_BYTES /
  (1024 * 1024)
).toString()} MiB`;

/** What happened to the set a too-large failure refused, completing a
 * sentence whose subject is the set: over the bound the reading names, not
 * counted, or too large with no bound named. Shared by the next-visit alert
 * and the between-visit notification. */
export function tooLargeSetProblem(reading: TooLargeReading): string {
  if (reading.setUncounted === true) return "could not be counted";
  switch (reading.tooLargeBound) {
    case "partner-ceiling":
      return "was over the most values your partner can receive";
    case "webrtc-message":
      return `was over the ${WEBRTC_MESSAGE_BOUND_LABEL} one WebRTC message can hold`;
    case undefined:
      return "was too large";
  }
}

/** What stopped a too-large run, as a lowercase clause about this party's
 * file. */
export function tooLargeFailureClause(reading: TooLargeReading): string {
  if (reading.setUncounted === true)
    return "the values built from your file could not be counted";
  switch (reading.tooLargeBound) {
    case "partner-ceiling":
      return "your file is too large for your partner to receive";
    case "webrtc-message":
      return "your file is too large for a browser exchange";
    case undefined:
      return "your file is too large to send";
  }
}

/** The title over a too-large failure; shared by the one-shot exchange, a
 * managed run's live refusal, and the record read back. */
export function tooLargeFailureTitle(reading: TooLargeReading): string {
  const clause = tooLargeFailureClause(reading);
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/** The set a too-large failure refused, in the words the next-visit alert and
 * the between-visit notification both state it in. */
export const TOO_LARGE_SET_SOURCE =
  "the set of values built from your input file";

/** The too-large tier's remedy, in the words the next-visit alert and the
 * between-visit notification both state it in. */
export const TOO_LARGE_REMEDY =
  "Split your input into smaller files and set up one exchange for each.";

/** The title over the interrupted-rotation failure tier. */
export const PARTIAL_ROTATION_FAILURE_TITLE =
  "This exchange is probably out of sync with your partner";

/** The title over the Tier-2 unexplained failure tier. */
export const UNEXPLAINED_FAILURE_TITLE =
  "This run failed and needs you to check with your partner";

/**
 * The remedy for a shortfall whose input file read as ONE column, in the words
 * every managed surface states it in: the next-visit alert
 * ({@link ../../recurring/managedRunLaunchModel.ts}) and the between-visit
 * notification ({@link ./betweenVisitNotice.ts}).
 *
 * It names the control by its label and the section holding it, since the
 * notification is read away from the exchange's page.
 */
export const SINGLE_COLUMN_DELIMITER_REMEDY =
  "Its fields may be separated by a character other than the one this " +
  "exchange reads it with. Save the input file with that separator, or " +
  'change "How your file separates fields" in this exchange\'s local ' +
  "settings to your file's separator.";

/** The title over a refusal of a partner's set larger than this browser can
 * match; shared by the one-shot exchange, a managed run's alert, and the
 * between-visit notification. */
export const PARTNER_SET_TOO_LARGE_TITLE =
  "Your partner's set is too large for this browser";

/** What stopped a run refused for its partner's set, completing a sentence
 * that ends "stopped because". */
export const PARTNER_SET_TOO_LARGE_PROBLEM =
  "your partner's set of values for a linkage key is larger than this " +
  "browser can match";

/** The remedy for a partner's set larger than this browser can match, in the
 * words the next-visit alert and the between-visit notification both state it
 * in. */
export const PARTNER_SET_TOO_LARGE_REMEDY =
  "Run this exchange with the command-line application, or ask your " +
  "partner to split their input into smaller files and set up one " +
  "exchange for each.";
