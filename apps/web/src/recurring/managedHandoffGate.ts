/**
 * The reasons an import meets when it would revive a copy this browser handed
 * off -- when the copy is already gone, and when this browser cannot read whether
 * it is -- and the heading a take-back held by a run is shown under.
 */

import type { ManagedSpentHandoff } from "@psi/managed/managedLocalState";

/** The heading a take-back held by a run in flight is shown under. */
export const RUN_IN_FLIGHT_HANDOFF_TITLE = "Wait for this run to finish";

/** The heading the refused-import reason is shown under, at the import affordance. */
export const HANDED_OFF_IMPORT_TITLE = "That exchange was handed off";

/**
 * The refusal an import meets when the backup file it was given belongs to an
 * exchange this browser has already handed off: the copy the file would bring back is
 * one the hand-off gave away, so the import is refused rather than reviving it or
 * installing a second live copy beside the handed-off one. Keyed by the hand-off,
 * because what the operator has instead is whatever that hand-off saved -- a route
 * added later must say its own recovery here rather than inherit this one.
 *
 * The command-line route's recovery is the re-take on the handed-off exchange's own
 * surface ({@link ./managedRetakeModel.ts}), named by the words of its control: the
 * import is on the list, so an operator meeting this refusal is not on the screen
 * that offers the re-take.
 */
const HANDED_OFF_IMPORT_REASON: Record<
  ManagedSpentHandoff,
  (named: string) => string
> = {
  "command-line": (named) =>
    `${named} is still here, handed off to the command line: it runs from the ` +
    "alcove.yaml and .alcove.key you saved, on the machine you saved them to, " +
    "and that machine is its one owner. A backup file taken before the hand-off " +
    "would run a copy you gave away, so nothing was imported. To run this " +
    'exchange in this browser again, open it from the list and choose "Take ' +
    'this exchange back".',
};

/**
 * The refused-import reason for the hand-off that spent the stored copy, naming the
 * exchange as the operator knows it. An unlabeled exchange is named neutrally rather
 * than by an empty pair of quotes.
 */
export function handedOffImportReason(
  handoff: ManagedSpentHandoff,
  label: string,
): string {
  return HANDED_OFF_IMPORT_REASON[handoff](
    label === "" ? "That exchange" : `"${label}"`,
  );
}

/** The heading the unreadable-custody refusal is shown under, at the import
 * affordance. It names this browser's stored copy, the thing that could not be read,
 * in the words the run's own unreadable-custody refusal uses
 * (`managedRunLaunchModel.ts`): the backup file is fine, so a heading about the file
 * would send the operator after the wrong fault. */
export const CUSTODY_UNREADABLE_IMPORT_TITLE =
  "Part of that exchange's stored copy could not be read";

/**
 * The refusal an import meets when this browser still holds the exchange but cannot
 * read the note it keeps beside it, which is where a hand-off is recorded: a
 * hand-off can be neither confirmed nor ruled out, so the import is refused and no
 * route is named, none having been read. Only the operator knows whether they handed
 * the exchange off, so the reason gives them what to do either way -- and the delete
 * it offers is the one the read-failed listing on that page already provides.
 */
export function custodyUnreadableImportReason(label: string): string {
  const named = label === "" ? "that exchange" : `"${label}"`;
  return (
    `This browser could not read the note it keeps beside ${named} - the one ` +
    "recording whether this copy was handed off somewhere else - so nothing " +
    "was imported. If you handed this exchange off, it runs from the files you " +
    "saved then and there is nothing here to import. If you did not, remove " +
    "that exchange from the list on this page, then import the backup file " +
    "again."
  );
}

/**
 * The refusal a command-line `alcove.yaml` and `.alcove.key` meet when the key
 * file's secret matches an exchange this browser handed off to the command line.
 * Those files are what the hand-off saved, and the route that brings them back is
 * the re-take on that exchange's own surface: it asks the operator to stop the
 * command-line run first, which an import has no place to ask. Keyed by the
 * hand-off, as {@link handedOffImportReason} is.
 */
const HANDED_OFF_PAIR_IMPORT_REASON: Record<
  ManagedSpentHandoff,
  (named: string) => string
> = {
  "command-line": (named) =>
    `${named} is still here, handed off to the command line, and these are ` +
    "the files it runs from there, so nothing was imported. To run it in " +
    'this browser again, open it from the list, choose "Take this exchange ' +
    'back", and choose this alcove.yaml and .alcove.key there.',
};

/** {@link handedOffImportReason} for a command-line pair's import. */
export function handedOffPairImportReason(
  handoff: ManagedSpentHandoff,
  label: string,
): string {
  return HANDED_OFF_PAIR_IMPORT_REASON[handoff](
    label === "" ? "That exchange" : `"${label}"`,
  );
}

/** {@link custodyUnreadableImportReason} for a command-line pair's import: the
 * same fault, with the files to import again named as the pair, and the
 * command-line run to stop before this browser runs the exchange too. */
export function custodyUnreadablePairImportReason(label: string): string {
  const named = label === "" ? "that exchange" : `"${label}"`;
  return (
    `This browser could not read the note it keeps beside ${named} - the one ` +
    "recording whether this copy was handed off somewhere else - so nothing " +
    "was imported. Remove that exchange from the list on this page, then " +
    "import the alcove.yaml and .alcove.key again. If you handed it off to " +
    "the command line, stop the scheduled run there first."
  );
}
