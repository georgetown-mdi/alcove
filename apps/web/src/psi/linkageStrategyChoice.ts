/**
 * The one copy for a linkage-strategy authoring control, shared by the two
 * surfaces that offer the choice: the invitation flow's key editor
 * ({@link ../exchange/KeysTab}) and the console's Direct-exchange confirm screen
 * ({@link ../exchange/DirectConfirmSection}).
 *
 * The disclosure note is the consent-critical half of the choice -- its body
 * is {@link SINGLE_PASS_TERMS_STATEMENT}, the words the partner reads again on
 * the terms panel -- so both surfaces must state it in the same words.
 */

import type { LinkageStrategy } from "@alcove/core";

/** The label the choice is offered under, matching the caption the terms panel
 * shows the selected value beside. */
export const LINKAGE_STRATEGY_LABEL = "Linkage strategy";

/** What each strategy does, as the option's own description. Keyed by the schema
 * enum so a strategy added to core leaves this incomplete at the type level. */
export const LINKAGE_STRATEGY_OPTION_COPY: Record<
  LinkageStrategy,
  { label: string; description: string }
> = {
  cascade: {
    label: "Cascade",
    description:
      "Keys run in order; a record matched by an earlier key is settled and " +
      "never re-exposed to later, broader keys.",
  },
  "single-pass": {
    label: "Single-pass",
    description: "All keys run over all records at once.",
  },
};

/** The disclosure note's heading, shown when single-pass is selected. */
export const SINGLE_PASS_DISCLOSURE_TITLE =
  "Single-pass widens what one of you can observe";

/**
 * What the terms panel states under the linkage strategy for terms that run
 * single-pass, the inviter's review restates for the same terms, and the
 * authoring alert shows when single-pass is selected.
 */
export const SINGLE_PASS_TERMS_STATEMENT =
  "This exchange matches in a single pass. That means one of you sends the " +
  "other everything it prepared for every linkage key at once, so that party " +
  "also sees matches on the weaker keys, not only the strongest. Which of you " +
  "sends is decided when the exchange runs, so it may be you. Both parties " +
  "must agree to single-pass. The matched result is the same either way; " +
  "what differs is how much your partner can observe while it runs.";
