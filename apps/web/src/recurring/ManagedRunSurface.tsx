import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Button,
  CopyButton,
  FileButton,
  Loader,
  Modal,
} from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import { alertRoleFor } from "@theme";

import { describeResolvedMatching } from "@alcove/core";

import { useOnlineStatus } from "@components/useOnlineStatus";

import {
  COMPROMISE_ACKNOWLEDGE_LABEL,
  COMPROMISE_ACKNOWLEDGE_LEAD,
  COMPROMISE_ACKNOWLEDGE_NOTE,
  COMPROMISE_RESPONSE_MESSAGE,
  COMPROMISE_RESPONSE_STANDS,
  COMPROMISE_RESPONSE_TITLE,
  COMPROMISE_RESPONSE_UNSAVED_REASON,
  COMPROMISE_RESPONSE_UNSAVED_TITLE,
  composeManagedFailureConfirmation,
} from "@psi/managed/managedFailureConfirmation";

import {
  MAX_CONFIGURATION_IMPORT_BYTES,
  MAX_KEY_FILE_IMPORT_BYTES,
} from "@psi/managed/managedCommandLineImport";
import { retakeManagedExchange } from "@psi/managed/managedRetake";

import { canReinviteFromRecord } from "@psi/managed/managedReinvite";

import { deriveManagedBackupState } from "@psi/managed/managedBackupState";

import { dateLabel, dateTimeLabel } from "@psi/formatting";
import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";

import {
  CopyRow,
  DonePanel,
  FailureBody,
  RunDownloads,
  RunWarningsAlert,
} from "@exchange/RunSurface";
import { AppPage } from "@components/AppPage";
import styles from "@styles/app.module.css";

import {
  MANAGED_RUN_HANDED_OFF_ATTESTATION,
  RUN_OUTCOME_UNSAVED_NOTE,
  managedReinviteRecoveryCopy,
  managedRunReinvites,
  managedRunRetryable,
} from "./managedRunLaunchModel";
import { TermsChangeQuestion, TermsProposalPanel } from "./ManagedTermsChange";

import {
  ManagedExchangeDetail,
  ParkedResultsView,
} from "./ManagedExchangeDetail";
import {
  RECORD_GONE_HANDOFF_REASON,
  RECORD_GONE_HANDOFF_TITLE,
  RUN_IN_FLIGHT_HANDOFF_REASON,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
  SUPERSEDED_HANDOFF_TITLE,
  supersededHandoffReason,
} from "./managedHandoffGate";
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
  STANDING_CONDITION_CLEAR_LABEL,
  managedStandingConditionView,
} from "./managedStandingConditionModel";
import { DeleteExchangeButton } from "./SavedExchanges";
import { ManagedConfigurationSurface } from "./ManagedConfigurationSurface";
import { ManagedCronExportPanel } from "./ManagedCronExportPanel";
import { REINVITE_RUN_IN_FLIGHT_REASON } from "./managedReinviteGate";
import { managedImportFileChoice } from "./managedImportFiles";
import { useManagedRunSurface } from "./useManagedRunSurface";

import {
  WORKING_FOLDER_GRANT_NOTE,
  WORKING_FOLDER_SCOPE_NOTE,
} from "./scheduleEntryModel";
import { attendedFolderWriteNote } from "./attendedFolderWriteModel";

import {
  managedCompromiseResponseActive,
  managedConfirmationGranted,
  managedFailureHoldsReinvite,
  managedReinviteFailedAt,
  managedReinviteInFlight,
  managedRunHoldsReinvite,
  managedStandingConditionShown,
} from "./managedRunRecoveryModel";
import {
  managedMigrationAwaitingConfirm,
  managedMigrationRefusal,
  managedMigrationStale,
  managedRunHoldsMigration,
} from "./managedRunHandoffModel";
import {
  managedRunCompletion,
  managedRunInProgress,
  managedRunLiveFailure,
  managedSurfaceView,
} from "./managedRunSurfaceModel";
import { managedUnrecordedRunFlagged } from "./managedSurfaceReadsModel";

import type { AttendedFolderWrite } from "./attendedFolderWriteModel";

import type { Ref } from "react";

import type {
  ManagedBackupLocation,
  ManagedBackupMarker,
} from "@psi/managed/managedBackupState";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedReinvite } from "@psi/managed/managedReinvite";
import type { ManagedRetakeRefusal } from "./managedRetakeModel";
import type { ManagedRunFailureAlert } from "./managedRunLaunchModel";
import type { ManagedSpentState } from "@psi/managed/managedLocalState";
import type { ManagedStandingConditionView } from "./managedStandingConditionModel";
import type { ParkedResultsRead } from "@psi/parkedResultsStore";
import type { routeConfirmationReply } from "@psi/managed/managedFailureConfirmation";

/**
 * The attended re-run surface: open a stored managed exchange, confirm the input,
 * and run -- reconnecting to the partner without a new invitation and completing
 * through the durable rotate-and-persist path. The record load, the per-run
 * input (the working folder, or a chosen file where none can be granted), the
 * run and every command the page offers are {@link useManagedRunSurface}'s;
 * this renders the state it holds.
 */
export function ManagedRunSurface({ id }: { id: string }) {
  const {
    state: surfaceState,
    runInFlight,
    recheckLock,
    reselected,
    reselect,
    hasFolder,
    folderGrantable,
    runInputSource,
    completion,
    run,
    backUp,
    migrate,
    confirmMigration,
    keepMigrationOnDevice,
    downloadUpdatedBackup,
    handOffToCommandLine,
    reinviteNow,
    resolveConfirmation,
    clearStanding,
    resolveStanding,
    saveLocalFields,
    grantWorkingFolder,
    stopUsingWorkingFolder,
    fileUnfiled,
    resetAccounting,
    retryAccountingRead,
    retryParkedResultsRead,
    clearParked,
    dropUnrecordedRunFlag,
    settleTermsProposal,
    readRecordAgain,
    rereadRecord,
    editConfiguration,
  } = useManagedRunSurface(id);
  const {
    load,
    run: runState,
    recovery,
    reads,
    handoff,
    termsProposal,
  } = surfaceState;
  const accountingRead = reads.accounting.read;
  const parkedResultsRead = reads.parkedResults.read;
  const exportBusy = handoff.export.kind === "busy";
  const exportFailed = handoff.export.kind === "failed";
  const migrationDispatch = managedMigrationAwaitingConfirm(handoff);
  const migrationRefusal = managedMigrationRefusal(handoff);
  const commandLineHandoff = handoff.commandLine;
  const runnable = load.kind === "runnable" ? load : undefined;
  const record = runnable?.record;
  const localState = runnable?.localState;
  const running = managedRunInProgress(runState);
  const runCompletion = managedRunCompletion(runState);
  const outputs = runCompletion?.outputs;
  const folderWrite = runCompletion?.folderWrite;
  const finishedAt = runCompletion?.finishedAt;
  const runOutcomeUnsavedReason = runCompletion?.unsavedReason;
  // The hand-off has no failure copy of its own and never lands here: reaching it
  // moves the surface to the spent state below.
  const liveFailure = managedRunLiveFailure(runState);
  const failure = liveFailure?.alert;
  const { warnings: runWarnings, matching, termsChangeQuestion } = runState;
  // The record, its detail, and the backup affordances all read the browser's own
  // store and render offline; a run is a live two-party session and cannot. Gating
  // the action names that rather than letting the operator press it into an opaque
  // connection failure. Only the offline direction is gated -- being online is no
  // promise the partner is there (see @utils/networkStatus).
  const online = useOnlineStatus();
  const runHoldsMigration = managedRunHoldsMigration(handoff, runInFlight);
  const staleMigration = managedMigrationStale(handoff);
  // The Tier-2 confirmation gate: once the operator confirms a real partner-side
  // failure, the surface proceeds to re-invite; a "does not add up" reply routes to
  // the compromise-response copy instead.
  const confirmationGated = managedConfirmationGranted(recovery, liveFailure);
  const compromiseResponse = managedCompromiseResponseActive(recovery, record);
  const respondingCompromise = recovery.compromise.write.kind === "writing";
  const compromiseWriteFailed = recovery.compromise.write.kind === "failed";
  const standingSettled = recovery.standing.settled;
  const clearingStanding = recovery.standing.clear.kind === "clearing";
  const clearStandingFailed = recovery.standing.clear.kind === "failed";
  const reinvite = recovery.reinvite.composed;
  const reinviting = managedReinviteInFlight(recovery);
  const runHoldsReinvite = managedRunHoldsReinvite(recovery, runInFlight);
  const reinviteSource = recovery.reinvite.site;

  // The re-invite result panel, scrolled into view when the detail section (far below
  // the panel) triggered the mint, so the operator lands on the artifacts they need.
  const reinvitePanelRef = useRef<HTMLDivElement | null>(null);

  const navigate = useNavigate();

  // The ReinvitePanel renders near the top of the surface; the detail section that
  // can trigger it is far below, so a detail-triggered mint would land the result
  // off-screen. Scroll it into view once it renders for the detail source. The
  // failure-path recovery already renders where that user is looking, so it is left
  // alone.
  useEffect(() => {
    if (
      reinvite !== undefined &&
      reinviteSource === "detail" &&
      reinvitePanelRef.current !== null
    )
      reinvitePanelRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
  }, [reinvite, reinviteSource]);

  // The standing condition as the page would render it, and whether it renders at
  // all. A live run's own failure already speaks for this run, and where it landed
  // on the state the condition resolves to it holds that state's recovery and the
  // compromise response answered here -- so the section stands down rather than
  // putting a second copy beside the first. It returns as soon as the live state is
  // something else, and at the next visit; once cleared it holds its place.
  const standingView =
    record !== undefined
      ? managedStandingConditionView(record, localState)
      : undefined;
  const showStanding = managedStandingConditionShown(
    recovery,
    standingView,
    failure,
  );

  // Whether the live failure holds the re-invite: it offers the mint directly, or it
  // holds the confirmation gate, whose two outcomes decide whether one happens at
  // all. Both mint from this record, so the standing section keeps its status and
  // its clear control and adds no button of its own -- neither a second copy of the
  // offer, whose failed mint would alert twice, nor a way around the gate.
  const failureHoldsReinvite = managedFailureHoldsReinvite(failure);

  // Which of the surface's views the main column shows, in the order the render
  // below chooses them. A change replaces the whole column, so focus moves to the
  // incoming h1 (each has tabIndex -1) rather than staying on a control that no
  // longer exists. The first settle out of loading is the page arriving, not a
  // step, so it leaves focus at the top of the document.
  const surfaceView = managedSurfaceView(surfaceState);
  const surfaceRef = useRef<HTMLElement>(null);
  const previousSurfaceView = useRef(surfaceView);
  useEffect(() => {
    const previous = previousSurfaceView.current;
    previousSurfaceView.current = surfaceView;
    if (previous === surfaceView || previous === "loading") return;
    surfaceRef.current?.querySelector("h1")?.focus();
  }, [surfaceView]);

  return (
    <AppPage>
      <main className={styles.lobby} ref={surfaceRef}>
        {load.kind === "missing" ? (
          <>
            <h1 tabIndex={-1}>Exchange not found</h1>
            <p className={styles.sub}>
              This exchange&apos;s browser copy was not found. It may have been
              deleted or cleared.
            </p>
            <SavedExchangesFoot />
          </>
        ) : load.kind === "unloadable" ? (
          <>
            <h1 tabIndex={-1}>This exchange cannot be loaded</h1>
            <p className={styles.sub}>
              This exchange&apos;s stored copy can no longer be loaded by this
              version of the app. Re-invite your partner to set up the exchange
              again.
            </p>
            <SavedExchangesFoot />
          </>
        ) : load.kind === "spent" ? (
          <SpentSurface
            spent={load.spent}
            refusedRun={load.byRefusedRun}
            parkedResultsRead={parkedResultsRead}
            onRetryParkedResultsRead={retryParkedResultsRead}
            onClearParkedResults={clearParked}
            id={id}
            onRetaken={readRecordAgain}
          />
        ) : load.kind === "configuration" ? (
          <ManagedConfigurationSurface
            record={load.configuration}
            onRecordEdited={editConfiguration}
            onDeleted={() => void navigate({ to: "/saved" })}
          />
        ) : load.kind === "loading" ? (
          <>
            <h1 tabIndex={-1}>Loading exchange</h1>
            <Loader />
          </>
        ) : outputs !== undefined ? (
          <>
            <h1 tabIndex={-1}>Run complete</h1>
            <DonePanel outputs={outputs} finishedAt={finishedAt} />
            {runOutcomeUnsavedReason !== undefined && (
              <Alert
                color="yellow"
                title={RUN_OUTCOME_UNSAVED_NOTE.title}
                mb="sm"
              >
                <div>{RUN_OUTCOME_UNSAVED_NOTE.message}</div>
                <div>Reason: {runOutcomeUnsavedReason}.</div>
              </Alert>
            )}
            <RunWarningsAlert warnings={runWarnings} />
            <RunDownloads
              outputs={outputs}
              resultNote={
                folderWrite !== undefined && (
                  <FolderWriteNote write={folderWrite} />
                )
              }
            />
            {completion.backupHook !== undefined && (
              <div className={styles.callout}>
                <p className={styles.calloutLead}>Back up this exchange.</p>
                <p className={styles.small}>
                  This run rotated the stored secret, so your previous backup is
                  now out of date. Download an updated backup to keep it
                  current.
                </p>
                <p className={styles.small}>
                  The backup file holds the exchange&apos;s secret in plain
                  text. Keep it somewhere only you can read, and never send it
                  over an unencrypted channel.
                </p>
                {exportFailed && (
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
                  onClick={downloadUpdatedBackup}
                  loading={exportBusy}
                >
                  Download updated backup
                </Button>
              </div>
            )}
            <SavedExchangesFoot />
          </>
        ) : commandLineHandoff !== undefined ? (
          <>
            <h1 tabIndex={-1}>Handed off to the command line</h1>
            {commandLineHandoff.kind === "shown" ? (
              <>
                <p className={styles.sub}>
                  You exported this exchange&apos;s alcove.yaml and .alcove.key,
                  so it no longer runs here. Run it on the machine you saved
                  them to:
                </p>
                <p className={styles.mono}>{commandLineHandoff.runCommand}</p>
              </>
            ) : (
              <>
                <p className={styles.sub}>
                  You exported this exchange&apos;s alcove.yaml and .alcove.key,
                  so it no longer runs here.
                </p>
                <p className={styles.small}>{commandLineHandoff.notice}</p>
              </>
            )}
            <p className={styles.small}>
              Those two files are the only copy of this exchange that can run.
              Keep them somewhere only you can read.
            </p>
            <SavedExchangesFoot />
          </>
        ) : handoff.migration.kind === "migrated" ? (
          <>
            <h1 tabIndex={-1}>Handed off to another device</h1>
            <p className={styles.sub}>
              You downloaded this exchange&apos;s backup to take over on another
              device, so it no longer runs here. Import that backup on the other
              device to run it there. Keep the file somewhere only you can read.
            </p>
            <SavedExchangesFoot />
          </>
        ) : migrationDispatch !== undefined ? (
          <>
            <h1 tabIndex={-1}>Confirm the move</h1>
            <p className={styles.sub}>
              Your exchange&apos;s backup file was downloaded. Confirm you saved
              it before this device gives up its copy: once you confirm, this
              exchange no longer runs here and you import the file on the other
              device to run it there.
            </p>
            {exportFailed && (
              <Alert
                role="alert"
                color="red"
                title="Could not hand off this exchange"
                mb="md"
              >
                This device&apos;s copy could not be handed off. It is still
                live here; try again.
              </Alert>
            )}
            <p className={styles.small}>
              Keep the file somewhere only you can read, and never send it over
              an unencrypted channel.
            </p>
            <p className={styles.small}>
              This exchange&apos;s accounting of disclosures stays on this
              device: it does not travel in the backup file. If you need to keep
              it, keep the exchange here for now, export the accounting as CSV,
              and then move it.
            </p>
            {runHoldsMigration && (
              <Alert color="yellow" title={RUN_IN_FLIGHT_HANDOFF_TITLE} mb="md">
                {RUN_IN_FLIGHT_HANDOFF_REASON}
              </Alert>
            )}
            {staleMigration && (
              <Alert
                color="yellow"
                title={
                  migrationRefusal === "record-gone"
                    ? RECORD_GONE_HANDOFF_TITLE
                    : SUPERSEDED_HANDOFF_TITLE
                }
                mb="md"
              >
                {migrationRefusal === "record-gone"
                  ? RECORD_GONE_HANDOFF_REASON
                  : supersededHandoffReason("migration")}
              </Alert>
            )}
            <p>
              <Button
                onClick={confirmMigration}
                loading={exportBusy}
                disabled={runInFlight || staleMigration}
              >
                I saved the file; hand off this exchange
              </Button>{" "}
              <Button
                variant="subtle"
                disabled={exportBusy}
                onClick={keepMigrationOnDevice}
              >
                {migrationRefusal === "record-gone"
                  ? "Close"
                  : "Keep it on this device"}
              </Button>
            </p>
          </>
        ) : (
          <>
            <h1 tabIndex={-1}>
              {load.record.label === ""
                ? "Run this exchange"
                : load.record.label}
            </h1>
            <p className={styles.sub}>
              Run this exchange again with the same partner, without a new
              invitation. Your partner must run their side at the same time.
            </p>
            {reinvite !== undefined ? (
              // A re-invite has superseded the failure: the record is rotated to the
              // fresh secret and its consumed failure cleared, so the stale tier alert
              // and its recovery are gone -- the operator forwards the fresh invitation
              // and the next run derives from the new secret.
              <ReinvitePanel
                record={load.record}
                reinvite={reinvite}
                panelRef={reinvitePanelRef}
              />
            ) : (
              failure !== undefined && (
                <>
                  <Alert role="alert" color="red" title={failure.title} mb="md">
                    <FailureBody failure={failure} />
                  </Alert>
                  {/* Below the failure, not in place of it: a run that stopped
                      after sending raises its own notice when it could not file
                      the disclosure, and that notice speaks for a run with no
                      completion surface to show it on. */}
                  <RunWarningsAlert warnings={runWarnings} />
                  {/* The recovery is the whole of what a compromise response
                      withholds: every branch of it either mints or asks a gate
                      the operator has answered. The failure's own account of
                      what happened stays above it. */}
                  {!compromiseResponse && (
                    <FailureRecovery
                      failure={failure}
                      record={load.record}
                      confirmationGated={confirmationGated}
                      reinviting={reinviting}
                      runInFlight={runInFlight}
                      runHoldsReinvite={runHoldsReinvite}
                      // The failed alert renders only at the site that triggered the
                      // mint, so the recovery and the detail section do not both show it.
                      reinviteFailed={managedReinviteFailedAt(
                        recovery,
                        "recovery",
                      )}
                      onReinvite={() => reinviteNow("recovery")}
                      onResolveConfirmation={resolveConfirmation}
                    />
                  )}
                </>
              )
            )}
            {compromiseResponse && (
              <CompromiseResponsePanel
                unsaved={compromiseWriteFailed}
                // The acknowledgement waits out the answer's own write, which it
                // cannot be taken ahead of.
                clearing={clearingStanding || respondingCompromise}
                clearFailed={clearStandingFailed}
                onAcknowledge={() => clearStanding(true)}
              />
            )}
            {showStanding && !compromiseResponse && (
              <StandingConditionSection
                record={load.record}
                view={standingView}
                settled={standingSettled}
                clearing={clearingStanding}
                clearFailed={clearStandingFailed}
                reinviting={reinviting}
                runInFlight={runInFlight}
                runHoldsReinvite={runHoldsReinvite}
                reinviteFailed={managedReinviteFailedAt(recovery, "recovery")}
                reinviteHeldByFailure={failureHoldsReinvite}
                onReinvite={() => reinviteNow("recovery")}
                onClear={() => clearStanding(false)}
                onResolve={resolveStanding}
              />
            )}
            {!hasFolder && folderGrantable && (
              <WorkingFolderPrompt onGrant={grantWorkingFolder} />
            )}
            {!hasFolder && !folderGrantable && (
              <div className={styles.callout}>
                <p className={styles.calloutLead}>Choose your input file.</p>
                <p className={styles.small}>
                  This browser cannot give a site a folder, so choose your file
                  for this run. Its contents are read in your browser and never
                  stored.
                </p>
                <FileButton
                  accept="text/csv,.csv"
                  onChange={(file) => file !== null && reselect(file)}
                >
                  {(props) => (
                    <Button mt="sm" variant="default" {...props}>
                      {reselected === undefined
                        ? "Choose file"
                        : `Chosen: ${reselected.name}`}
                    </Button>
                  )}
                </FileButton>
              </div>
            )}
            {load.localState?.termsProposal !== undefined && (
              <TermsProposalPanel
                proposal={load.localState.termsProposal}
                busy={termsProposal.kind === "busy"}
                disabled={running || runInFlight}
                failure={
                  termsProposal.kind === "failed"
                    ? termsProposal.failure
                    : undefined
                }
                onApply={() => void settleTermsProposal(true)}
                onDecline={() => void settleTermsProposal(false)}
              />
            )}
            {termsChangeQuestion !== undefined && (
              <TermsChangeQuestion
                change={termsChangeQuestion.change}
                onAnswer={termsChangeQuestion.answer}
              />
            )}
            <p>
              <Button
                onClick={run}
                loading={running}
                disabled={runInputSource === undefined || !online}
              >
                Run exchange
              </Button>
            </p>
            {!online && (
              <p className={styles.sub}>
                {OFFLINE_EXCHANGE_REASON} Everything else here is available.
              </p>
            )}
            {running && (
              <p className={styles.sub}>
                Connecting to your partner and running the exchange. Keep this
                tab open.
              </p>
            )}
            {running && matching !== undefined && (
              <p className={styles.sub}>{describeResolvedMatching(matching)}</p>
            )}
            <BackupPanel
              marker={load.backupMarker}
              busy={exportBusy}
              failed={exportFailed}
              runInFlight={runInFlight}
              onBackUp={backUp}
              onMigrate={migrate}
            />
            <ManagedCronExportPanel
              record={load.record}
              runInFlight={runInFlight}
              recheckRunInFlight={recheckLock}
              onHandedOff={handOffToCommandLine}
            />
            <ManagedExchangeDetail
              record={load.record}
              accountingRead={accountingRead}
              unfiledDisclosureRead={reads.unfiled}
              unrecordedRunFlagged={managedUnrecordedRunFlagged(reads, id)}
              parkedResultsRead={parkedResultsRead}
              onFileUnfiledDisclosures={fileUnfiled}
              onUnrecordedRunFlagShown={dropUnrecordedRunFlag}
              onResetAccounting={resetAccounting}
              onRetryAccountingRead={retryAccountingRead}
              onRetryParkedResultsRead={retryParkedResultsRead}
              onClearParkedResults={clearParked}
              onSaveLocalFields={saveLocalFields}
              onGrantWorkingFolder={grantWorkingFolder}
              onStopUsingWorkingFolder={stopUsingWorkingFolder}
              onReinviteToChangeTerms={() => reinviteNow("detail")}
              onTermsChanged={rereadRecord}
              onRelayRegistrationChanged={rereadRecord}
              canReinvite={canReinviteFromRecord(load.record)}
              compromiseResponse={compromiseResponse}
              runInFlight={runInFlight}
              runHoldsReinvite={runHoldsReinvite}
              reinviting={reinviting}
              // The failed alert renders here only when the detail section triggered
              // the mint, so it and the failure-path recovery do not both show it.
              reinviteFailed={managedReinviteFailedAt(recovery, "detail")}
            />
            <div className={styles.workFoot}>
              <DeleteExchangeButton
                id={load.record.id}
                label={load.record.label}
                backedUp={
                  deriveManagedBackupState(load.backupMarker).kind ===
                  "backed-up"
                }
                onDeleted={() => void navigate({ to: "/saved" })}
              />
            </div>
            {failure !== undefined && !managedRunRetryable(failure) && (
              <SavedExchangesFoot />
            )}
          </>
        )}
      </main>
    </AppPage>
  );
}

/** The recovery affordance a classified failure offers, below its alert: fast
 * re-invite for the re-invite tiers, the out-of-band confirmation and two-outcome gate
 * for the unexplained tier, and nothing extra for a retry/wait state (the run button
 * and the input picker are the recovery there). Thin over the pure model: the copy and
 * the routing are the model's; this renders the buttons. A composed re-invite renders
 * above this (the {@link ReinvitePanel}), so this never handles the minted artifacts.
 * The host renders none of this while a compromise response stands, showing the
 * {@link CompromiseResponsePanel} in its place. */
function FailureRecovery({
  failure,
  record,
  confirmationGated,
  reinviting,
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  onReinvite,
  onResolveConfirmation,
}: {
  failure: ManagedRunFailureAlert;
  record: ManagedExchangeRecord;
  confirmationGated: boolean;
  reinviting: boolean;
  runInFlight: boolean;
  runHoldsReinvite: boolean;
  reinviteFailed: boolean;
  onReinvite: () => void;
  onResolveConfirmation: (
    outcome: Parameters<typeof routeConfirmationReply>[0],
  ) => void;
}) {
  if (failure.recovery === "confirm") {
    // Past the gate on a confirmed partner-side failure, the recovery is fast
    // re-invite -- the same panel a direct re-invite tier shows (which mints for the
    // inviter and names asking the partner for the acceptor, with a retry on failure).
    if (confirmationGated)
      return (
        <ReinviteRecovery
          record={record}
          reinviting={reinviting}
          runInFlight={runInFlight}
          runHoldsReinvite={runHoldsReinvite}
          reinviteFailed={reinviteFailed}
          onReinvite={onReinvite}
        />
      );
    return (
      <ConfirmationPanel
        record={record}
        busy={reinviting}
        onResolve={onResolveConfirmation}
      />
    );
  }

  if (managedRunReinvites(failure))
    return (
      <ReinviteRecovery
        record={record}
        reinviting={reinviting}
        runInFlight={runInFlight}
        runHoldsReinvite={runHoldsReinvite}
        reinviteFailed={reinviteFailed}
        onReinvite={onReinvite}
      />
    );

  return null;
}

/** The alert every clearance shows when the store refused the write: the standing
 * condition's two legs and the compromise response's acknowledgement all take the
 * same write, and a rejected one leaves the condition standing wherever it was
 * taken from. */
function ClearFailureAlert() {
  return (
    <Alert role="alert" color="red" title="Could not clear this" mt="sm">
      Nothing changed here, so this still stands. Try again.
    </Alert>
  );
}

/**
 * The compromise response: the answer the operator gave at a failure gate, held on
 * the record so it stands at the next visit and not this one alone. It renders
 * wherever the page would have put a gate or an offer of a fresh invitation, since
 * minting on the channel the operator flagged is the act the response names as the
 * wrong one.
 *
 * The acknowledgement below it is the one way back to that offer from this page: the
 * operator reached the partner on another channel and heard the failure was theirs.
 * It clears the standing condition, and the response with it, and mints nothing --
 * the re-invite is offered again once the write lands (a re-invite and a delete are
 * the other two acts that clear it, and neither is reachable from here under one).
 */
function CompromiseResponsePanel({
  unsaved,
  clearing,
  clearFailed,
  onAcknowledge,
}: {
  /** Whether this device refused the write. The response holds this page either
   * way; an unsaved one ends when the page is left or a run starts, and says
   * so. */
  unsaved: boolean;
  clearing: boolean;
  clearFailed: boolean;
  onAcknowledge: () => void;
}) {
  return (
    <>
      {unsaved && (
        <Alert color="yellow" title={COMPROMISE_RESPONSE_UNSAVED_TITLE} mb="md">
          {COMPROMISE_RESPONSE_UNSAVED_REASON}
        </Alert>
      )}
      <Alert role="alert" color="red" title={COMPROMISE_RESPONSE_TITLE} mb="md">
        <span style={{ whiteSpace: "pre-line" }}>
          {COMPROMISE_RESPONSE_MESSAGE}
        </span>
        {!unsaved && (
          <p className={styles.small}>{COMPROMISE_RESPONSE_STANDS}</p>
        )}
      </Alert>
      <div className={styles.callout}>
        <p className={styles.calloutLead}>{COMPROMISE_ACKNOWLEDGE_LEAD}</p>
        <p className={styles.small}>{COMPROMISE_ACKNOWLEDGE_NOTE}</p>
        {clearFailed && <ClearFailureAlert />}
        <Button
          mt="sm"
          variant="default"
          loading={clearing}
          onClick={onAcknowledge}
        >
          {COMPROMISE_ACKNOWLEDGE_LABEL}
        </Button>
      </div>
    </>
  );
}

/**
 * The standing condition on the exchange's page: the unanswered evidence an
 * earlier run raised, carried past every no-show and success since, with the one
 * clearance a page offers.
 *
 * The copy and which clearance applies are the pure model's
 * ({@link managedStandingConditionView}); this renders them. The unexplained tier
 * goes through the same two-outcome gate the live Tier-2 failure uses, so a reply
 * that does not add up is written onto the record here exactly as it is there, and
 * clears nothing. Every other tier's explanation the record already holds, so it
 * gets the re-invite recovery and a short acknowledgement instead of an attack
 * checklist (docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack").
 *
 * Once cleared, the section keeps its place and shows the re-invite: settling a
 * condition is not the same act as re-establishing the secret it was raised over.
 * Where the live failure above holds that re-invite -- offering it, or holding the
 * gate that decides whether it happens -- the act is left to it, so there is one
 * control for it and no way around the gate. The host renders none of this while a
 * compromise response stands, showing the {@link CompromiseResponsePanel} in its
 * place.
 */
function StandingConditionSection({
  record,
  view,
  settled,
  clearing,
  clearFailed,
  reinviting,
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  reinviteHeldByFailure,
  onReinvite,
  onClear,
  onResolve,
}: {
  record: ManagedExchangeRecord;
  /** The condition as the page renders it, absent once nothing stands. */
  view: ManagedStandingConditionView | undefined;
  /** Whether the operator has cleared the condition on this visit. */
  settled: boolean;
  clearing: boolean;
  clearFailed: boolean;
  reinviting: boolean;
  runInFlight: boolean;
  runHoldsReinvite: boolean;
  reinviteFailed: boolean;
  /** Whether the live failure above holds the re-invite: it offers the mint itself,
   * or it holds the gate deciding whether one happens. Either way this section shows
   * its status and its clearance and no control of its own. */
  reinviteHeldByFailure: boolean;
  onReinvite: () => void;
  onClear: () => void;
  onResolve: (outcome: Parameters<typeof routeConfirmationReply>[0]) => void;
}) {
  const offersReinvite = !reinviteHeldByFailure;
  const clearFailure = clearFailed ? <ClearFailureAlert /> : null;
  if (settled)
    return offersReinvite ? (
      <ReinviteRecovery
        record={record}
        reinviting={reinviting}
        runInFlight={runInFlight}
        runHoldsReinvite={runHoldsReinvite}
        reinviteFailed={reinviteFailed}
        onReinvite={onReinvite}
      />
    ) : null;
  if (view === undefined) return null;
  const color = view.clearance === "confirmation" ? "red" : "yellow";
  return (
    <>
      <Alert
        color={color}
        role={alertRoleFor(color)}
        title={view.title}
        mb="md"
      >
        {view.message}
      </Alert>
      {view.clearance === "confirmation" ? (
        <>
          <ConfirmationPanel
            record={record}
            busy={clearing}
            onResolve={onResolve}
          />
          {clearFailure}
        </>
      ) : (
        <>
          {offersReinvite && (
            <ReinviteRecovery
              record={record}
              reinviting={reinviting}
              runInFlight={runInFlight}
              runHoldsReinvite={runHoldsReinvite}
              reinviteFailed={reinviteFailed}
              onReinvite={onReinvite}
            />
          )}
          {clearFailure}
          <Button
            mt="sm"
            variant="default"
            loading={clearing}
            onClick={onClear}
          >
            {STANDING_CONDITION_CLEAR_LABEL}
          </Button>
        </>
      )}
    </>
  );
}

/** The re-invite recovery for a re-invite tier (lapsed, storage, imported). The
 * inviter side re-mints from the stored document, so it gets the mint action; the
 * acceptor side cannot mint an inviter-namespace invitation from its mirrored
 * perspective, so its recovery is to ask the partner to send a fresh invitation,
 * accept it, and delete the record that accept supersedes. Both readings are the pure
 * model's, composed from the record's own `side` ({@link managedReinviteRecoveryCopy});
 * this renders them. */
function ReinviteRecovery({
  record,
  reinviting,
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  onReinvite,
}: {
  record: ManagedExchangeRecord;
  reinviting: boolean;
  /** Whether a run of this exchange is under way anywhere this browser profile
   * can see. The mint replaces the secret that run is connecting on, so the
   * control waits it out. */
  runInFlight: boolean;
  /** That same reading, or the mint write's own refusal when a run held the lock
   * at it. It states the reason; it does not disable the control, which the
   * reading gives back when the run ends. */
  runHoldsReinvite: boolean;
  reinviteFailed: boolean;
  onReinvite: () => void;
}) {
  const copy = managedReinviteRecoveryCopy(record);
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>{copy.lead}</p>
      {copy.body.map((paragraph) => (
        <p key={paragraph} className={styles.small}>
          {paragraph}
        </p>
      ))}
      {canReinviteFromRecord(record) && (
        <>
          {reinviteFailed && (
            <Alert
              role="alert"
              color="red"
              title="Could not create a fresh invitation"
              mb="sm"
            >
              Nothing changed here; try again.
            </Alert>
          )}
          <Button
            mt="sm"
            onClick={onReinvite}
            loading={reinviting}
            disabled={runInFlight}
          >
            Create a fresh invitation
          </Button>
          {runHoldsReinvite && (
            <p className={styles.small}>{REINVITE_RUN_IN_FLIGHT_REASON}</p>
          )}
        </>
      )}
    </div>
  );
}

/** A forwardable, multi-paragraph message the operator must READ before sending: the
 * whole prose is shown in a visible, wrapped, readonly area with a copy action --
 * unlike {@link CopyRow}, which collapses a secret to a one-line head/tail preview. The
 * message has no secret (it interpolates only this record's own label and failure
 * time), so showing it in full is correct, not a leak. */
function ForwardableMessage({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className={styles.copyRow}>
      <span className={styles.copyLabel}>{label}</span>
      <textarea
        className={styles.forwardableMessage}
        readOnly
        value={value}
        aria-label={label}
        rows={value.split("\n").length}
      />
      {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        typeof navigator !== "undefined" && navigator.clipboard ? (
          <CopyButton value={value} timeout={1000}>
            {({ copied, copy }) => (
              <Button
                mt="sm"
                variant="default"
                onClick={copy}
                aria-label={
                  copied ? `${label} copied` : `Copy ${label.toLowerCase()}`
                }
              >
                {copied ? "Copied" : "Copy message"}
              </Button>
            )}
          </CopyButton>
        ) : null
      }
    </div>
  );
}

/** The Tier-2 out-of-band confirmation: the forwardable, pre-filled message the
 * operator copies and sends the partner, then the two-outcome gate. The message and
 * the gate labels are the pure model's; this renders them. */
function ConfirmationPanel({
  record,
  busy,
  onResolve,
}: {
  record: ManagedExchangeRecord;
  /** Whether the write a reply started is still in flight. Both legs are disabled
   * for it: the two outcomes are one answer, and a second click landing before the
   * write resolves would settle the condition under the other one. */
  busy: boolean;
  onResolve: (outcome: Parameters<typeof routeConfirmationReply>[0]) => void;
}) {
  const confirmation = composeManagedFailureConfirmation(record);
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>Confirm with your partner first.</p>
      <p className={styles.small}>
        Copy this message and send it to your partner on the trusted channel you
        use for this partnership (not a reply to whatever arrived here). It asks
        them to confirm their identity, report what their own tool saw, and say
        whether they ran from more than one place.
      </p>
      <ForwardableMessage
        label="Message to your partner"
        value={confirmation.message}
      />
      <p className={styles.small} style={{ marginTop: "0.75rem" }}>
        When they reply:
      </p>
      <p>
        <Button
          disabled={busy}
          onClick={() => onResolve("confirmed-partner-failure")}
        >
          {confirmation.confirmedOption}
        </Button>{" "}
        <Button
          color="red"
          variant="light"
          disabled={busy}
          onClick={() => onResolve("does-not-add-up")}
        >
          {confirmation.doesNotAddUpOption}
        </Button>
      </p>
    </div>
  );
}

/** The composed re-invite artifacts the operator forwards: the link and code holding
 * the fresh setup secret, and the accurate ongoing cost -- every re-invite puts a fresh
 * live secret on the out-of-band channel, so the confidentiality requirement is
 * ongoing, not one-time. */
function ReinvitePanel({
  record,
  reinvite,
  panelRef,
}: {
  record: ManagedExchangeRecord;
  reinvite: ManagedReinvite;
  /** Attached so a detail-triggered mint (which renders this panel far above the
   * button that fired it) can scroll it into view. */
  panelRef: Ref<HTMLDivElement>;
}) {
  return (
    <div className={styles.callout} ref={panelRef}>
      <p className={styles.calloutLead}>Send this fresh invitation.</p>
      <p className={styles.small}>
        Send this to your partner over your usual trusted channel (for example,
        secure email). It carries a new one-time secret, so treat it as
        confidential - every re-invite puts a fresh secret on that channel, so
        it must stay trusted each time. Your partner accepts it by opening the
        link.
      </p>
      <CopyRow label="Invitation as a link" value={reinvite.deepLink} />
      <CopyRow
        label="Invitation as text"
        noun="invitation"
        value={reinvite.encoded}
      />
      <p className={styles.small}>
        <strong>
          This invitation expires{" "}
          <span className={styles.mono}>
            {dateTimeLabel(new Date(reinvite.tokenExpires))}
          </span>
          .
        </strong>{" "}
        {record.label === ""
          ? "The exchange keeps its terms."
          : `"${record.label}" keeps its terms.`}
      </p>
    </div>
  );
}

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

/** The pre-run backup panel: the derived backup state ("backed up as of <date>" or
 * the actionable "Back up this exchange") plus the two export intents that download
 * the artifact this browser restores from. A backup export leaves this exchange live;
 * a migration export hands it off to another device, spending this copy. Both are
 * named against the command-line export below, whose two files bring back no secret
 * (its `alcove.yaml` imports as a configuration only), so the state this panel shows
 * is about the restorable file alone.
 * The custody guidance matches the CLI key file's: the file is a plaintext credential
 * to keep under owner-only custody. */
function BackupPanel({
  marker,
  busy,
  failed,
  runInFlight,
  onBackUp,
  onMigrate,
}: {
  marker: ManagedBackupMarker | undefined;
  busy: boolean;
  failed: boolean;
  /** Whether a run of this exchange is in flight in any context. Only the migration
   * is withheld while it is: a backup leaves the source live, so taking one across a
   * rotation costs the operator nothing. */
  runInFlight: boolean;
  onBackUp: () => void;
  onMigrate: () => void;
}) {
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
function SpentSurface({
  spent,
  refusedRun = false,
  parkedResultsRead,
  onRetryParkedResultsRead,
  onClearParkedResults,
  id,
  onRetaken,
}: {
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
}) {
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
function RetakeControl({
  id,
  onRetaken,
}: {
  id: string;
  onRetaken: () => void;
}) {
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

/** What became of the copy of a completed run's results written into the
 * working folder, directly under the result download it does not replace. */
function FolderWriteNote({ write }: { write: AttendedFolderWrite }) {
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
function SavedExchangesFoot() {
  return (
    <div className={styles.workFoot}>
      <Button component={Link} to="/saved" variant="default">
        Back to recurring exchanges
      </Button>
    </div>
  );
}

/** Where a browser that can grant a folder holds none for this exchange: the one
 * prompt standing in for the run's input, since each run reads its input from
 * that folder. The click reaches the picker with no awaited work in front of it,
 * since a browser hands a site a folder only under the operator's gesture. */
function WorkingFolderPrompt({ onGrant }: { onGrant: () => Promise<void> }) {
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
