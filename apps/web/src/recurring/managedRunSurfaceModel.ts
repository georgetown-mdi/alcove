import {
  MANAGED_RECOVERY_INITIAL,
  managedRecoveryReducer,
} from "./managedRunRecoveryModel";

import type { Displayable, ResolvedMatching, TermsChange } from "@alcove/core";

import type { ManagedInputSource } from "@psi/managed/managedInputHandle";
import type { RunOutputs } from "@psi/runOutputs";

import type {
  ManagedRecoveryAction,
  ManagedRecoveryState,
} from "./managedRunRecoveryModel";
import type { AttendedFolderWrite } from "./attendedFolderWriteModel";
import type { ManagedRunFailureAlert } from "./managedRunLaunchModel";

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

/** The surface's state: the attended run and the failure recovery. */
export interface ManagedRunSurfaceState {
  run: ManagedRunState;
  recovery: ManagedRecoveryState;
}

/** No run and no recovery this visit. */
export const MANAGED_RUN_SURFACE_INITIAL: ManagedRunSurfaceState = {
  run: MANAGED_RUN_INITIAL,
  recovery: MANAGED_RECOVERY_INITIAL,
};

/** Every event the surface reports. */
export type ManagedRunSurfaceAction = ManagedRunAction | ManagedRecoveryAction;

function withRun(
  state: ManagedRunSurfaceState,
  run: ManagedRunState,
): ManagedRunSurfaceState {
  return run === state.run ? state : { ...state, run };
}

/** The surface's reducer. A run start moves both the run and the recovery; a
 * composed re-invite replaces the failure it recovers from. */
export function managedRunSurfaceReducer(
  state: ManagedRunSurfaceState,
  action: ManagedRunSurfaceAction,
): ManagedRunSurfaceState {
  switch (action.type) {
    case "run-started":
      return {
        run: managedRunReducer(state.run, action),
        recovery: managedRecoveryReducer(state.recovery, action),
      };
    case "reinvite-composed":
      return {
        run: managedRunReducer(state.run, { type: "failure-cleared" }),
        recovery: managedRecoveryReducer(state.recovery, action),
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

/** Which of the surface's views the main column shows. */
export type ManagedSurfaceView =
  | "missing"
  | "unloadable"
  | "spent"
  | "configuration"
  | "loading"
  | "complete"
  | "command-line"
  | "migrated"
  | "confirm-move"
  | "run";

/** What {@link managedSurfaceView} chooses from. */
export interface ManagedSurfaceViewInputs {
  loadFailure: "missing" | "unloadable" | "spent" | undefined;
  configurationLoaded: boolean;
  recordLoaded: boolean;
  run: ManagedRunState;
  commandLineHandedOff: boolean;
  migrated: boolean;
  migrationAwaitingConfirm: boolean;
}

/** The view the main column shows, the first that applies in this order: a load
 * failure, an imported configuration, loading, a finished run, a hand-off, then
 * the run controls. */
export function managedSurfaceView(
  inputs: ManagedSurfaceViewInputs,
): ManagedSurfaceView {
  if (inputs.loadFailure !== undefined) return inputs.loadFailure;
  if (inputs.configurationLoaded) return "configuration";
  if (!inputs.recordLoaded) return "loading";
  if (managedRunCompletion(inputs.run) !== undefined) return "complete";
  if (inputs.commandLineHandedOff) return "command-line";
  if (inputs.migrated) return "migrated";
  if (inputs.migrationAwaitingConfirm) return "confirm-move";
  return "run";
}
