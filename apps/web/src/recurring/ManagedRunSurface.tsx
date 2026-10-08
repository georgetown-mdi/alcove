import { useEffect, useRef } from "react";

import { Alert, Button, FileButton, Loader } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";

import { describeResolvedMatching } from "@alcove/core";

import { useOnlineStatus } from "@components/useOnlineStatus";

import { canReinviteFromRecord } from "@psi/managed/managedReinvite";

import { deriveManagedBackupState } from "@psi/managed/managedBackupState";

import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";

import {
  DonePanel,
  FailureBody,
  RunDownloads,
  RunWarningsAlert,
} from "@exchange/RunSurface";
import { AppPage } from "@components/AppPage";
import styles from "@styles/app.module.css";

import {
  RUN_OUTCOME_UNSAVED_NOTE,
  managedRunRetryable,
} from "./managedRunLaunchModel";
import { TermsChangeQuestion, TermsProposalPanel } from "./ManagedTermsChange";

import {
  BackupPanel,
  FolderWriteNote,
  SavedExchangesFoot,
  SpentSurface,
  WorkingFolderPrompt,
} from "./ManagedRunSections";
import {
  CompromiseResponsePanel,
  FailureRecovery,
  ReinvitePanel,
  StandingConditionSection,
} from "./ManagedRunRecovery";
import {
  RECORD_GONE_HANDOFF_REASON,
  RECORD_GONE_HANDOFF_TITLE,
  RUN_IN_FLIGHT_HANDOFF_REASON,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
  SUPERSEDED_HANDOFF_TITLE,
  supersededHandoffReason,
} from "./managedHandoffGate";
import { DeleteExchangeButton } from "./SavedExchanges";
import { ManagedConfigurationSurface } from "./ManagedConfigurationSurface";
import { ManagedCronExportPanel } from "./ManagedCronExportPanel";
import { ManagedExchangeDetail } from "./ManagedExchangeDetail";
import { managedStandingConditionView } from "./managedStandingConditionModel";
import { useManagedRunSurface } from "./useManagedRunSurface";

import {
  managedConfirmationGranted,
  managedFailureHoldsReinvite,
  managedReinviteFailedAt,
  managedRunHoldsReinvite,
  managedStandingConditionShown,
} from "./managedRunRecoveryModel";
import {
  managedMigrationRefusal,
  managedRunHoldsMigration,
} from "./managedRunHandoffModel";
import { managedSurfaceView } from "./managedRunSurfaceModel";
import { managedUnrecordedRunFlagged } from "./managedSurfaceReadsModel";

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
    running,
    liveFailure,
    runCompletion,
    migrationDispatch,
    staleMigration,
    compromiseResponse,
    reinviting,
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
  const migrationRefusal = managedMigrationRefusal(handoff);
  const commandLineHandoff = handoff.commandLine;
  const runnable = load.kind === "runnable" ? load : undefined;
  const record = runnable?.record;
  const localState = runnable?.localState;
  const outputs = runCompletion?.outputs;
  const folderWrite = runCompletion?.folderWrite;
  const finishedAt = runCompletion?.finishedAt;
  const runOutcomeUnsavedReason = runCompletion?.unsavedReason;
  // The hand-off has no failure copy of its own and never lands here: reaching it
  // moves the surface to the spent state below.
  const failure = liveFailure?.alert;
  const { warnings: runWarnings, matching, termsChangeQuestion } = runState;
  // The record, its detail, and the backup affordances all read the browser's own
  // store and render offline; a run is a live two-party session and cannot. Gating
  // the action names that rather than letting the operator press it into an opaque
  // connection failure. Only the offline direction is gated -- being online is no
  // promise the partner is there (see @utils/networkStatus).
  const online = useOnlineStatus();
  const runHoldsMigration = managedRunHoldsMigration(handoff, runInFlight);
  // The Tier-2 confirmation gate: once the operator confirms a real partner-side
  // failure, the surface proceeds to re-invite; a "does not add up" reply routes to
  // the compromise-response copy instead.
  const confirmationGated = managedConfirmationGranted(recovery, liveFailure);
  const respondingCompromise = recovery.compromise.write.kind === "writing";
  const compromiseWriteFailed = recovery.compromise.write.kind === "failed";
  const standingSettled = recovery.standing.settled;
  const clearingStanding = recovery.standing.clear.kind === "clearing";
  const clearStandingFailed = recovery.standing.clear.kind === "failed";
  const reinvite = recovery.reinvite.composed;
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
                onClick={() => keepMigrationOnDevice()}
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
