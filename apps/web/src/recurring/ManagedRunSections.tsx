import { useState } from "react";

import { Alert, Button, FileButton, Modal } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import {
  MAX_CONFIGURATION_IMPORT_BYTES,
  MAX_KEY_FILE_IMPORT_BYTES,
} from "@psi/managed/managedCommandLineImport";
import { dateLabel } from "@psi/formatting";
import { deriveManagedBackupState } from "@psi/managed/managedBackupState";
import { retakeManagedExchange } from "@psi/managed/managedRetake";

import styles from "@styles/app.module.css";

import {
  RETAKE_ACTION_LABEL,
  RETAKE_CONFIRM_LABEL,
  RETAKE_KEY_FILE_NOTE,
  RETAKE_LEAD,
  RETAKE_NO_KEY_FILE_NOTE,
  RETAKE_STORE_FAILED,
  managedRetakeRefusal,
  retakeFileChoiceRefusal,
} from "./managedRetakeModel";
import {
  WORKING_FOLDER_GRANT_NOTE,
  WORKING_FOLDER_SCOPE_NOTE,
} from "./scheduleEntryModel";
import { MANAGED_RUN_HANDED_OFF_ATTESTATION } from "./managedRunLaunchModel";
import { ParkedResultsView } from "./ManagedExchangeDetail";
import { RUN_IN_FLIGHT_HANDOFF_REASON } from "./managedHandoffGate";
import { attendedFolderWriteNote } from "./attendedFolderWriteModel";
import { managedImportFileChoice } from "./managedImportFiles";

import type {
  ManagedBackupLocation,
  ManagedBackupMarker,
} from "@psi/managed/managedBackupState";
import type { AttendedFolderWrite } from "./attendedFolderWriteModel";
import type { ManagedRetakeRefusal } from "./managedRetakeModel";
import type { ManagedSpentState } from "@psi/managed/managedLocalState";
import type { ParkedResultsRead } from "@psi/parkedResultsStore";

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
  /** Whether a run of this exchange is in flight in any context. Only the migration
   * is withheld while it is: a backup leaves the source live, so taking one across a
   * rotation costs the operator nothing. */
  runInFlight: boolean;
  onBackUp: () => void;
  onMigrate: () => void;
}

/** The pre-run backup panel: the derived backup state ("backed up as of <date>" or
 * the actionable "Back up this exchange") plus the two export intents that download
 * the artifact this browser restores from. A backup export leaves this exchange live;
 * a migration export hands it off to another device, spending this copy. Both are
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
  onBackUp,
  onMigrate,
}: BackupPanelProps) {
  const state = deriveManagedBackupState(marker);
  return (
    <div className={styles.callout}>
      {state.kind === "backed-up" ? (
        <p className={`${styles.small} ${styles.statusLineOk}`}>
          Backed up as of {dateLabel(new Date(state.backedUpAt))}
          {backupLocationClause(state.savedAs)}.
        </p>
      ) : (
        <p className={styles.calloutLead}>Back up this exchange.</p>
      )}
      <p className={styles.small}>
        The backup file is the one this browser restores from: import it here to
        bring this exchange back. It holds this exchange&apos;s secret in plain
        text - keep it somewhere only you can read, and never send it over an
        unencrypted channel.
      </p>
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
      <Button mt="sm" variant="default" onClick={onBackUp} loading={busy}>
        Download a backup
      </Button>{" "}
      <Button
        mt="sm"
        variant="subtle"
        onClick={onMigrate}
        disabled={busy || runInFlight}
      >
        Move to another device
      </Button>
      {runInFlight && (
        <p className={styles.small}>{RUN_IN_FLIGHT_HANDOFF_REASON}</p>
      )}
    </div>
  );
}

interface SpentSurfaceProps {
  spent: ManagedSpentState | undefined;
  refusedRun?: boolean;
  /** How reading this exchange's parked results turned out; `undefined` while
   * the read is in flight. */
  parkedResultsRead: ParkedResultsRead | undefined;
  /** Read the parked results again, for a read that never reached the store. */
  onRetryParkedResultsRead: () => void;
  /** Remove what earlier runs left here. A spent copy runs nothing more, so this
   * is the only thing short of the retention that removes them. */
  onClearParkedResults: () => Promise<void>;
  /** The record the re-take acts on. */
  id: string;
  /** Read this exchange again, once a re-take has made it live. */
  onRetaken: () => void;
}

/** The durable surface of a spent copy, read from the stored spent state on every
 * later visit -- so it must say what THAT hand-off left the operator with. A
 * migration copy is somewhere an import can bring back; a command-line hand-off
 * produced the CLI's two files, which bring back no secret, so the exchange runs
 * from those files and they are the only copy of this exchange that can run.
 *
 * `spent` is undefined when the run-refusal transition reached this state without
 * the stored entry in hand: the reload behind it reads the record and the sibling
 * together, so either read rejecting costs both. That costs the hand-off's form
 * and its date, so the copy names neither -- naming one would send an operator
 * whose exchange went to the command line after a backup file that hand-off never
 * produced.
 *
 * `refusedRun` is set when this surface arrived here from a run the hand-off
 * refused rather than from a load, and adds that run's own account above the
 * durable copy: an operator who just pressed Run is owed what became of the run
 * they started, which the standing state cannot say. That account is the
 * hand-off tier's non-disclosure attestation, so its words are held beside the
 * gate resting on them ({@link MANAGED_RUN_HANDED_OFF_ATTESTATION}).
 *
 * A hand-off takes the exchange's future runs, not what its earlier scheduled
 * runs left at rest here, so this surface collects those too -- the same
 * section the detail page offers them in. Without it the results sit in this
 * browser for the rest of the retention with nothing offering them. */
export function SpentSurface({
  spent,
  refusedRun = false,
  parkedResultsRead,
  onRetryParkedResultsRead,
  onClearParkedResults,
  id,
  onRetaken,
}: SpentSurfaceProps) {
  const refused = refusedRun ? (
    <p className={styles.small}>{MANAGED_RUN_HANDED_OFF_ATTESTATION}</p>
  ) : null;
  // A spent copy runs nothing more here, so the section stands only on what is
  // actually at rest.
  const parked = (
    <ParkedResultsView
      read={parkedResultsRead}
      scheduled={false}
      onRetryRead={onRetryParkedResultsRead}
      onClear={onClearParkedResults}
    />
  );
  if (spent === undefined)
    return (
      <>
        <h1 tabIndex={-1}>This exchange was handed off</h1>
        <p className={styles.sub}>
          This browser&apos;s copy of this exchange was handed off, so it no
          longer runs here. It runs where you handed it over to - the device you
          moved it to, or the machine running it from the command line.
        </p>
        {refused}
        {parked}
        <SavedExchangesFoot />
      </>
    );
  const on = ` on ${dateLabel(new Date(spent.spentAt))}`;
  return spent.handoff === "command-line" ? (
    <>
      <h1 tabIndex={-1}>This exchange was handed off</h1>
      <p className={styles.sub}>
        You handed this exchange to the command line{on}, so it no longer runs
        here. It runs from the alcove.yaml and .alcove.key you saved, on the
        machine you saved them to.
      </p>
      {refused}
      <p className={styles.small}>
        Those two files are the only copy of this exchange that can run. Keep
        them somewhere only you can read.
      </p>
      <RetakeControl id={id} onRetaken={onRetaken} />
      {parked}
      <SavedExchangesFoot />
    </>
  ) : (
    <>
      <h1 tabIndex={-1}>This exchange was handed off</h1>
      <p className={styles.sub}>
        You exported this exchange to take over on another device{on}, so it can
        no longer run here. Import the backup to run it on this device again.
      </p>
      {refused}
      {parked}
      <SavedExchangesFoot />
    </>
  );
}

interface RetakeControlProps {
  id: string;
  onRetaken: () => void;
}

/**
 * The re-take on a copy handed to the command line: the one route back from the
 * spent state to a running exchange, and the only one the import refusal points at
 * (see {@link ./managedHandoffGate.ts}).
 *
 * Behind a confirmation, because the browser cannot see either thing the operator
 * has to have settled: that the scheduled run on the other machine is stopped, and
 * whether it has run since the hand-off -- which decides whether the `alcove.yaml`
 * and `.alcove.key` from that machine are needed. Declining writes nothing and
 * leaves the copy spent.
 *
 * The files are optional at the confirmation rather than required, since the
 * stored secret is still the partnership's where nothing has run there; chosen,
 * they are the pair, since the key file alone names no exchange to check it
 * against. Files the reader will not take, and a re-take the store refused, both
 * keep the confirmation open with what happened beside it: nothing reads as a
 * take-back that did not happen.
 */
function RetakeControl({ id, onRetaken }: RetakeControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [chosenFiles, setChosenFiles] = useState<Array<File>>([]);
  const [retaking, setRetaking] = useState(false);
  const [refusal, setRefusal] = useState<ManagedRetakeRefusal>();

  function confirmRetake() {
    const choice = managedImportFileChoice(chosenFiles);
    if (choice !== undefined && choice.kind !== "pair") {
      setRefusal(retakeFileChoiceRefusal(choice));
      return;
    }
    setRetaking(true);
    setRefusal(undefined);
    void (async () => {
      try {
        // Capped before the read, as the pair import is: both are small
        // operator-held files, so an over-cap one is the wrong file rather than
        // one to read into memory ahead of the bounded parse.
        if (
          choice !== undefined &&
          (choice.configurationFile.size > MAX_CONFIGURATION_IMPORT_BYTES ||
            choice.keyFile.size > MAX_KEY_FILE_IMPORT_BYTES)
        ) {
          setRefusal(managedRetakeRefusal({ kind: "unreadable-files" }));
          return;
        }
        const files =
          choice === undefined
            ? undefined
            : {
                configuration: await choice.configurationFile.text(),
                key: await choice.keyFile.text(),
              };
        const result = await retakeManagedExchange(id, files);
        if (result.kind === "retaken") {
          setConfirming(false);
          onRetaken();
          return;
        }
        setRefusal(managedRetakeRefusal(result));
      } catch {
        setRefusal(RETAKE_STORE_FAILED);
      } finally {
        setRetaking(false);
      }
    })();
  }

  return (
    <>
      <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
        <Button
          variant="default"
          onClick={() => {
            setRefusal(undefined);
            setChosenFiles([]);
            setConfirming(true);
          }}
        >
          {RETAKE_ACTION_LABEL}
        </Button>
      </div>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={RETAKE_ACTION_LABEL}
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>{RETAKE_LEAD}</p>
        <p className={styles.small}>{RETAKE_KEY_FILE_NOTE}</p>
        <p className={`${styles.small} ${styles.sub}`}>
          {RETAKE_NO_KEY_FILE_NOTE}
        </p>
        <FileButton
          accept="application/yaml,.yaml,.yml,application/json,.key"
          multiple
          onChange={(files) => {
            setRefusal(undefined);
            setChosenFiles(files);
          }}
        >
          {(props) => (
            <Button variant="default" {...props}>
              Choose the alcove.yaml and .alcove.key
            </Button>
          )}
        </FileButton>
        {chosenFiles.map((file) => (
          <p key={file.name} className={`${styles.small} ${styles.mono}`}>
            {file.name}
          </p>
        ))}
        {refusal !== undefined && (
          <Alert color="yellow" title={refusal.title} mt="sm" mb="sm">
            {refusal.reason}
          </Alert>
        )}
        <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="light" loading={retaking} onClick={confirmRetake}>
            {RETAKE_CONFIRM_LABEL}
          </Button>
        </div>
      </Modal>
    </>
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
