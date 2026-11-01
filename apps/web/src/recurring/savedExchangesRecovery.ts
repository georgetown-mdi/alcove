/**
 * The pure model behind the read-failed surface's recovery listing: turning the
 * store's diagnostic entries into the small display rows that surface lists, each
 * with the delete-by-key the surface dispatches. No React, no IndexedDB: the store
 * reads and the delete action live in the component, so the display derivation is
 * unit-testable in Node.
 *
 * A readable entry shows its label, its side (or, for a configuration on a
 * channel that names no side, the channel, named as the saved-exchanges list
 * names it), and last-run date, and where only its sibling entry does not
 * parse, a note that part of its saved state cannot be read; an unreadable
 * entry, whose record does not parse, shows a fixed "Unreadable record" label
 * and no other detail but a failed migration's refusal, escaped here for
 * display. Neither of those two can be opened.
 * Every row holds the stored key the one-step delete-by-key acts on, so an
 * unreadable record is discardable without a successful parse, and whether an
 * exported backup remains, which the delete confirm states and which survives a
 * record's unreadability because it is the sibling entry's, not the record's.
 * Secret material never reaches this model:
 * the diagnostic entries hold display essentials only.
 */

import { sanitizeErrorForDisplay } from "@alcove/core";

import { dateLabel } from "@psi/formatting";

import { rowSideLabel } from "./savedExchangesModel";

import type { ManagedExchangeDiagnosticEntry } from "@psi/managed/managedExchangeStore";

/** The label a row shows for an unreadable entry: nothing about it could be
 * parsed, so it displays as an unreadable record rather than an empty or guessed
 * name. */
export const UNREADABLE_RECORD_LABEL = "Unreadable record";

/** The note a row shows when its record parses and its sibling entry does
 * not, so its page cannot load. */
export const STATE_UNREADABLE_NOTE = "Part of its saved state cannot be read";

/** One row in the read-failed recovery listing: the stored key the delete acts on,
 * a display label (the operator's label, "(unnamed exchange)" when empty, or
 * {@link UNREADABLE_RECORD_LABEL} when the entry could not be parsed), the raw label
 * the delete confirm names (empty when unlabeled, so the button's own empty-label
 * branch fires rather than reading a doubly-transformed "(unnamed exchange)"), the
 * side (or channel) and last-run date when parseable, whether the entry was
 * unreadable, and whether an exported backup remains under the operator's
 * custody. */
export interface RecoveryRow {
  /** The stored key the one-step delete-by-key dispatches on. */
  id: string;
  /** The display label for the row text (see the interface doc). */
  label: string;
  /** The raw operator label the delete confirm names -- empty when unlabeled, so the
   * confirm reads "Remove this exchange?" exactly as the normal list's does, not the
   * transformed row text. Always empty on an unreadable row. */
  deleteLabel: string;
  /** This party's side, or the channel for a configuration on one that names
   * no side, as the saved-exchanges list names it (see {@link rowSideLabel});
   * absent on an unreadable row. */
  sideLabel?: string;
  /** The last run's calendar-day phrase, when the entry parsed and had a run. */
  lastRunAt?: string;
  /** Whether the entry could not be parsed. */
  unreadable: boolean;
  /** Why an unreadable entry's migration failed, escaped for display; absent
   * where the entry is readable or the failure was not a migration's. */
  migrationFailure?: string;
  /** Whether the record parsed and its sibling entry did not
   * ({@link STATE_UNREADABLE_NOTE}). */
  stateUnreadable: boolean;
  /** Whether an exported backup remains under the operator's custody, so the delete
   * confirm states the custody note. Survives record unreadability. */
  backedUp: boolean;
}

/** Derive one recovery row from a diagnostic entry. A readable entry shows
 * its essentials (an empty label displays as "(unnamed exchange)" for the row
 * text, matching the run list, while the delete confirm names the raw label);
 * an unreadable entry shows only its key and the fixed unreadable label. Both
 * hold whether an exported backup remains through to the delete confirm. */
export function recoveryRow(
  entry: ManagedExchangeDiagnosticEntry,
): RecoveryRow {
  if (entry.kind === "unreadable")
    return {
      id: entry.id,
      label: UNREADABLE_RECORD_LABEL,
      deleteLabel: "",
      unreadable: true,
      ...(entry.migrationFailure !== undefined
        ? { migrationFailure: sanitizeErrorForDisplay(entry.migrationFailure) }
        : {}),
      stateUnreadable: false,
      backedUp: entry.backedUp,
    };
  const { essentials } = entry;
  return {
    id: essentials.id,
    label: essentials.label === "" ? "(unnamed exchange)" : essentials.label,
    deleteLabel: essentials.label,
    sideLabel: rowSideLabel(essentials.side, essentials.elsewhereChannel),
    ...(essentials.lastRunAt !== undefined
      ? { lastRunAt: dateLabel(new Date(essentials.lastRunAt)) }
      : {}),
    unreadable: false,
    stateUnreadable: entry.stateUnreadable === true,
    backedUp: entry.backedUp,
  };
}

/** Derive the recovery rows from the store's diagnostic entries, in store order. */
export function recoveryRows(
  entries: ReadonlyArray<ManagedExchangeDiagnosticEntry>,
): Array<RecoveryRow> {
  return entries.map((entry) => recoveryRow(entry));
}
