import { useState } from "react";

import { Alert, Button } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { dateLabel } from "@psi/formatting";
import { deriveManagedBackupState } from "@psi/managed/managedBackupState";

import styles from "@styles/app.module.css";
import { useHashTarget } from "@components/useHashTarget";

import {
  EXPORT_LEAVES_ACCOUNTING_NOTE,
  RUN_IN_FLIGHT_EXPORT_REASON,
  runElsewhereNotice,
} from "./managedCronExportModel";
import {
  WORKING_FOLDER_GRANT_NOTE,
  WORKING_FOLDER_SCOPE_NOTE,
} from "./scheduleEntryModel";
import { MANAGED_BACKUP_SECTION_ID } from "./managedSectionIds";
import { attendedFolderWriteNote } from "./attendedFolderWriteModel";

import type {
  ManagedBackupLocation,
  ManagedBackupMarker,
} from "@psi/managed/managedBackupState";
import type { AttendedFolderWrite } from "./attendedFolderWriteModel";

/** Where the latest backup is, appended to the backed-up line; empty where the
 * marker stands for an imported file. */
function backupLocationClause(
  savedAs: ManagedBackupLocation | undefined,
): string {
  if (savedAs === undefined) return "";
  if (savedAs.kind === "downloaded")
    return `, downloaded as ${savedAs.fileName}`;
  return savedAs.folderName === undefined
    ? `, written to the folder as ${savedAs.fileName}`
    : `, written to the folder ${savedAs.folderName} as ${savedAs.fileName}`;
}

interface BackupPanelProps {
  marker: ManagedBackupMarker | undefined;
  busy: boolean;
  failed: boolean;
  /** Whether a run of this exchange is in flight in any context. The download is
   * withheld while it is, as the command-line export's is: the run changes the
   * secret the file would hold ({@link RUN_IN_FLIGHT_EXPORT_REASON}). */
  runInFlight: boolean;
  /** Whether this copy has a schedule on, which the notice beside the download
   * names. */
  scheduleOn: boolean;
  onBackUp: () => void;
}

/** The pre-run backup panel: the derived backup state ("backed up as of <date>" or
 * the actionable "Back up this exchange") and the download of the artifact this
 * browser restores from, which leaves this exchange runnable here. The state is
 * named against the command-line export below, whose two files bring back no secret
 * (its `alcove.yaml` imports as a configuration only), so the state this panel shows
 * is about the restorable file alone.
 * The custody guidance matches the CLI key file's: the file is a plaintext credential
 * to keep under owner-only custody. */
export function BackupPanel({
  marker,
  busy,
  failed,
  runInFlight,
  scheduleOn,
  onBackUp,
}: BackupPanelProps) {
  const state = deriveManagedBackupState(marker);
  const sectionRef = useHashTarget<HTMLDivElement>(MANAGED_BACKUP_SECTION_ID);
  return (
    <div
      className={styles.callout}
      id={MANAGED_BACKUP_SECTION_ID}
      tabIndex={-1}
      ref={sectionRef}
    >
      {/* A live region present from the first render, so the line a download
          puts here is announced: the download has no other feedback. */}
      <div role="status">
        {state.kind === "backed-up" ? (
          <p className={`${styles.small} ${styles.statusLineOk}`}>
            Backed up as of {dateLabel(new Date(state.backedUpAt))}
            {backupLocationClause(state.savedAs)}.
          </p>
        ) : (
          <p className={styles.calloutLead}>Back up this exchange.</p>
        )}
      </div>
      <p className={styles.small}>
        The backup file is the one this browser restores from: import it here to
        bring this exchange back. It holds this exchange&apos;s secret in plain
        text - keep it somewhere only you can read, and never send it over an
        unencrypted channel.
      </p>
      <p className={styles.small}>{runElsewhereNotice(scheduleOn)}</p>
      <p className={styles.small}>{EXPORT_LEAVES_ACCOUNTING_NOTE}</p>
      {failed && (
        <Alert
          role="alert"
          color="red"
          title="Could not save the backup"
          mb="sm"
        >
          Nothing changed here; try again.
        </Alert>
      )}
      <Button
        mt="sm"
        variant="default"
        onClick={onBackUp}
        loading={busy}
        disabled={runInFlight}
      >
        Download a backup
      </Button>
      {runInFlight && (
        <p className={styles.small}>{RUN_IN_FLIGHT_EXPORT_REASON}</p>
      )}
    </div>
  );
}

interface FolderWriteNoteProps {
  write: AttendedFolderWrite;
}

/** What became of the copy of a completed run's results written into the
 * working folder, directly under the result download it does not replace. */
export function FolderWriteNote({ write }: FolderWriteNoteProps) {
  const note = attendedFolderWriteNote(write);
  return note.failed ? (
    <Alert color="yellow" title="Not written to your folder" mb="sm">
      {note.message}
    </Alert>
  ) : (
    <p className={styles.small} role="status">
      {note.message}
    </p>
  );
}

/** The link back to the saved-exchanges list, shown at completion and on a
 * terminal (non-retryable) failure. */
export function SavedExchangesFoot() {
  return (
    <div className={styles.workFoot}>
      <Button component={Link} to="/saved" variant="default">
        Back to recurring exchanges
      </Button>
    </div>
  );
}

interface WorkingFolderPromptProps {
  onGrant: () => Promise<void>;
}

/** Where a browser that can grant a folder holds none for this exchange: the one
 * prompt standing in for the run's input, since each run reads its input from
 * that folder. The click reaches the picker with no awaited work in front of it,
 * since a browser hands a site a folder only under the operator's gesture. */
export function WorkingFolderPrompt({ onGrant }: WorkingFolderPromptProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  function choose() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void onGrant()
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }

  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>Choose this exchange&apos;s folder.</p>
      <p className={styles.small}>{WORKING_FOLDER_GRANT_NOTE}</p>
      <p className={`${styles.small} ${styles.sub}`}>
        {WORKING_FOLDER_SCOPE_NOTE}
      </p>
      {failed && (
        <Alert color="yellow" title="That folder was not set" mt="sm" mb="sm">
          Nothing changed. Try choosing the folder again.
        </Alert>
      )}
      <Button mt="sm" variant="default" loading={busy} onClick={choose}>
        Choose folder
      </Button>
    </div>
  );
}
