import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";

import type { ColumnMetadata } from "@alcove/core";

/** The heading over the section that changes a saved exchange's terms. */
export const CHANGE_TERMS_TITLE = "Change terms";

/** The label over the column choice. */
export const SENT_COLUMNS_LABEL = "Columns you send";

/** What the column choice says above the columns. */
export const SENT_COLUMNS_TEXT =
  "Choose which of your columns this exchange sends your partner for matched " +
  "records. Saving changes the terms your next run states. Your partner's " +
  "next run asks them about the change, or stops where nobody is there to " +
  "answer, unless they applied a terms update from you first.";

/** The label of the control that saves the column choice. */
export const SAVE_SENT_COLUMNS_LABEL = "Save columns";

/** What the column choice says once a save completed. */
export const SENT_COLUMNS_SAVED_TEXT =
  "Saved. Your next run sends these columns. If your partner uses the " +
  "command line, make a terms update and send it to them.";

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

/** The label over the send part. */
export const SEND_TERMS_UPDATE_LABEL = "Send a terms update";

/** What the send part says above its control. */
export const SEND_TERMS_UPDATE_TEXT =
  "A terms update states this exchange's linkage terms and the names of the " +
  "columns you send, and no secret. A partner on the command line applies " +
  "it with alcove apply. A partner using this app is asked about the change " +
  "at their next run, and does not need the update.";

/** The label of the control that makes a terms update. */
export const MAKE_TERMS_UPDATE_LABEL = "Make a terms update";

/** The label of the made update's copy row. */
export const TERMS_UPDATE_COPY_LABEL = "Terms update";

/** The hint under the copy row's label. */
export const TERMS_UPDATE_COPY_HINT =
  "Send all of it to your partner, over any channel that delivers it " +
  "unchanged. A run between you replaces the secret it was made under, so " +
  "make a new one if a run happens before your partner applies it.";

/** What the send part says when the update could not be made. */
export const TERMS_UPDATE_NOT_MADE_TEXT =
  "The terms update could not be made. Reload the page and try again.";

/** Why the send part is withheld, by the reason
 * `managedTermsUpdateWithheld` gives. */
export const TERMS_UPDATE_WITHHELD_TEXT = {
  lapsed:
    "This exchange's shared secret has expired, so it cannot make a terms " +
    "update. Re-invite your partner to run again.",
  "no-identity":
    "This exchange's terms name no identity for you, so it cannot make a " +
    "terms update. Re-invite your partner.",
} as const;
