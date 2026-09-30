import { sanitizeErrorForDisplay } from "@alcove/core";

import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { ManagedTermsUpdateNotAppliedError } from "@psi/managed/managedTermsUpdate";

import type {
  ManagedTermsUpdateApplyRefusal,
  ManagedTermsUpdateRefusal,
} from "@psi/managed/managedTermsUpdate";
import type { ColumnMetadata } from "@alcove/core";

export const CHANGE_TERMS_TITLE = "Change terms";

export const SENT_COLUMNS_LABEL = "Columns you send";

export const SENT_COLUMNS_TEXT =
  "Choose which of your columns this exchange sends your partner for matched " +
  "records. Saving changes the terms your next run states. Your partner's " +
  "next run asks them about the change, or stops where nobody is there to " +
  "answer, unless they applied a terms update from you first.";

export const SAVE_SENT_COLUMNS_LABEL = "Save columns";

export const SENT_COLUMNS_SAVED_TEXT =
  "Saved. Your next run sends these columns. Make a terms update and send " +
  "it to your partner to apply before then.";

/** Why a declared column's send choice is not offered, by its role. */
export function fixedColumnNote(column: ColumnMetadata): string {
  return column.role === "identifier"
    ? "Record identifier; changes with the linkage terms"
    : "Used to match; changes with the linkage terms";
}

/**
 * What the column choice says when a save did not complete: a run in flight
 * holds the exchange, or the write failed.
 */
export function sentColumnsFailureText(error: unknown): string {
  if (error instanceof ManagedExchangeLockUnavailableError)
    return (
      "A run of this exchange is in progress, so nothing was saved. Save " +
      "once it finishes."
    );
  return (
    "The columns could not be saved, and the exchange was not changed. " +
    "Reload the page and try again."
  );
}

export const SEND_TERMS_UPDATE_LABEL = "Send a terms update";

export const SEND_TERMS_UPDATE_TEXT =
  "A terms update states this exchange's linkage terms and the names of the " +
  "columns you send, and no secret. Your partner applies it on this " +
  "exchange's page in this app, or with alcove apply on the command line. " +
  "A partner who does not apply it is asked about the change at their next " +
  "run.";

export const MAKE_TERMS_UPDATE_LABEL = "Make a terms update";

export const TERMS_UPDATE_COPY_LABEL = "Terms update";

export const TERMS_UPDATE_COPY_HINT =
  "Send all of it to your partner, over any channel that delivers it " +
  "unchanged. A run between you replaces the secret it was made under, so " +
  "make a new one if a run happens before your partner applies it.";

export const TERMS_UPDATE_NOT_MADE_TEXT =
  "The terms update could not be made. Reload the page and try again.";

/** Why a terms update is not made or applied, by the reason
 * `managedTermsUpdateRefusal` gives. */
export const TERMS_UPDATE_WITHHELD_TEXT = {
  lapsed:
    "This exchange's shared secret has expired, so it cannot make or apply a " +
    "terms update. Re-invite your partner to run again.",
  "no-identity":
    "This exchange's terms name no identity for you, so it cannot make or " +
    "apply a terms update. Start a new exchange that names your agency.",
  "run-in-flight":
    "This exchange is running right now -- in this browser, in another tab, " +
    "or on its schedule. The run replaces the shared secret a terms update " +
    "is made and checked under, so make or apply one when it finishes.",
} as const satisfies Record<ManagedTermsUpdateRefusal, string>;

export const APPLY_TERMS_UPDATE_LABEL = "Apply a terms update";

export const APPLY_TERMS_UPDATE_TEXT =
  "Paste a terms update your partner made, in this app or with alcove " +
  "update. It is checked against this exchange's shared secret, and the " +
  "change it makes is shown before anything is saved.";

export const TERMS_UPDATE_INPUT_LABEL = "Terms update from your partner";

export const READ_TERMS_UPDATE_LABEL = "Check update";

export const TERMS_UPDATE_CHANGE_TEXT =
  "Your partner's terms in this update differ from the ones this exchange " +
  "holds, as shown below. Accept to save them to this exchange; your next " +
  "run uses them. Decline to leave the exchange as it is.";

export const TERMS_UPDATE_NO_CHANGE_TEXT =
  "Your partner's terms in this update match the ones this exchange holds. " +
  "Accept to save them to this exchange anyway, or Decline to leave it as " +
  "it is.";

export const TERMS_UPDATE_APPLIED_TEXT =
  "Applied. Your next run uses your partner's new terms.";

const NOTHING_CHANGED = "Nothing was changed.";

/** Why a partner's terms update was not applied, by the reason
 * `ManagedTermsUpdateNotAppliedError` gives. */
export const TERMS_UPDATE_NOT_APPLIED_TEXT = {
  ...TERMS_UPDATE_WITHHELD_TEXT,
  format:
    "This is not a terms update, or not all of one. " +
    `${NOTHING_CHANGED} Ask your partner to send the whole update again.`,
  partnership:
    "This terms update is for a different exchange, or was made under a " +
    "shared secret a run between you has since replaced. " +
    `${NOTHING_CHANGED} Ask your partner to make a new one from this ` +
    "exchange.",
  authentication:
    "This terms update names this exchange, but its content was changed " +
    `after your partner made it. ${NOTHING_CHANGED} Ask your partner to ` +
    "send it again.",
  "own-terms":
    "This terms update was made from your own terms for this exchange, not " +
    `your partner's. ${NOTHING_CHANGED} Send it to your partner to apply ` +
    "instead.",
  "not-applicable":
    "This terms update changes terms this exchange cannot take on here, " +
    `such as the columns used to match. ${NOTHING_CHANGED} Ask your ` +
    "partner about the change, or set up a new exchange on the new terms.",
  "not-runnable":
    "A run on the terms in this update would stop before it sent anything. " +
    `${NOTHING_CHANGED} Ask your partner about the change.`,
  changed:
    "This exchange changed after the update was checked. " +
    `${NOTHING_CHANGED} Check the update again to see the change as it ` +
    "now stands.",
} as const satisfies Record<ManagedTermsUpdateApplyRefusal, string>;

/**
 * What the apply control says when a terms update was not applied: the
 * reason it was refused, a run in flight holding the exchange, or a write
 * that failed. A `not-runnable` refusal adds core's message naming the rule
 * the terms break, the one `alcove apply` prints for the same update.
 */
export function termsUpdateNotAppliedText(error: unknown): string {
  if (error instanceof ManagedTermsUpdateNotAppliedError)
    return error.refusal === "not-runnable" && error.cause !== undefined
      ? `${TERMS_UPDATE_NOT_APPLIED_TEXT["not-runnable"]} The rule the ` +
          `terms break: ${sanitizeErrorForDisplay(error.cause)}`
      : TERMS_UPDATE_NOT_APPLIED_TEXT[error.refusal];
  if (error instanceof ManagedExchangeLockUnavailableError)
    return TERMS_UPDATE_WITHHELD_TEXT["run-in-flight"];
  return (
    "The terms update could not be saved to this exchange, and the " +
    "exchange was not changed. Reload the page and try again."
  );
}
