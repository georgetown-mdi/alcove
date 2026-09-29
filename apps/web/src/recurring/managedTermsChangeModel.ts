import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { ManagedTermsProposalNotStoredError } from "@psi/managed/managedTermsProposal";

/** The title over the question an attended run asks, and over the kept
 * proposal a scheduled run left. */
export const TERMS_CHANGE_QUESTION_TITLE =
  "Your partner's linkage terms changed";

/** The label of the control that takes the partner's changed terms on. */
export const ACCEPT_TERMS_CHANGE_LABEL = "Accept";

/** The label of the control that declines them. */
export const DECLINE_TERMS_CHANGE_LABEL = "Decline";

/** The label of the control that applies a kept proposal. */
export const APPLY_TERMS_PROPOSAL_LABEL = "Apply to this exchange";

/**
 * What the question an attended run asks says above the change: what
 * accepting does, which depends on whether this run can continue under the
 * new terms.
 */
export function termsChangeQuestionText(continuable: boolean): string {
  return continuable
    ? "Your partner's terms differ from the ones this exchange holds, as " +
        "shown below. Accept to save them to this exchange and continue this " +
        "run under them. Decline to stop this run and leave the exchange as " +
        "it is."
    : "Your partner's terms differ from the ones this exchange holds, as " +
        "shown below, including terms this run was prepared under. Accept to " +
        "save them to this exchange; this run then stops, and the next run " +
        "uses them. Decline to stop this run and leave the exchange as it is.";
}

/** What the kept proposal a scheduled run left says above the change. */
export const TERMS_PROPOSAL_TEXT =
  "A scheduled run stopped because your partner's terms differ from the " +
  "ones this exchange holds, as shown below. Apply them to save them to this " +
  "exchange, then run it again. Decline to leave the exchange as it is; its " +
  "runs stop the same way until your partner goes back to the agreed terms.";

/**
 * What the panel says when applying or declining a kept proposal did not
 * complete: a run in flight holds the exchange, the change shown is no longer
 * the stored one, or the write failed.
 */
export function termsProposalFailureText(error: unknown): string {
  if (error instanceof ManagedExchangeLockUnavailableError)
    return "A run of this exchange is in progress. Apply the change once it finishes.";
  if (error instanceof ManagedTermsProposalNotStoredError)
    return (
      "This change was already applied, declined, or replaced by a newer " +
      "one, and the exchange was not changed. Reload the page to see what " +
      "is waiting."
    );
  return (
    "The change could not be saved to this exchange, and the exchange was " +
    "not changed. Reload the page and try again, or re-invite your partner."
  );
}
