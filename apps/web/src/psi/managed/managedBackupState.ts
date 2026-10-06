/**
 * The one derived backup state a managed exchange shows (see
 * docs/notes/managed-exchange-design.md, "Moment-anchored backup surfaces"): a
 * quiet green "backed up as of <date>" when a current export exists, or one
 * actionable "Back up this exchange" when none does. This module is the pure
 * derivation; the local marker it reads is stored beside the record (see
 * {@link ./managedLocalState.ts}), never in the record and never in the
 * export artifact -- the record schema is reader-rejects-unknown and the export
 * strips only the handle, so a marker field would force a schema bump or leak
 * into the export.
 *
 * Currency is "taken since the last rotation," held structurally rather than
 * derived: every download export binds its serialized bytes to the marker write
 * in one atomic step, the folder backup a scheduled run writes stamps the marker
 * only while the stored secret is still the one its file holds, and the
 * rotation-persist write clears the marker in its own cross-store transaction
 * (see {@link ./managedExchangeStore.ts}). Marker presence
 * therefore already means a current export exists; the derivation reads no secret
 * material, no rotation epoch, and no `lastRun` outcome.
 *
 * `navigator.storage.persisted()` is never an input: on WebKit a granted
 * persist() must not be treated as covered (it does not reliably exempt the ITP
 * cap). The derivation depends only on the local backup marker, so a persist
 * grant cannot suppress the actionable state.
 */

/** The local backup marker for a record: when a backup was last taken. A plain
 * timestamp, not a secret-derived value -- it records the moment of the export,
 * cleared atomically when the secret rotates (see {@link ./managedExchangeStore.ts}).
 * Stored beside the record (see {@link ./managedLocalState.ts}), never in the record
 * or the export artifact. */
export interface ManagedBackupMarker {
  /** ISO 8601 UTC instant a backup was last taken for this record. */
  backedUpAt: string;
  /** Where that backup was saved, so the operator can find it; absent where the
   * marker stands for an imported file rather than a backup this app saved. */
  savedAs?: ManagedBackupLocation;
}

/** Where a backup was saved: downloaded under `fileName`, or written into the
 * working folder under `fileName`. `folderName` names that folder where its
 * name fits the stored bound, and is absent where it does not. */
export type ManagedBackupLocation =
  | { kind: "downloaded"; fileName: string }
  | { kind: "folder"; folderName?: string; fileName: string };

/** A backup written into the working folder, which only a scheduled run's
 * automatic backup does. */
export type ManagedFolderBackupLocation = Extract<
  ManagedBackupLocation,
  { kind: "folder" }
>;

/**
 * The automatic backup a marker records, or `undefined` where the marker
 * records none: a download, an import, or no marker at all. The marker is the
 * one record of which file the app wrote itself, so it alone decides what a
 * later automatic backup may replace; a file that merely looks like one by its
 * name is never taken for it.
 */
export function automaticBackupOnMarker(
  marker: ManagedBackupMarker | undefined,
): ManagedFolderBackupLocation | undefined {
  return marker?.savedAs?.kind === "folder" ? marker.savedAs : undefined;
}

/** The derived backup state the UI shows:
 *
 * - `"backed-up"` -- a current export exists (the marker is present, and it is
 *   cleared on rotation): the exchange shows a quiet green "backed up as of <date>"
 *   and nothing else. {@link backedUpAt} holds the marker's instant for the date.
 * - `"backup-needed"` -- no marker (none was ever taken, or the secret rotated since
 *   the last one and cleared it): one actionable "Back up this exchange".
 */
type ManagedBackupState =
  | { kind: "backed-up"; backedUpAt: string; savedAs?: ManagedBackupLocation }
  | { kind: "backup-needed" };

/**
 * Derive the backup state for a record given its local backup marker (or its
 * absence). A present marker is `"backed-up"`; no marker is `"backup-needed"`. The
 * marker's currency is a structural property of how it is written and cleared (an
 * export binds the serialized bytes to the marker; a rotation clears it in the same
 * transaction), not something this pure derivation re-checks against the record.
 */
export function deriveManagedBackupState(
  marker: ManagedBackupMarker | undefined,
): ManagedBackupState {
  if (marker === undefined) return { kind: "backup-needed" };
  return {
    kind: "backed-up",
    backedUpAt: marker.backedUpAt,
    ...(marker.savedAs !== undefined ? { savedAs: marker.savedAs } : {}),
  };
}
