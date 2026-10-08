import {
  MANAGED_HANDOFF_INITIAL,
  managedHandoffReducer,
} from "./managedRunHandoffModel";
import {
  MANAGED_LOAD_INITIAL,
  managedLoadReducer,
} from "./managedRunLoadModel";
import {
  MANAGED_RECOVERY_INITIAL,
  managedRecoveryReducer,
} from "./managedRunRecoveryModel";
import {
  MANAGED_STORE_READS_INITIAL,
  managedStoreReadsReducer,
} from "./managedSurfaceReadsModel";

import type { Displayable, ResolvedMatching, TermsChange } from "@alcove/core";

import type { ManagedInputSource } from "@psi/managed/managedInputHandle";
import type { RunOutputs } from "@psi/runOutputs";

import type {
  ManagedHandoffAction,
  ManagedHandoffState,
} from "./managedRunHandoffModel";
import type {
  ManagedLoadAction,
  ManagedLoadState,
} from "./managedRunLoadModel";
import type {
  ManagedRecoveryAction,
  ManagedRecoveryState,
} from "./managedRunRecoveryModel";
import type {
  ManagedStoreReadAction,
  ManagedStoreReads,
} from "./managedSurfaceReadsModel";
import type { AttendedFolderWrite } from "./attendedFolderWriteModel";
import type { ManagedBackupMarker } from "@psi/managed/managedBackupState";
import type { ManagedMigrationDispatch } from "@psi/managed/managedExchangeExport";
import type { ManagedReinvite } from "@psi/managed/managedReinvite";
import type { ManagedRunFailureAlert } from "./managedRunLaunchModel";
import type { RunnableManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

/**
 * The attended re-run's state on the managed run surface and the events that move
 * it: whether a run is in progress, how the last one ended, and what the driver
 * reported along the way. No rendering and no I/O -- the surface runs the driver
 * and reports each outcome here as an action.
 *
 * A finished run's outputs show while its results are still being written to the
 * working folder, and the run counts as in progress until that write ends, so the
 * unload prompt and the in-flight reading cover the whole run.
 */

/** The classified failure on screen, with the number of the run that produced it.
 * Each tier's copy is a shared constant, so two runs failing the same way yield the
 * same alert object; the run number is what tells one failure from another, and it
 * is what a confirmation the operator gave at a gate is granted for. */
export interface LiveManagedRunFailure {
  /** The classified failure the surface renders. */
  alert: ManagedRunFailureAlert;
  /** Which of this visit's runs produced it, counting from one. */
  runNumber: number;
}

/** A terms change the partner proposed mid-run, asked in a dialog while the
 * partner's run waits at the terms exchange. `answer` resolves the driver's
 * question; the surface's abort answers no. */
export interface ManagedTermsChangeQuestion {
  change: TermsChange;
  answer: (accept: boolean) => void;
}

/** What a run that produced its outputs leaves on the completion surface. */
export interface ManagedRunCompletion {
  outputs: RunOutputs;
  finishedAt: Date;
  /** Why the store refused the run's success stamp, where it did. */
  unsavedReason: string | undefined;
  /** The copy of the results written into the working folder, absent where the
   * record holds no folder grant or the run left no file. */
  folderWrite: AttendedFolderWrite | undefined;
}

/** Where this visit's attended runs stand. `finishing` is a run whose outputs are
 * on screen while its folder write is still under way. */
export type ManagedRunPhase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "finishing"; completion: ManagedRunCompletion }
  | { kind: "complete"; completion: ManagedRunCompletion }
  | { kind: "failed"; failure: LiveManagedRunFailure };

/** The attended run's whole state on the surface. */
export interface ManagedRunState {
  phase: ManagedRunPhase;
  /** The run's non-fatal notices, in arrival order. Shown beside the outputs, or
   * beside the failure of a run that stopped after raising one. */
  warnings: ReadonlyArray<Displayable>;
  /** What the agreed `deduplicate` values resolved to, reported once the terms
   * are agreed, so the running copy can state the pair. */
  matching: ResolvedMatching | undefined;
  termsChangeQuestion: ManagedTermsChangeQuestion | undefined;
}

/** No run this visit. */
export const MANAGED_RUN_INITIAL: ManagedRunState = {
  phase: { kind: "idle" },
  warnings: [],
  matching: undefined,
  termsChangeQuestion: undefined,
};

/** The events of an attended run, in the order a run reports them. */
export type ManagedRunAction =
  | { type: "run-started" }
  /** Escaped by `appendSanitizedRunWarning` at the `onWarning` call, the one
   * display boundary every driver `onWarning` slot folds through. */
  | { type: "warning-raised"; escapedWarning: Displayable }
  | { type: "matching-resolved"; matching: ResolvedMatching }
  | { type: "terms-change-asked"; question: ManagedTermsChangeQuestion }
  | { type: "terms-change-answered" }
  | {
      type: "run-completed";
      outputs: RunOutputs;
      finishedAt: Date;
      unsavedReason: string | undefined;
    }
  | { type: "folder-write-started"; directoryName: string }
  | { type: "folder-write-finished"; write: Required<AttendedFolderWrite> }
  | { type: "folder-write-skipped" }
  | { type: "run-failed"; failure: LiveManagedRunFailure }
  | { type: "run-settled" }
  | { type: "failure-cleared" };

function withFolderWrite(
  state: ManagedRunState,
  folderWrite: AttendedFolderWrite | undefined,
): ManagedRunState {
  const { phase } = state;
  if (phase.kind !== "finishing" && phase.kind !== "complete") return state;
  return {
    ...state,
    phase: { ...phase, completion: { ...phase.completion, folderWrite } },
  };
}

/** An event that does not apply to the current phase returns `state` itself: a
 * failure once outputs are on screen, a folder-write event outside a completion,
 * a settle or a clear with nothing to end. */
export function managedRunReducer(
  state: ManagedRunState,
  action: ManagedRunAction,
): ManagedRunState {
  switch (action.type) {
    case "run-started":
      return {
        ...state,
        phase: { kind: "running" },
        warnings: [],
        matching: undefined,
      };
    case "warning-raised":
      return { ...state, warnings: [...state.warnings, action.escapedWarning] };
    case "matching-resolved":
      return { ...state, matching: action.matching };
    case "terms-change-asked":
      return { ...state, termsChangeQuestion: action.question };
    case "terms-change-answered":
      return { ...state, termsChangeQuestion: undefined };
    case "run-completed":
      return {
        ...state,
        phase: {
          kind: "finishing",
          completion: {
            outputs: action.outputs,
            finishedAt: action.finishedAt,
            unsavedReason: action.unsavedReason,
            folderWrite: undefined,
          },
        },
      };
    case "folder-write-started":
      return withFolderWrite(state, { directoryName: action.directoryName });
    case "folder-write-finished":
      return withFolderWrite(state, action.write);
    case "folder-write-skipped":
      return withFolderWrite(state, undefined);
    case "run-failed":
      // Outputs on screen stay there: the completion surface renders no failure.
      if (managedRunCompletion(state) !== undefined) return state;
      return { ...state, phase: { kind: "failed", failure: action.failure } };
    case "run-settled":
      if (state.phase.kind === "running")
        return { ...state, phase: { kind: "idle" } };
      if (state.phase.kind === "finishing")
        return { ...state, phase: { ...state.phase, kind: "complete" } };
      return state;
    case "failure-cleared":
      return state.phase.kind === "failed"
        ? { ...state, phase: { kind: "idle" } }
        : state;
  }
}

/** The answer to the partner's proposed terms change. A failure includes the
 * text the panel shows. */
export type ManagedTermsProposalRequest =
  { kind: "idle" } | { kind: "busy" } | { kind: "failed"; failure: string };

/** The terms proposal's events. Settling it also clears the run failure and reads
 * the record again; the composed surface reducer routes it to all three. */
export type ManagedTermsProposalAction =
  | { type: "terms-proposal-started" }
  | { type: "terms-proposal-failed"; failure: string }
  | { type: "terms-proposal-settled" };

/** The surface's state: the record load, the attended run, the failure recovery,
 * the store reads beside the record, the exports and hand-offs, and the answer to
 * a terms proposal. */
export interface ManagedRunSurfaceState {
  load: ManagedLoadState;
  run: ManagedRunState;
  recovery: ManagedRecoveryState;
  reads: ManagedStoreReads;
  handoff: ManagedHandoffState;
  termsProposal: ManagedTermsProposalRequest;
}

/** Every read under way, and nothing else under way this visit. */
export const MANAGED_RUN_SURFACE_INITIAL: ManagedRunSurfaceState = {
  load: MANAGED_LOAD_INITIAL,
  run: MANAGED_RUN_INITIAL,
  recovery: MANAGED_RECOVERY_INITIAL,
  reads: MANAGED_STORE_READS_INITIAL,
  handoff: MANAGED_HANDOFF_INITIAL,
  termsProposal: { kind: "idle" },
};

/** A recovery write that returns the record it wrote, adopted with its outcome. */
export type ManagedRecordWriteAction =
  | { type: "standing-cleared"; record: RunnableManagedExchangeRecord }
  | {
      type: "reinvite-composed";
      reinvite: ManagedReinvite;
      record: RunnableManagedExchangeRecord;
    };

/** An export that marked the record backed up, the marker landing on the loaded
 * record with the export's outcome. */
export type ManagedBackupExportAction =
  | { type: "backup-exported"; marker: ManagedBackupMarker }
  | {
      type: "migration-dispatched";
      dispatch: ManagedMigrationDispatch;
      marker: ManagedBackupMarker;
    };

/** Every event the surface reports. */
export type ManagedRunSurfaceAction =
  | ManagedRunAction
  | Exclude<ManagedRecoveryAction, { type: ManagedRecordWriteAction["type"] }>
  | ManagedRecordWriteAction
  | ManagedLoadAction
  | ManagedStoreReadAction
  | Exclude<ManagedHandoffAction, { type: ManagedBackupExportAction["type"] }>
  | ManagedBackupExportAction
  | ManagedTermsProposalAction;

function withRun(
  state: ManagedRunSurfaceState,
  run: ManagedRunState,
): ManagedRunSurfaceState {
  return run === state.run ? state : { ...state, run };
}

function withLoad(
  state: ManagedRunSurfaceState,
  load: ManagedLoadState,
): ManagedRunSurfaceState {
  return load === state.load ? state : { ...state, load };
}

function withHandoff(
  state: ManagedRunSurfaceState,
  handoff: ManagedHandoffState,
): ManagedRunSurfaceState {
  return handoff === state.handoff ? state : { ...state, handoff };
}

function withReads(
  state: ManagedRunSurfaceState,
  reads: ManagedStoreReads,
): ManagedRunSurfaceState {
  return reads === state.reads ? state : { ...state, reads };
}

function adopted(
  load: ManagedLoadState,
  record: RunnableManagedExchangeRecord,
): ManagedLoadState {
  return managedLoadReducer(load, { type: "record-adopted", record });
}

/** The surface's reducer. A run start moves both the run and the recovery; a
 * composed re-invite adopts the rotated record and replaces the failure it
 * recovers from; a standing clear adopts the record it wrote; a run the hand-off
 * refused settles with the copy spent; an export that marked the record backed up
 * lands the marker with its outcome; a settled terms proposal clears the failure
 * and reads the record again. */
export function managedRunSurfaceReducer(
  state: ManagedRunSurfaceState,
  action: ManagedRunSurfaceAction,
): ManagedRunSurfaceState {
  switch (action.type) {
    case "run-started":
      return {
        ...state,
        run: managedRunReducer(state.run, action),
        recovery: managedRecoveryReducer(state.recovery, action),
      };
    case "reinvite-composed":
      return {
        ...state,
        load: adopted(state.load, action.record),
        run: managedRunReducer(state.run, { type: "failure-cleared" }),
        recovery: managedRecoveryReducer(state.recovery, action),
      };
    case "standing-cleared":
      return {
        ...state,
        load: adopted(state.load, action.record),
        recovery: managedRecoveryReducer(state.recovery, action),
      };
    case "run-handed-off":
      return {
        ...state,
        load: managedLoadReducer(state.load, action),
        run: managedRunReducer(state.run, { type: "run-settled" }),
      };
    case "warning-raised":
    case "matching-resolved":
    case "terms-change-asked":
    case "terms-change-answered":
    case "run-completed":
    case "folder-write-started":
    case "folder-write-finished":
    case "folder-write-skipped":
    case "run-failed":
    case "run-settled":
    case "failure-cleared":
      return withRun(state, managedRunReducer(state.run, action));
    case "backup-exported":
    case "migration-dispatched":
      return {
        ...state,
        load: managedLoadReducer(state.load, {
          type: "backup-marked",
          marker: action.marker,
        }),
        handoff: managedHandoffReducer(state.handoff, action),
      };
    case "terms-proposal-settled":
      return {
        ...state,
        load: managedLoadReducer(state.load, {
          type: "record-read-requested",
        }),
        run: managedRunReducer(state.run, { type: "failure-cleared" }),
        termsProposal: { kind: "idle" },
      };
    case "terms-proposal-started":
      return { ...state, termsProposal: { kind: "busy" } };
    case "terms-proposal-failed":
      return {
        ...state,
        termsProposal: { kind: "failed", failure: action.failure },
      };
    case "export-started":
    case "export-finished":
    case "export-failed":
    case "migration-confirm-started":
    case "migration-confirmed":
    case "migration-refused":
    case "migration-kept":
    case "command-line-handed-off":
      return withHandoff(state, managedHandoffReducer(state.handoff, action));
    case "accounting-read":
    case "unfiled-disclosures-read":
    case "parked-results-read":
    case "unrecorded-run-flagged":
    case "accounting-read-requested":
    case "parked-results-read-requested":
      return withReads(state, managedStoreReadsReducer(state.reads, action));
    case "record-read":
    case "record-read-failed":
    case "record-read-requested":
    case "record-retaken":
    case "record-adopted":
    case "configuration-edited":
    case "local-state-reloaded":
    case "backup-marked":
      return withLoad(state, managedLoadReducer(state.load, action));
    default:
      return {
        ...state,
        recovery: managedRecoveryReducer(state.recovery, action),
      };
  }
}

/** Whether a run is in progress: connecting, exchanging, or writing its results
 * into the working folder. */
export function managedRunInProgress(state: ManagedRunState): boolean {
  return state.phase.kind === "running" || state.phase.kind === "finishing";
}

/** The finished run's completion, from the moment its outputs arrive. */
export function managedRunCompletion(
  state: ManagedRunState,
): ManagedRunCompletion | undefined {
  return state.phase.kind === "finishing" || state.phase.kind === "complete"
    ? state.phase.completion
    : undefined;
}

/** The failure the last run left on screen, until a run starts or a recovery
 * clears it. */
export function managedRunLiveFailure(
  state: ManagedRunState,
): LiveManagedRunFailure | undefined {
  return state.phase.kind === "failed" ? state.phase.failure : undefined;
}

/** What {@link managedRunInputSource} chooses from. */
export interface ManagedRunInputChoices {
  recordLoaded: boolean;
  /** The record's working folder where this browser can use it, else undefined. */
  usableFolder: FileSystemDirectoryHandle | undefined;
  folderGrantable: boolean;
  chosenFile: File | undefined;
}

/**
 * Where the next run reads its input: the record's usable working folder, or the
 * operator's chosen file on a browser that cannot grant a folder. `undefined` --
 * and the Run control disabled -- while neither is available.
 */
export function managedRunInputSource(
  choices: ManagedRunInputChoices,
): ManagedInputSource | undefined {
  if (!choices.recordLoaded) return undefined;
  if (choices.usableFolder !== undefined)
    return {
      kind: "folder",
      directory: choices.usableFolder,
      attendance: "attended",
    };
  if (!choices.folderGrantable && choices.chosenFile !== undefined)
    return { kind: "file", file: choices.chosenFile };
  return undefined;
}

/** Which of the surface's views the main column shows: the load's own page short
 * of a runnable record, else one of the runnable record's views. */
export type ManagedSurfaceView =
  | Exclude<ManagedLoadState["kind"], "runnable">
  | "complete"
  | "command-line"
  | "migrated"
  | "confirm-move"
  | "run";

/** What {@link managedSurfaceView} chooses from. */
export type ManagedSurfaceViewInputs = Pick<
  ManagedRunSurfaceState,
  "load" | "run" | "handoff"
>;

/** The view the main column shows, the first that applies in this order: the
 * load's own page short of a runnable record, a finished run, a hand-off, then
 * the run controls. */
export function managedSurfaceView(
  inputs: ManagedSurfaceViewInputs,
): ManagedSurfaceView {
  if (inputs.load.kind !== "runnable") return inputs.load.kind;
  if (managedRunCompletion(inputs.run) !== undefined) return "complete";
  if (inputs.handoff.commandLine !== undefined) return "command-line";
  if (inputs.handoff.migration.kind === "migrated") return "migrated";
  if (inputs.handoff.migration.kind === "awaiting-confirm")
    return "confirm-move";
  return "run";
}
