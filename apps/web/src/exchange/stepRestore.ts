/**
 * The restore-clamp predicates for the two consoles: given a step a history entry
 * names and the backing state the console currently holds, the step that can
 * render. A browser Back or Forward can land on an entry whose work column
 * reads state a later action cleared -- an inviter `share` entry a start-over
 * emptied of its invitation, an inviter `review` entry a delimiter change
 * emptied of its file, an acceptor `launched` entry a back-to-columns recovery
 * emptied of its launch -- and rendering it would leave the operator on a blank
 * or bogus column. The invariant these encode: a step is restored only when the
 * state its work column requires still exists, else it clamps to the nearest
 * step whose backing state the clearing action left intact.
 *
 * Pure and dependency-free so the clamp is the tested boundary, pinned without
 * mounting either console.
 */

import type { SpineTarget } from "@psi/inviterModel";

/** The inviter console's work-column sections: the required spine, the Customize
 * tabs, and the two terminal surfaces. */
export type Section = SpineTarget | "share" | "save";

/** The backing state the inviter's guarded sections read: every section past
 * `file` renders only with a read file and the draft seeded from it, `share`
 * also needs a live invitation, and `save` a CLI transport. */
interface SectionPreconditions {
  hasFile: boolean;
  hasInvitation: boolean;
  isCliTransport: boolean;
}

/** The section to restore for `requested`: the section itself when its backing
 * state still exists. Without a file -- dropped by a delimiter change under the
 * columns, or by a refused read -- only `file` can render. With one, a `share`
 * or `save` entry whose own state is gone settles on `review`, the nearest step
 * whose state (the loaded file and derived terms) a start-over leaves intact. */
export function restorableSection(
  requested: Section,
  preconditions: SectionPreconditions,
): Section {
  if (requested !== "file" && !preconditions.hasFile) return "file";
  if (requested === "share" && !preconditions.hasInvitation) return "review";
  if (requested === "save" && !preconditions.isCliTransport) return "review";
  return requested;
}

/** The acceptor's position tokens past its review step. */
const PAST_ACCEPTOR_REVIEW = new Set([
  "consent",
  "columns",
  "columns:cleaning",
  "launched",
]);

/** The acceptor's position tokens that render the admitted rows. */
const ACCEPTOR_ROWS_STEPS = new Set([
  "columns",
  "columns:cleaning",
  "launched",
]);

/** The position token to restore for `token`: the token itself when its backing
 * state still exists. `launched` reads the run the launch drives, which a
 * back-to-columns recovery clears, so without a launch it settles on `columns`
 * -- the nearest step whose state (the acquired file and confirmed columns)
 * that recovery leaves intact. Every step the launch has not yet reached reads
 * what the review step committed when the operator continued from it, which an
 * edit there voids, so without that commit it settles on `review`. The columns
 * step reads the rows the consent gate admitted, which choosing another file
 * clears, so without them it settles on `consent`. */
export function restorablePosition(
  token: string,
  preconditions: {
    hasLaunch: boolean;
    reviewCommitted: boolean;
    hasAcquired: boolean;
  },
): string {
  if (token === "launched" && preconditions.hasLaunch) return token;
  if (PAST_ACCEPTOR_REVIEW.has(token) && !preconditions.reviewCommitted)
    return "review";
  if (ACCEPTOR_ROWS_STEPS.has(token) && !preconditions.hasAcquired)
    return "consent";
  if (token === "launched") return "columns";
  return token;
}
