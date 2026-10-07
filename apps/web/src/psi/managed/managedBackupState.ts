/**
 * The derived backup state a managed exchange shows: "backed up as of <date>"
 * when a current export exists, else "Back up this exchange" (design:
 * docs/notes/managed-exchange-design.md, "Moment-anchored backup surfaces"). The
 * marker it reads is stored beside the record ({@link ./managedLocalState.ts}),
 * never in the record (which rejects unknown fields) or the export. Marker
 * presence means a current export: a download sets it atomically with its bytes,
 * a scheduled folder backup only while the stored secret is the one its file
 * holds, and a rotation clears it in its own transaction
 * ({@link ./managedExchangeStore.ts}).
 * `navigator.storage.persisted()` is never an input: on WebKit a persist grant
 * does not exempt the ITP cap.
 */

/** The local backup marker for a record: when a backup was last taken. */
export interface ManagedBackupMarker {
  /** ISO 8601 UTC instant a backup was last taken for this record. */
  backedUpAt: string;
  /** Where that backup was saved; absent where the marker stands for an
   * imported file. */
  savedAs?: ManagedBackupLocation;
}

/** Where a backup was saved. `folderName` is absent where the folder's name
 * exceeds the stored bound. */
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
 * The automatic backup a marker records, or `undefined` for a download, an import
 * or no marker. Only the marker decides what a later automatic backup may
 * replace; a file is never taken for one by its name.
 */
export function automaticBackupOnMarker(
  marker: ManagedBackupMarker | undefined,
): ManagedFolderBackupLocation | undefined {
  return marker?.savedAs?.kind === "folder" ? marker.savedAs : undefined;
}

/** The derived backup state the UI shows; `"backup-needed"` covers both no
 * backup ever taken and a rotation since the last one. */
type ManagedBackupState =
  | { kind: "backed-up"; backedUpAt: string; savedAs?: ManagedBackupLocation }
  | { kind: "backup-needed" };

/** Derive the backup state for a record from its local backup marker. */
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
