import { matchingKeyUnavailableReason } from "@alcove/core";

import type {
  Algorithm,
  LinkageStrategy,
  MatchingKeyUnavailableReason,
  Output,
} from "@alcove/core";

/**
 * The pure model behind the authoring surface's "Name the key each match was
 * made on" control: whether the exchange being authored can write the column,
 * why not where it cannot, and the config field the choice contributes. No
 * React and no I/O.
 *
 * The setting is LOCAL: it adds a last `matched_on_key` column to this party's
 * OWN result file (core's `include_matching_key`); nothing is added to what the
 * partner receives, to either party's consent display, or to the agreed terms.
 * See docs/EXCHANGE_REFERENCE.md, `include_matching_key`.
 */

/** The terms the control is graded against. */
export interface MatchingKeyTerms {
  algorithm: Algorithm;
  linkageStrategy: LinkageStrategy;
  output: Output;
}

/**
 * Why the column cannot be written for these terms, or `undefined` where it
 * can: core's own predicate, so the control offers exactly what the config
 * parse admits.
 */
export function matchingKeyWithheldReason(
  terms: MatchingKeyTerms,
): MatchingKeyUnavailableReason | undefined {
  return matchingKeyUnavailableReason(terms);
}

/**
 * The config field the choice contributes to this party's exchange document:
 * `includeMatchingKey: true` where the operator turned it on and the terms
 * admit it, and nothing otherwise. The same predicate gates the control and
 * the emission, so an operator who turned it on and then made the exchange
 * count-only or single-pass, or handed the result to the partner alone,
 * composes no key rather than one the config parse refuses.
 */
export function matchingKeyField(
  chosen: boolean | undefined,
  terms: MatchingKeyTerms,
): { includeMatchingKey?: true } {
  if (chosen !== true || matchingKeyWithheldReason(terms) !== undefined)
    return {};
  return { includeMatchingKey: true };
}

/** The control's label. */
export const MATCHING_KEY_LABEL = "Name the linkage key each match was made on";

/** What the control adds, stated at the control. */
export const MATCHING_KEY_DESCRIPTION =
  "Adds a last column, matched_on_key, to your result file, so a match made " +
  "on your most precise key can be told from one made on a later, looser key.";

/** What the control says the setting does NOT do. */
export const MATCHING_KEY_LOCAL_NOTICE =
  "This choice changes only the result file this run writes for you. Your " +
  "partner is sent nothing extra, sees no change in what they agree to, and " +
  "their own result file is untouched.";

/** Why the control is unavailable, in the order core grades the reasons:
 * what happened, then what to do where the operator can act. */
export const MATCHING_KEY_WITHHELD_COPY: Record<
  MatchingKeyUnavailableReason,
  string
> = {
  "count-only":
    "Not available: this exchange reveals only the count of matches and " +
    "writes no result file. Choose to reveal the matched identifiers to turn " +
    "this on.",
  "single-pass":
    "Not available with the single-pass linkage strategy, where the party " +
    "that sends its records first is not told which key matched. Choose the " +
    "cascade strategy to turn this on.",
  "no-output":
    "Not available: only your partner receives the results, so no result " +
    "file is written for you. Choose to receive the results yourself to turn " +
    "this on.",
};

/** Why the control is unavailable on a stored exchange, whose terms are not
 * edited where the control is: what happened, and the agreed terms that
 * would need to change. */
export const MATCHING_KEY_STORED_WITHHELD_COPY: Record<
  MatchingKeyUnavailableReason,
  string
> = {
  "count-only":
    "Not available: this exchange reveals only the count of matches and " +
    "writes no result file. It is available on terms that reveal the " +
    "matched identifiers.",
  "single-pass":
    "Not available with the single-pass linkage strategy, where the party " +
    "that sends its records first is not told which key matched. It is " +
    "available on terms that use the cascade strategy.",
  "no-output":
    "Not available: only your partner receives the results, so no result " +
    "file is written for you. It is available on terms that give you the " +
    "results.",
};

/** Why a terms change turned the setting off, completing "because". */
const MATCHING_KEY_TURNED_OFF_BECAUSE: Record<
  MatchingKeyUnavailableReason,
  string
> = {
  "count-only":
    "the new terms reveal only the count of matches and write no result file",
  "single-pass":
    "the new terms use the single-pass linkage strategy, where the party " +
    "that sends its records first is not told which key matched",
  "no-output":
    "under the new terms only your partner receives the results, so no " +
    "result file is written for you",
};

/**
 * What a partner's terms change says about the setting it turns off: before
 * it is accepted or applied (`will`), and once it has been (`did`).
 */
export function matchingKeyTurnedOffNotice(
  reason: MatchingKeyUnavailableReason,
  when: "will" | "did",
): string {
  const lead =
    when === "will"
      ? "This change also turns off the setting to name the linkage key each " +
        "match was made on"
      : "The setting to name the linkage key each match was made on was " +
        "turned off";
  return `${lead}, because ${MATCHING_KEY_TURNED_OFF_BECAUSE[reason]}.`;
}
