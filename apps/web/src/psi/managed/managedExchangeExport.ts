/**
 * The managed-exchange export intents, wired over the pure artifact encoder,
 * the blob download, and the local sibling-state writes. No export writes
 * anything but the backup marker: the stored exchange stays runnable here.
 *
 * - A BACKUP export, under the run's own lock, reads the current record,
 *   serializes it, and stamps the backup marker in one atomic store step,
 *   then downloads exactly those bytes. A run in flight refuses it.
 * - A FOLDER backup, which a scheduled run takes after its rotation, writes
 *   the same bytes into the granted working folder under a name holding the
 *   exchange's label, stamps the marker after the write lands, only while the
 *   stored secret is still the one the file holds, and then removes the
 *   previous folder backup the marker recorded.
 * - A COMMAND-LINE export downloads the CLI's own two files
 *   ({@link composeManagedCronExport}) instead of the artifact and writes
 *   nothing: no backup marker, since what it downloads is not the artifact.
 *   It reads and downloads under the run's own lock, so a run in flight
 *   refuses it.
 *
 * The run lock keeps both downloads from holding a secret a run in flight is
 * about to rotate. The backup composes what it downloads INSIDE the
 * read-and-mark step: the marker can never attest bytes nothing produced.
 *
 * The boundaries (the run lock, read-and-mark, the non-marking read by id,
 * the download) are injected so the intents are testable without a real
 * download or database.
 */

import { exchangeLabelFileFragment } from "../parkedResults";

import {
  MANAGED_EXCHANGE_ARTIFACT_MIME,
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "./managedExchangeArtifact";
import { backupLocationNameFits } from "./managedLocalStateShape";
import { composeManagedCronExport } from "./managedCronExport";
import { runnableManagedExchangeOrRefuse } from "./managedExchangeRecord";
import { storedWorkingDirectoryUsable } from "./managedWorkingDirectory";

import type {
  BackupFolderRemoval,
  BackupFolderWrite,
} from "./managedWorkingDirectory";
import type {
  ManagedBackupLocation,
  ManagedFolderBackupLocation,
} from "./managedBackupState";
import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { HandlePermissionState } from "./managedInputHandle";
import type { ManagedBackupMarkOutcome } from "./managedExchangeStore";
import type { ManagedCronExport } from "./managedCronExport";
import type { OwnRelayRead } from "../transport/ownRelaySetting";

/** The UTC instant of `at` to the second, as `<YYYY-MM-DD>T<HHMMSS>Z`. */
function backupFileStamp(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

/** The name every backup takes, downloaded or written into the working folder:
 * `alcove-backup-<label>-<YYYY-MM-DD>T<HHMMSS>Z.json`, the label reduced as the
 * results file reduces it ({@link exchangeLabelFileFragment}) and left out where
 * it reduces to nothing, and the UTC instant of `at` to the second. */
export function managedBackupFileName(label: string, at: Date): string {
  const fragment = exchangeLabelFileFragment(label);
  return `alcove-backup-${fragment === "" ? "" : `${fragment}-`}${backupFileStamp(at)}.json`;
}

/** The platform boundaries a backup export drives, injected so the intent stays
 * pure and testable. */
export interface ManagedExportDeps {
  /** Runs `step` under the record's run+rotate lock, refusing when a run holds it,
   * so the backup never holds a secret a run in flight is about to rotate. */
  withLock: <T>(id: string, step: () => Promise<T>) => Promise<T>;
  /** Read the current stored record for `id`, run `composeExport` on it, and stamp
   * its backup marker as of `backedUpAt`, saved as the location `composeExport`
   * returns, in one atomic step, returning the record read. `composeExport`
   * throwing aborts the whole step, writing no marker. */
  readAndMark: (
    id: string,
    backedUpAt: string,
    composeExport: (record: ManagedExchangeRecord) => ManagedBackupLocation,
  ) => Promise<ManagedExchangeRecord>;
  /** Trigger a client-side download of the serialized artifact under `fileName`. */
  download: (fileName: string, content: string) => void;
  /** The moment of the export; injected so the marker and filename dates are the
   * caller's clock. */
  now: () => Date;
}

/** The bytes of a backup of `record`: the one composition every backup file
 * holds, downloaded or written into the working folder.
 *
 * @throws {Error} if the record holds a configuration only. */
function backupArtifactBytes(record: ManagedExchangeRecord): string {
  return serializeManagedExchangeArtifact(
    encodeManagedExchangeArtifact(runnableManagedExchangeOrRefuse(record)),
  );
}

/** The backup export's result: the fresh read-and-mark instant (threaded so the
 * host renders the one clock read), the name the file was downloaded and marked
 * under, and the record read, so the caller need not re-read to know what was
 * exported. */
interface ManagedBackupResult {
  /** The instant the backup marker was stamped, from the caller's `now`. */
  backedUpAt: Date;
  /** The name the download was given, the one the marker records. */
  fileName: string;
  /** The record the export serialized (the fresh store read). */
  record: RunnableManagedExchangeRecord;
}

/**
 * Export a record as a BACKUP: under the record's run+rotate lock, one clock
 * read, then the store's read-serialize-and-mark by id, then the download of
 * exactly those bytes. Reading by id (not a caller-held record) keeps a stale
 * tab or pre-rotation snapshot from being what the export serializes, or what
 * its file name states. A step that resolves without serializing fails the
 * export rather than downloading, so the marker never attests bytes it did
 * not read. Nothing but the backup marker is written.
 *
 * Returns the mark instant, the file name, and the record read, so the host
 * renders the same instant it persisted.
 *
 * @throws {ManagedExchangeLockUnavailableError} if a run of the record holds
 *   the lock; nothing is read, marked, or downloaded.
 * @throws {Error} if no record with `id` exists.
 * @throws {ZodError} if the stored record or its sibling entry is invalid.
 */
export async function exportManagedBackup(
  id: string,
  deps: ManagedExportDeps,
): Promise<ManagedBackupResult> {
  return deps.withLock(id, () => readMarkAndDownload(id, deps));
}

async function readMarkAndDownload(
  id: string,
  deps: ManagedExportDeps,
): Promise<ManagedBackupResult> {
  const backedUpAt = deps.now();
  let composed: { fileName: string; serialized: string } | undefined;
  const record = await deps.readAndMark(
    id,
    backedUpAt.toISOString(),
    (read) => {
      const fileName = managedBackupFileName(read.label, backedUpAt);
      composed = { fileName, serialized: backupArtifactBytes(read) };
      return { kind: "downloaded", fileName };
    },
  );
  if (composed === undefined)
    throw new Error(
      "the read-and-mark step resolved without serializing the export, so its " +
        "backup marker would attest bytes nothing produced",
    );
  deps.download(composed.fileName, composed.serialized);
  return {
    backedUpAt,
    fileName: composed.fileName,
    record: runnableManagedExchangeOrRefuse(record),
  };
}

/** The platform boundaries the backup a scheduled run takes after its rotation
 * drives, injected so the decision is testable without a store or a folder. */
export interface ManagedFolderBackupDeps {
  /** Read the current stored record for `id`, or `undefined` when none is
   * stored. */
  readRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  /** Write the backup into the record's working folder, querying its
   * permission and never prompting, and never replacing a held name. */
  writeToFolder: (
    record: ManagedExchangeRecord,
    fileName: string,
    content: Blob,
  ) => Promise<BackupFolderWrite>;
  /** Remove the file `fileName` from the record's working folder, querying its
   * permission and never prompting. */
  removeFromFolder: (
    record: ManagedExchangeRecord,
    fileName: string,
  ) => Promise<BackupFolderRemoval>;
  /** Stamp the backup marker as of `backedUpAt`, saved as `savedAs`, only while
   * the stored record still holds `expectedSharedSecret`. */
  markIfCurrent: (
    id: string,
    expectedSharedSecret: string,
    backedUpAt: string,
    savedAs: ManagedBackupLocation,
  ) => Promise<ManagedBackupMarkOutcome>;
  /** The moment of the backup, for the marker and the file name. */
  now: () => Date;
}

/** What became of the previous automatic backup once the new one landed: the
 * folder's own {@link BackupFolderRemoval}, or `"other-folder"` where the
 * marker recorded it under another folder name, or under none, so it was left
 * where it is. `fileName` is the name the marker recorded. */
export type PreviousFolderBackup = { fileName: string } & (
  BackupFolderRemoval | { kind: "other-folder" }
);

/** How the backup a scheduled run takes after its rotation turned out. Only
 * `"backed-up"` stamps the backup marker, so every other outcome leaves the
 * exchange asking for a backup. `"superseded"`: the file was written, and the
 * stored secret moved past it before the marker could be stamped. `previous`,
 * on the two outcomes that wrote a file, is what became of the previous
 * automatic backup, absent where there was none to replace. */
export type ManagedFolderBackup =
  | {
      kind: "backed-up";
      fileName: string;
      directoryName: string;
      backedUpAt: Date;
      previous?: PreviousFolderBackup;
    }
  | { kind: "no-folder" }
  | { kind: "ungranted"; state: HandlePermissionState }
  | { kind: "name-held"; fileName: string }
  | { kind: "write-failed"; error: unknown }
  | {
      kind: "superseded";
      fileName: string;
      directoryName: string;
      previous?: PreviousFolderBackup;
    }
  | { kind: "failed"; error: unknown };

/** Remove the previous automatic backup once `written` has landed, only where
 * the marker recorded it in a folder of the same name: the marker holds no
 * handle, so a folder the operator switched to is told apart by name alone. */
async function removePreviousFolderBackup(
  record: ManagedExchangeRecord,
  previous: ManagedFolderBackupLocation,
  written: { fileName: string; directoryName: string },
  deps: ManagedFolderBackupDeps,
): Promise<PreviousFolderBackup | undefined> {
  const { fileName } = previous;
  if (fileName === written.fileName) return undefined;
  if (previous.folderName !== written.directoryName)
    return { kind: "other-folder", fileName };
  try {
    return { ...(await deps.removeFromFolder(record, fileName)), fileName };
  } catch (error) {
    return { kind: "remove-failed", error, fileName };
  }
}

/**
 * Back up a record into its working folder with nobody present: the bytes a
 * manual backup downloads, written into the granted folder under
 * {@link managedBackupFileName}, the backup marker stamped once the
 * file has landed and only while the stored secret is still the one the file
 * holds, and then `previous` removed: the automatic backup the marker recorded
 * before this run's rotation cleared it.
 *
 * The order differs from the manual backup's, which stamps before it downloads
 * because a download reports no landing: a folder write does report one, so a
 * write that did not land stamps nothing, and the marker is checked against
 * the stored secret instead of being stamped in the step that read it. A write
 * that did not land also removes nothing, so the previous backup stays.
 *
 * Never rejects: it runs after a completed run, which nothing here may fail.
 */
export async function backUpManagedExchangeToFolder(
  id: string,
  deps: ManagedFolderBackupDeps,
  previous?: ManagedFolderBackupLocation,
): Promise<ManagedFolderBackup> {
  try {
    const record = await deps.readRecord(id);
    if (record === undefined)
      return {
        kind: "failed",
        error: new Error(`no managed exchange with id ${id}`),
      };
    if (!storedWorkingDirectoryUsable(record.workingDirectoryHandle))
      return { kind: "no-folder" };
    const runnable = runnableManagedExchangeOrRefuse(record);
    const content = new Blob([backupArtifactBytes(runnable)], {
      type: MANAGED_EXCHANGE_ARTIFACT_MIME,
    });
    const backedUpAt = deps.now();
    const written = await deps.writeToFolder(
      runnable,
      managedBackupFileName(runnable.label, backedUpAt),
      content,
    );
    if (written.kind !== "written") return written;
    const { fileName, directoryName } = written;
    const marked = await deps.markIfCurrent(
      id,
      runnable.sharedSecret,
      backedUpAt.toISOString(),
      {
        kind: "folder",
        ...(backupLocationNameFits(directoryName)
          ? { folderName: directoryName }
          : {}),
        fileName,
      },
    );
    if (marked === "gone")
      return {
        kind: "failed",
        error: new Error(`managed exchange ${id} is no longer stored`),
      };
    const removal =
      previous === undefined
        ? undefined
        : await removePreviousFolderBackup(runnable, previous, written, deps);
    const replaced = removal === undefined ? {} : { previous: removal };
    if (marked === "marked")
      return {
        kind: "backed-up",
        fileName,
        directoryName,
        backedUpAt,
        ...replaced,
      };
    return { kind: "superseded", fileName, directoryName, ...replaced };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/** The platform boundaries the command-line export drives: the record's run+rotate
 * lock, a NON-STAMPING read of the record by id (this export marks no backup
 * marker -- see the module header) and a download that takes each composed file's
 * own media type -- the two files land as the YAML and JSON documents the CLI
 * opens, not as one artifact blob. No store write is among them, so the export
 * cannot change the stored record. */
export interface ManagedCronExportDeps {
  /** Runs `step` under the record's run+rotate lock, refusing when a run holds it,
   * so the key file never holds a secret a run in flight is about to rotate. */
  withLock: <T>(id: string, step: () => Promise<T>) => Promise<T>;
  /** Read the current stored record for `id`, or `undefined` when none is stored.
   * Read at export time and never from a caller-held record, so a stale tab
   * composes the files the store's record has or none at all. */
  readRecord: (id: string) => Promise<ManagedExchangeRecord | undefined>;
  /** Trigger a client-side download of one composed file. */
  download: (fileName: string, content: string, mimeType: string) => void;
  /** This browser's relay settings as the panel's own composition read them,
   * so the files downloaded name the TURN urls the panel showed. */
  readOwn: () => OwnRelayRead;
}

/**
 * Export the CLI's two files: under the record's run+rotate lock, read the
 * current record by id, compose them from exactly that read, and download each
 * under its own name. Returns what the two downloads held.
 *
 * Nothing is written: no backup marker, since the two files are not the
 * artifact this app's backup import accepts, and no spend, so the stored
 * exchange stays runnable here whatever becomes of the files.
 *
 * The composition is partial ({@link composeManagedCronExport} refuses a
 * record this app could not have composed); a refusal throws before any
 * download.
 *
 * @throws {ManagedExchangeLockUnavailableError} if a run of the record holds
 *   the lock; nothing is read or downloaded.
 * @throws {Error} if no record with `id` exists, or if the record is one
 *   the command-line export refuses ({@link composeManagedCronExport}).
 * @throws {ZodError} if the stored record is invalid.
 */
export async function exportManagedCronFiles(
  id: string,
  deps: ManagedCronExportDeps,
): Promise<ManagedCronExport> {
  return deps.withLock(id, async () => {
    const stored = await deps.readRecord(id);
    if (stored === undefined)
      throw new Error(`no managed exchange with id ${id}`);
    const composed = composeManagedCronExport(
      runnableManagedExchangeOrRefuse(stored),
      deps.readOwn,
    );
    for (const file of [composed.config, composed.key])
      deps.download(file.fileName, file.text, file.mimeType);
    return composed;
  });
}
