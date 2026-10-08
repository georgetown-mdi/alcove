import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { getLogger } from "@alcove/core";

import { triggerBlobDownload } from "@components/blobDownload";

import {
  ManagedHandoffRefusedError,
  dispatchManagedMigration,
  exportManagedBackup,
  managedBackupFileName,
} from "@psi/managed/managedExchangeExport";
import {
  ManagedReinviteWithheldError,
  clearManagedExchangeStandingCondition,
  getManagedExchange,
  persistManagedExchangeWorkingDirectory,
  readRecordAndMarkBackedUp,
  recordManagedExchangeCompromiseResponse,
  spendManagedExchangeIfCurrent,
  updateManagedExchangeLocalFields,
} from "@psi/managed/managedExchangeStore";
import { clearParkedResults } from "@psi/parkedResultsStore";
import { fileUnfiledDisclosures } from "@psi/unfiledDisclosureStore";
import { resetDisclosureAccounting } from "@psi/disclosureAccountingStore";
import { routeConfirmationReply } from "@psi/managed/managedFailureConfirmation";

import {
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { MANAGED_EXCHANGE_ARTIFACT_MIME } from "@psi/managed/managedExchangeArtifact";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { canReinviteFromRecord } from "@psi/managed/managedReinvite";

import {
  chooseManagedWorkingDirectory,
  storedWorkingDirectoryUsable,
  unallocatedResultsMessage,
  workingDirectoryGrantSupported,
  writeRunResultsToWorkingFolder,
} from "@psi/managed/managedWorkingDirectory";

import { getManagedLocalState } from "@psi/managed/managedLocalState";
import { managedRerunCompletion } from "@psi/managed/managedCompletionSurface";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";
import { runManagedExchangeInBrowser } from "@psi/managed/managedRunDriver";
import { whenDiagnostic } from "@utils/diagnostics";

import { appendSanitizedRunWarning } from "@psi/runWarnings";

import { useBeforeUnloadPrompt } from "@exchange/useUnloadGuard";

import {
  ManagedTermsChangeTakenOnError,
  applyManagedTermsProposal,
  declineManagedTermsProposal,
} from "@psi/managed/managedTermsProposal";

import {
  TERMS_CHANGE_TAKEN_ON_FAILURE,
  classifyManagedRunFailure,
} from "./managedRunLaunchModel";
import { termsProposalFailureText } from "./managedTermsChangeModel";
import { useManagedRunInFlight } from "./useManagedRunInFlight";

import {
  MANAGED_RUN_SURFACE_INITIAL,
  managedRunCompletion,
  managedRunInProgress,
  managedRunInputSource,
  managedRunLiveFailure,
  managedRunSurfaceReducer,
} from "./managedRunSurfaceModel";
import {
  managedCompromiseResponseActive,
  managedReinviteInFlight,
} from "./managedRunRecoveryModel";
import {
  managedMigrationAwaitingConfirm,
  managedMigrationStale,
} from "./managedRunHandoffModel";
import { useManagedSurfaceReads } from "./useManagedSurfaceReads";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedBackupMarker } from "@psi/managed/managedBackupState";
import type { ManagedCompromiseGate } from "./managedRunRecoveryModel";
import type { ManagedInputSource } from "@psi/managed/managedInputHandle";
import type { ManagedRunSurfaceState } from "./managedRunSurfaceModel";
import type { RunLines } from "./scheduledRunCommand";

const log = getLogger("ManagedRunSurface");

/** A reply to a failure gate's out-of-band confirmation. */
type ConfirmationReply = Parameters<typeof routeConfirmationReply>[0];

/** What {@link useManagedRunSurface} hands the run surface: the composed state,
 * the readings and choices that live beside it, and every command the surface's
 * controls take. */
export interface ManagedRunSurfaceHost {
  /** The composed surface state the render derives its views from. */
  state: ManagedRunSurfaceState;
  /** Whether a run of this exchange is in flight anywhere this browser profile
   * can see (see {@link useManagedRunInFlight}). */
  runInFlight: boolean;
  /** Re-read the run lock right now, resolving whether a run holds it. */
  recheckLock: () => Promise<boolean>;
  /** The input file the operator chose, on a browser that cannot grant a folder. */
  reselected: File | undefined;
  /** Choose the input file for the next run. */
  reselect: (file: File) => void;
  /** Whether the record has a working folder this browser can use. */
  hasFolder: boolean;
  /** Whether this browser can grant a site a folder at all. */
  folderGrantable: boolean;
  /** Where the next run reads its input; undefined while neither is available. */
  runInputSource: ManagedInputSource | undefined;
  /** The completion surface's backup affordance for a finished run. */
  completion: ReturnType<typeof managedRerunCompletion>;
  /** Start a run. */
  run: () => void;
  /** Download a backup, leaving this copy live. */
  backUp: () => void;
  /** Download the migration file and await the operator's attestation. */
  migrate: () => void;
  /** Spend this copy once the operator attests the migration file is saved. */
  confirmMigration: () => void;
  /** Keep this copy after a migration download. */
  keepMigrationOnDevice: () => void;
  /** Download the backup a finished run made current. */
  downloadUpdatedBackup: () => void;
  /** Show the command-line hand-off the cron export panel completed. */
  handOffToCommandLine: (lines: RunLines) => void;
  /** Mint a fresh invitation, from the recovery or the detail section. */
  reinviteNow: (source: "recovery" | "detail") => void;
  /** Route the reply to the live failure's confirmation gate. */
  resolveConfirmation: (outcome: ConfirmationReply) => void;
  /** Clear the standing condition; `pastResponse` when taken from under a
   * compromise response. */
  clearStanding: (pastResponse: boolean) => void;
  /** Route the reply to the standing condition's confirmation gate. */
  resolveStanding: (outcome: ConfirmationReply) => void;
  /** Persist an edit to the record's local fields; rejects when it did not save. */
  saveLocalFields: (edits: ManagedExchangeLocalEdits) => Promise<void>;
  /** Ask for a working folder and persist the grant. */
  grantWorkingFolder: () => Promise<void>;
  /** Drop the record's working folder. */
  stopUsingWorkingFolder: () => Promise<void>;
  /** File the disclosures the unfiled-run note retained, then re-read. */
  fileUnfiled: () => Promise<void>;
  /** Delete the accounting this build cannot read, then re-read. */
  resetAccounting: () => Promise<void>;
  /** Read the accounting again after a read that never reached the store. */
  retryAccountingRead: () => void;
  /** Read the parked results again after a read that never reached the store. */
  retryParkedResultsRead: () => void;
  /** Delete the parked results, then re-read. */
  clearParked: () => Promise<void>;
  /** Drop the store's unrecorded-run flag once its alert has rendered. */
  dropUnrecordedRunFlag: () => void;
  /** Apply or decline the stored terms proposal. */
  settleTermsProposal: (apply: boolean) => Promise<void>;
  /** Load the record again after a re-take cleared the spent state. */
  readRecordAgain: () => void;
  /** Load the record again after a change elsewhere on the page wrote it. */
  rereadRecord: () => void;
  /** Adopt the record the configuration surface saved. */
  editConfiguration: (configuration: ManagedExchangeRecord) => void;
}

/**
 * The attended run surface's state and commands for managed exchange `id`: the
 * record load, the store reads beside it, the run with its reload-and-classify on
 * failure, and every recovery, hand-off and export the surface offers. Owns the
 * run's lifecycle too -- the unload prompt for the whole run, the abort on unmount,
 * and the revocation of each run's object URLs.
 */
export function useManagedRunSurface(id: string): ManagedRunSurfaceHost {
  const [reselected, setReselected] = useState<File>();
  const [surfaceState, dispatchSurface] = useReducer(
    managedRunSurfaceReducer,
    MANAGED_RUN_SURFACE_INITIAL,
  );
  const { load, run: runState, recovery, reads, handoff } = surfaceState;
  const exportBusy = handoff.export.kind === "busy";
  const migrationDispatch = managedMigrationAwaitingConfirm(handoff);
  const runnable = load.kind === "runnable" ? load : undefined;
  const record = runnable?.record;
  const localState = runnable?.localState;
  // Every store write this surface makes keeps the secret the record it read
  // holds -- a rotation, a local-fields edit, a folder grant -- so adopting the
  // returned record restates what this surface holds rather than admitting a
  // shape it has no controls for.
  const adoptRecord = useCallback(
    (updated: ManagedExchangeRecord) =>
      dispatchSurface({
        type: "record-adopted",
        record: runnableManagedExchangeOrRefuse(updated),
      }),
    [],
  );
  const running = managedRunInProgress(runState);
  const runCompletion = managedRunCompletion(runState);
  const outputs = runCompletion?.outputs;
  const finishedAt = runCompletion?.finishedAt;
  const liveFailure = managedRunLiveFailure(runState);
  // Every hand-off affordance on this surface, plus the re-invite mint below, reads
  // one in-flight signal, which sees a run started anywhere in this browser profile
  // -- here, in a second tab, or by the scheduled runtime -- not just the one this
  // surface started.
  const { inFlight: runInFlight, recheckLock } = useManagedRunInFlight(
    id,
    running,
  );
  const staleMigration = managedMigrationStale(handoff);
  // How many runs this visit has started, so each failure gets a number of its own.
  const runsStarted = useRef(0);
  // The compromise response is the record's own, written at whichever gate the
  // operator answered and read back off the record this page holds, so one answer
  // covers both gates and is still in force at the next visit.
  const compromiseResponse = managedCompromiseResponseActive(recovery, record);
  const respondingCompromise = recovery.compromise.write.kind === "writing";
  const clearingStanding = recovery.standing.clear.kind === "clearing";
  const reinviting = managedReinviteInFlight(recovery);

  // A single AbortController per in-flight run, aborted on unmount so a torn-down
  // surface stops the rendezvous, the connection, and the exchange.
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    },
    [],
  );

  // A run is a live two-party session with no resumption: an unload ends it, the
  // partner's side fails with it, and nothing else on the page intercepts one.
  // The app-shell update notice renders above every route, so its Reload button
  // is reachable throughout a run -- this is what puts the browser's own
  // confirmation in front of it, and in front of a tab close or a typed URL.
  useBeforeUnloadPrompt(running);

  useEffect(() => {
    let live = true;
    Promise.all([getManagedExchange(id), getManagedLocalState(id)])
      .then(([loaded, local]) => {
        if (live)
          dispatchSurface({
            type: "record-read",
            record: loaded,
            localState: local,
          });
      })
      .catch(() => {
        if (live) dispatchSurface({ type: "record-read-failed" });
      });
    return () => {
      live = false;
    };
  }, [id, load.reads]);

  const { dropUnrecordedRunFlag } = useManagedSurfaceReads(
    id,
    reads,
    finishedAt,
    dispatchSurface,
  );

  // Revoke the run's object URLs when they are replaced or the surface unmounts:
  // the results blob is matched-record PII and the keys blob is private material.
  useEffect(() => {
    if (outputs === undefined) return;
    return () => {
      if (outputs.kind === "matched")
        window.URL.revokeObjectURL(outputs.resultsUrl);
      if (outputs.record !== undefined) {
        window.URL.revokeObjectURL(outputs.record.recordUrl);
        window.URL.revokeObjectURL(outputs.record.keysUrl);
      }
    };
  }, [outputs]);

  // With a usable working folder the run reads its input from it (attended, so a
  // gone permission may be re-prompted once). A browser that can grant a folder
  // runs from one and asks for it until it is chosen; one that cannot has the
  // operator choose the file each run.
  const folder = record?.workingDirectoryHandle;
  const usableFolder = storedWorkingDirectoryUsable(folder)
    ? folder
    : undefined;
  const hasFolder = usableFolder !== undefined;
  const folderGrantable = workingDirectoryGrantSupported();

  const runInputSource = managedRunInputSource({
    recordLoaded: record !== undefined,
    usableFolder,
    folderGrantable,
    chosenFile: reselected,
  });

  function run() {
    const source = runInputSource;
    if (record === undefined || source === undefined || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    runsStarted.current += 1;
    const runNumber = runsStarted.current;
    dispatchSurface({ type: "run-started" });
    // This run's phase boundary, read by the failure classification below: a state
    // whose copy says nothing left this device is only accurate before it, and the
    // record's own bookkeeping cannot stand in (its write is best-effort, and the
    // fallback path below classifies against a pre-run record). Local to this run,
    // not React state -- nothing renders from it, and a later run starts fresh.
    let dataExchangeStarted = false;
    void (async () => {
      // The record the store holds at this launch, read before the run so this
      // run's own bookkeeping stamp cannot be in it. A rejected read, or one that
      // finds no record, leaves the surface's held record standing in for this run.
      let launched: RunnableManagedExchangeRecord = record;
      try {
        const reread = await getManagedExchange(record.id).catch(
          () => undefined,
        );
        // A re-read holding no secret is not this run's to act on: the
        // surface's own record stands in, and the run's own gates decide.
        launched =
          reread !== undefined && runnableManagedExchange(reread)
            ? reread
            : record;
        if (controller.signal.aborted) return;
        // The blob behind each URL, so the folder write takes the same bytes the
        // download offers rather than reading them back out of a URL.
        const created = new Map<string, Blob>();
        const result = await runManagedExchangeInBrowser({
          record: launched,
          source,
          signal: controller.signal,
          urls: {
            create: (blob) => {
              const url = window.URL.createObjectURL(blob);
              created.set(url, blob);
              return url;
            },
            revoke: (url) => {
              window.URL.revokeObjectURL(url);
              created.delete(url);
            },
          },
          // Attended: fail fast when a run is already in progress elsewhere,
          // surfacing the benign "already running" state rather than waiting.
          options: {
            lock: { ifAvailable: true },
            onDataExchangeStart: () => {
              dataExchangeStarted = true;
            },
          },
          onWarning: (message) => {
            const [escapedWarning] = appendSanitizedRunWarning([], message);
            dispatchSurface({ type: "warning-raised", escapedWarning });
          },
          onResolvedMatching: (resolved) =>
            dispatchSurface({ type: "matching-resolved", matching: resolved }),
          // Asked in a dialog while the partner's run waits at the terms
          // exchange. Tearing the run down answers no, so the exchange never
          // waits on a question nobody can see.
          decideTermsChange: (change) =>
            new Promise<boolean>((resolve) => {
              let answered = false;
              const answer = (accept: boolean) => {
                if (answered) return;
                answered = true;
                controller.signal.removeEventListener("abort", onAbort);
                dispatchSurface({ type: "terms-change-answered" });
                resolve(accept);
              };
              const onAbort = () => answer(false);
              controller.signal.addEventListener("abort", onAbort);
              dispatchSurface({
                type: "terms-change-asked",
                question: { change, answer },
              });
            }),
        });
        // The run can resolve after the surface unmounts; the getter can flip true
        // across the await even though the launch check above narrowed it (ESLint
        // models the getter as a literal, hence the disable).
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (controller.signal.aborted) return;
        dispatchSurface({
          type: "run-completed",
          outputs: result.exchange,
          finishedAt: new Date(),
          unsavedReason: result.lastRunSaved
            ? undefined
            : result.lastRunNotSavedReason,
        });
        if (result.exchange.kind !== "matched") return;
        const directory = launched.workingDirectoryHandle;
        if (directory === undefined || !storedWorkingDirectoryUsable(directory))
          return;
        const csv = created.get(result.exchange.resultsUrl);
        if (csv === undefined) {
          log.error(
            unallocatedResultsMessage(
              `managed exchange ${launched.id}`,
              "nothing was written to the working folder",
            ),
          );
          return;
        }
        dispatchSurface({
          type: "folder-write-started",
          directoryName: directory.name,
        });
        // Once started, the write completes even if the surface is torn down:
        // every run's results reach the folder. Only what follows it is gated.
        const delivery = await writeRunResultsToWorkingFolder(
          launched,
          result.lastRun.at,
          csv,
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (controller.signal.aborted) return;
        if (delivery.kind === "no-folder") {
          dispatchSurface({ type: "folder-write-skipped" });
          return;
        }
        if (delivery.kind === "write-failed")
          whenDiagnostic(() => console.error(delivery.error));
        dispatchSurface({
          type: "folder-write-finished",
          write: { directoryName: directory.name, delivery },
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        // The raw error can embed partner-/server-controlled bytes and displays as an
        // internal message, so it stays in the dev-gated console; the surface shows
        // the classified copy, and the escaped error where the state's placement
        // shows one (`managedRunLaunchModel`).
        whenDiagnostic(() => console.error(error));
        // The tier is derived from the record's OWN bookkeeping, which the run path
        // just stamped (the auth/transport/storage/input/cancelled
        // failureKind), so the record and its import marker are reloaded before
        // classifying -- an unattended run's failure would show through the same
        // tiers at the next visit. A corrupted record or sibling entry makes the
        // reload reject (a ZodError); rather than skip setLiveFailure entirely
        // (spinner clears, no error UI, unhandled rejection), fall back to the
        // launch reading and no sibling state, so the original error still shows
        // through the generic tier.
        //
        // The classification also gets the record as the store held it at this
        // launch, read before the run so this run's own stamp is not in it. A
        // no-show's stamp replaces `lastRun` and has no failureKind, so the
        // reloaded record alone cannot say whether a standing desync signal was
        // there to outrank the benign no-show reading.
        const [reloaded, local] = await Promise.all([
          getManagedExchange(record.id),
          getManagedLocalState(record.id),
        ]).catch(() => {
          whenDiagnostic(() =>
            console.error("managed run failure reload failed"),
          );
          return [undefined, undefined] as const;
        });
        // The reload can resolve after the surface unmounts; the getter can flip true
        // across the await even though the earlier catch check narrowed it (ESLint
        // models the getter as a literal, hence the disable).
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (controller.signal.aborted) return;
        if (local !== undefined || reloaded !== undefined)
          dispatchSurface({ type: "local-state-reloaded", localState: local });
        if (error instanceof ManagedTermsChangeTakenOnError) {
          if (reloaded !== undefined && runnableManagedExchange(reloaded))
            dispatchSurface({ type: "record-adopted", record: reloaded });
          dispatchSurface({ type: "record-read-requested" });
          dispatchSurface({
            type: "run-failed",
            failure: { alert: TERMS_CHANGE_TAKEN_ON_FAILURE, runNumber },
          });
          return;
        }
        const failed = classifyManagedRunFailure(
          error,
          { atLaunch: launched, afterRun: reloaded ?? launched },
          local,
          Date.now(),
          dataExchangeStarted,
        );
        // A run the hand-off refused moves the surface into the spent state here,
        // rather than leaving the run controls standing over a copy this device no
        // longer owns until the operator reloads. It is taken from the CLASSIFIED
        // state rather than the raw error, so the phase-boundary guard the
        // classification holds decides it: a refusal that somehow arrived past
        // the first peer-visible payload is not this benign state and keeps the
        // generic failure surface. The reload beside it supplies the date and the
        // hand-off the spent surface names, and a reload that did not answer costs
        // those and not the state.
        if (failed.kind === "handed-off") {
          dispatchSurface({ type: "run-handed-off", spent: local?.spent });
          return;
        }
        dispatchSurface({
          type: "run-failed",
          failure: { alert: failed, runNumber },
        });
      } finally {
        if (!controller.signal.aborted)
          dispatchSurface({ type: "run-settled" });
        abortRef.current = undefined;
      }
    })();
  }

  const downloadArtifact = (fileName: string, content: string) =>
    triggerBlobDownload(fileName, content, MANAGED_EXCHANGE_ARTIFACT_MIME);

  // The two artifact exports read the record fresh from the store and mark it in one
  // atomic step (readRecordAndMarkBackedUp), so a mount-time React snapshot -- with a
  // pre-rotation secret -- is never what an export serializes or the marker attests.
  const exportDeps = {
    readAndMark: readRecordAndMarkBackedUp,
    download: downloadArtifact,
    now: () => new Date(),
  };

  // A backup export leaves the source live; a migration export hands the secret off
  // and spends this device's copy -- but only once the operator attests the file is
  // saved (a dismissed save leaves the source live). Both read the current record and
  // mark backed-up atomically, so the source displays green after a backup and a spent
  // copy holds a current artifact -- the ordering managedExchangeExport.test.ts
  // drives, marking before a spend is possible and refusing a superseded artifact.
  function backUp() {
    if (record === undefined || exportBusy) return;
    dispatchSurface({ type: "export-started" });
    void exportManagedBackup(record.id, exportDeps).then(
      (result) =>
        dispatchSurface({
          type: "backup-exported",
          marker: downloadedMarker(result.backedUpAt),
        }),
      () => dispatchSurface({ type: "export-failed" }),
    );
  }

  // Dispatching mid-run only manufactures an artifact the confirmation will refuse:
  // the run rotates past it before the operator can attest to it.
  function migrate() {
    if (record === undefined || exportBusy || runInFlight) return;
    dispatchSurface({ type: "export-started" });
    void dispatchManagedMigration(record.id, {
      ...exportDeps,
      spendIfCurrent: spendManagedExchangeIfCurrent,
    }).then(
      (dispatch) =>
        dispatchSurface({
          type: "migration-dispatched",
          dispatch,
          marker: downloadedMarker(dispatch.backedUpAt),
        }),
      () => dispatchSurface({ type: "export-failed" }),
    );
  }

  // The operator attested the downloaded migration file is saved: spend the source
  // (this device's copy transitions to the spent load state on the next visit). The
  // spend itself refuses a run in flight and an artifact the record has rotated
  // past, so this classifies those refusals rather than guarding against them.
  function confirmMigration() {
    const dispatch = migrationDispatch;
    if (dispatch === undefined || exportBusy || runInFlight || staleMigration)
      return;
    dispatchSurface({ type: "migration-confirm-started" });
    void (async () => {
      try {
        // The gate above renders from a poll, so a run started since the last
        // reading is still news here; re-reading also puts the reason on screen.
        // A run this reading still misses is refused by the spend itself, which
        // takes the run's own lock.
        if (await recheckLock()) {
          dispatchSurface({ type: "export-finished" });
          return;
        }
        await dispatch.confirm(new Date());
        dispatchSurface({ type: "migration-confirmed" });
      } catch (error) {
        if (error instanceof ManagedHandoffRefusedError)
          dispatchSurface({
            type: "migration-refused",
            refusal: error.refusal,
          });
        else dispatchSurface({ type: "export-failed" });
      }
    })();
  }

  // The run just rotated the secret, so the previous backup is stale; the completion
  // surface offers "download updated backup", which reads the just-rotated secret
  // fresh from the store and marks the backup current (returning the exchange to
  // green). It reads by id, never the mount-time React record, so it exports the
  // rotated secret the store now holds.
  const completion =
    record === undefined
      ? managedRerunCompletion()
      : managedRerunCompletion({
          downloadUpdatedBackup: () =>
            exportManagedBackup(record.id, exportDeps).then(() => undefined),
        });

  // Drive the completion surface's refreshed backup with the shared busy/failure
  // state, so a failed export shows without claiming the backup was taken.
  function downloadUpdatedBackup() {
    if (completion.backupHook === undefined || exportBusy) return;
    dispatchSurface({ type: "export-started" });
    void completion.backupHook.downloadUpdatedBackup().then(
      () => dispatchSurface({ type: "export-finished" }),
      () => dispatchSurface({ type: "export-failed" }),
    );
  }

  // Fast re-invite: compose a fresh invitation from the record's OWN document (terms
  // and locator), persist the fresh secret onto the record, and hand the operator the
  // shareable artifacts to forward out-of-band. The operator re-authors nothing. The
  // driver returns the rotated record; adopting it drops the stale in-memory secret so
  // a subsequent run derives the rendezvous from the fresh one, and clearing the
  // consumed failure shows "fresh invitation sent" rather than the recovered tier.
  function reinviteNow(source: "recovery" | "detail") {
    // Closed at the mint rather than at each control that reaches it, whichever part
    // of the page asked: while a compromise response stands, a fresh invitation on
    // this channel would hand the new secret to whoever is interfering, and a run in
    // flight is connecting on the secret the mint replaces. Both halves are a second
    // check over the store's own refusals, which are decided on the record the store
    // reads and the lock a run holds rather than on this page's copy.
    if (record === undefined || reinviting || compromiseResponse || runInFlight)
      return;
    dispatchSurface({ type: "reinvite-started", site: source });
    void (async () => {
      try {
        // The controls above render from a poll, so a run started since the last
        // reading is still news here; re-reading also puts the reason on screen. A
        // run this reading still misses is refused by the mint's own write, which
        // takes the run's lock.
        if (await recheckLock()) {
          dispatchSurface({ type: "reinvite-held-by-run" });
          return;
        }
        const result = await reinviteManagedExchange(record);
        dispatchSurface({
          type: "reinvite-composed",
          reinvite: result.reinvite,
          record: runnableManagedExchangeOrRefuse(result.record),
        });
      } catch (error) {
        // The store refuses the rotation over an answer this page has not read, and
        // that is not a failure to retry: the page adopts the withhold and offers the
        // acknowledgement instead.
        if (error instanceof ManagedReinviteWithheldError) {
          dispatchSurface({ type: "reinvite-withheld" });
        } else if (error instanceof ManagedExchangeLockUnavailableError) {
          dispatchSurface({ type: "reinvite-refused-by-run" });
        } else {
          whenDiagnostic(() => console.error(error));
          dispatchSurface({ type: "reinvite-failed" });
        }
      }
    })();
  }

  // Write the operator's answer that nothing adds up onto the record, so the mint
  // stays withheld past this visit. Both gates route here; the record the store
  // holds is what the write attaches the answer to, and the page adopts it.
  function respondCompromise(gate: ManagedCompromiseGate) {
    if (record === undefined || respondingCompromise) return;
    dispatchSurface({ type: "compromise-answer-started", gate });
    void recordManagedExchangeCompromiseResponse(
      record.id,
      new Date().toISOString(),
    )
      .then((updated) => {
        adoptRecord(updated);
        dispatchSurface({ type: "compromise-answer-written" });
      })
      .catch((error) => {
        whenDiagnostic(() => console.error(error));
        dispatchSurface({ type: "compromise-answer-failed" });
      });
  }

  // The two-outcome gate: a confirmed real partner-side failure proceeds to re-invite;
  // anything that does not add up routes to the compromise response (no quiet
  // re-invite on the possibly-compromised channel). The inviter side mints the fresh
  // invitation right away; the acceptor side cannot mint one from its mirrored
  // document, so the gated recovery names asking the partner instead.
  function resolveConfirmation(outcome: ConfirmationReply) {
    // No reply mints while a compromise response stands, including one raised at the
    // standing condition's gate: that channel is the one the operator flagged.
    if (compromiseResponse) return;
    if (routeConfirmationReply(outcome) === "compromise-response") {
      respondCompromise({ kind: "failure", runNumber: liveFailure?.runNumber });
      return;
    }
    dispatchSurface({
      type: "confirmation-granted",
      runNumber: liveFailure?.runNumber,
    });
    if (record !== undefined && canReinviteFromRecord(record))
      reinviteNow("recovery");
  }

  // The standing condition's clear-and-acknowledge: the operator's own act, and the
  // only clearance a page offers (a re-invite drops the condition in its own rotation
  // write, and deleting the exchange takes it with the record). The re-invite stays
  // offered afterwards, which is why the section holds its place rather than
  // disappearing on the write. `pastResponse` is the same act taken from under a
  // compromise response, which the write clears along with the condition holding it.
  function clearStanding(pastResponse: boolean) {
    // The answer's own write has to land first: a clear that overtook it would be
    // reverted by the answer arriving after it, leaving a response the operator has
    // already settled.
    if (record === undefined || clearingStanding || respondingCompromise)
      return;
    // The gate is not put again to an operator who answered it and then settled
    // it out-of-band: the failure they answered offers the mint again. Only that
    // failure -- a run since then raised one they have answered nothing about,
    // and it keeps its own gate.
    dispatchSurface({ type: "standing-clear-started", pastResponse });
    clearManagedExchangeStandingCondition(record.id)
      .then((updated) =>
        dispatchSurface({
          type: "standing-cleared",
          record: runnableManagedExchangeOrRefuse(updated),
        }),
      )
      .catch((error) => {
        whenDiagnostic(() => console.error(error));
        dispatchSurface({ type: "standing-clear-failed" });
      });
  }

  // The standing condition's two-outcome gate, the same routing the live Tier-2
  // failure takes: a confirmed partner-side failure clears the condition, and a reply
  // that does not add up clears nothing and routes to the compromise response.
  function resolveStanding(outcome: ConfirmationReply) {
    // The refusal the live gate's reply takes, for the same reason: no reply clears
    // or mints on a channel the operator has already flagged.
    if (compromiseResponse) return;
    if (routeConfirmationReply(outcome) === "compromise-response") {
      respondCompromise({ kind: "standing" });
      return;
    }
    clearStanding(false);
  }

  // Persist an in-place edit to the local fields (label, max-token-age policy)
  // through the single-transaction store path, then adopt the returned record so
  // the surface reflects the edit -- including the conservatively re-derived
  // `expires` an age-policy edit produces. The detail editor shows the failure;
  // rethrowing keeps its form and its "not saved" message accurate.
  async function saveLocalFields(
    edits: ManagedExchangeLocalEdits,
  ): Promise<void> {
    if (record === undefined) return;
    const updated = await updateManagedExchangeLocalFields(record.id, edits);
    adoptRecord(updated);
  }

  // The picker is reached with no awaited work in front of it: a browser hands a
  // site a folder only under the operator's own gesture, and an await before the
  // call spends it. A dismissed picker yields no handle and changes nothing.
  function grantWorkingFolder(): Promise<void> {
    const held = record;
    if (held === undefined) return Promise.resolve();
    return chooseManagedWorkingDirectory().then(async (directory) => {
      if (directory === undefined) return;
      adoptRecord(
        await persistManagedExchangeWorkingDirectory(held.id, directory),
      );
    });
  }

  async function stopUsingWorkingFolder(): Promise<void> {
    if (record === undefined) return;
    adoptRecord(await persistManagedExchangeWorkingDirectory(record.id, null));
  }

  // Queue a fresh read of the accounting, dropping the standing verdict as it
  // goes: the section returns to its in-flight state rather than rendering the
  // previous verdict and its buttons under a click that has already been taken --
  // which displays as an inert control, beside an irreversible one.
  function readAccountingAgain(): void {
    dispatchSurface({ type: "accounting-read-requested" });
  }

  // File the records the unfiled-run note retained, then read both again so the
  // section shows what the store holds afterwards: a filing that did not take
  // leaves the shortfall standing rather than an entry that is not there.
  async function fileUnfiled(): Promise<void> {
    await fileUnfiledDisclosures(id);
    readAccountingAgain();
  }

  // Destroy the accounting this build cannot read, then re-read it: the surface
  // shows what the store holds afterwards, so a delete that did not take leaves
  // the unreadable state standing rather than a stale empty one.
  async function resetAccounting(): Promise<void> {
    await resetDisclosureAccounting(id);
    readAccountingAgain();
  }

  // Read the accounting again after a read that never reached the store. It is
  // offered instead of asking for a page reload because a reload ends a run in
  // progress, while the blocked-open condition this recovers from clears on its
  // own as soon as the other tab's connection yields.
  function retryAccountingRead(): void {
    readAccountingAgain();
  }

  // Read the parked results again after a read that never reached the store,
  // dropping the standing verdict as it goes so the section returns to its
  // in-flight state rather than rendering a notice under a click already taken.
  // Offered instead of a page reload for the reason the accounting's retry is:
  // a reload ends a run in progress, and the blocked-open condition it recovers
  // from clears on its own.
  function retryParkedResultsRead(): void {
    dispatchSurface({ type: "parked-results-read-requested" });
  }

  // Read the store again after the answer, so the surface shows the terms the
  // exchange now holds and the proposal is gone.
  async function settleTermsProposal(apply: boolean): Promise<void> {
    const proposal = localState?.termsProposal;
    if (record === undefined || proposal === undefined) return;
    dispatchSurface({ type: "terms-proposal-started" });
    try {
      if (apply)
        await applyManagedTermsProposal(record.id, proposal.proposedAt);
      else await declineManagedTermsProposal(record.id);
      dispatchSurface({ type: "terms-proposal-settled" });
    } catch (error) {
      whenDiagnostic(() => console.error(error));
      dispatchSurface({
        type: "terms-proposal-failed",
        failure: termsProposalFailureText(error),
      });
    }
  }

  // Load the record and its sibling state again after a re-take has cleared the
  // spent state, so what the surface shows is what the store holds rather than the
  // re-take's own answer: the load is the one place the run affordance, the backup
  // state, and the standing condition are derived.
  function readRecordAgain(): void {
    dispatchSurface({ type: "record-retaken" });
  }

  // Remove everything this exchange's scheduled runs left in this browser, then
  // read the store again: what the section shows afterwards is what the store
  // holds, not an assumption that the delete took. A rejection reaches the
  // control, which keeps its confirm open and states the failure.
  async function clearParked(): Promise<void> {
    await clearParkedResults(id);
    dispatchSurface({ type: "parked-results-read-requested" });
  }

  return {
    state: surfaceState,
    runInFlight,
    recheckLock,
    reselected,
    reselect: setReselected,
    hasFolder,
    folderGrantable,
    runInputSource,
    completion,
    run,
    backUp,
    migrate,
    confirmMigration,
    keepMigrationOnDevice: () => dispatchSurface({ type: "migration-kept" }),
    downloadUpdatedBackup,
    handOffToCommandLine: (lines) =>
      dispatchSurface({ type: "command-line-handed-off", handoff: lines }),
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
    rereadRecord: () => dispatchSurface({ type: "record-read-requested" }),
    editConfiguration: (configuration) =>
      dispatchSurface({ type: "configuration-edited", configuration }),
  };
}

/** The marker a download export stamped as of `backedUpAt`, for the panel to show
 * without a second store read. */
function downloadedMarker(backedUpAt: Date): ManagedBackupMarker {
  return {
    backedUpAt: backedUpAt.toISOString(),
    savedAs: {
      kind: "downloaded",
      fileName: managedBackupFileName(backedUpAt),
    },
  };
}
