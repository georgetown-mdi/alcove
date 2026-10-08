import type {
  ManagedHandoffRefusal,
  ManagedMigrationDispatch,
} from "@psi/managed/managedExchangeExport";
import type { RunLines } from "./scheduledRunCommand";

/**
 * The managed run surface's exports and hand-offs: a backup download, a migration
 * to another device, and an export to the command line. No rendering and no I/O
 * -- the surface makes each export and reports its outcome here as an action.
 *
 * A migration downloads its file first and spends this device's copy only once
 * the operator attests the file is saved, so a dismissed save leaves the copy
 * live here.
 */

/** The last export's request. Every export on the page shares it: one runs at a
 * time, and a failed one shows its alert until the next starts. */
export type ManagedExportRequest =
  { kind: "idle" } | { kind: "busy" } | { kind: "failed" };

/** The state of a migration to another device. `refusal` is the store refusing
 * the spend: a run held the run lock at the click, a run rotated past the file
 * this screen downloaded, or the record is gone from this browser. It is not an
 * export failure: none of the three is an error. */
export type ManagedMigration =
  | { kind: "none" }
  | {
      kind: "awaiting-confirm";
      dispatch: ManagedMigrationDispatch;
      refusal: ManagedHandoffRefusal | undefined;
    }
  | { kind: "migrated" };

/** The exports' and hand-offs' whole state. */
export interface ManagedHandoffState {
  export: ManagedExportRequest;
  migration: ManagedMigration;
  /** The invocation a confirmed command-line export handed over: this browser's
   * copy is spent, and the surface names what runs in its place. */
  commandLine: RunLines | undefined;
}

/** No export and no hand-off this visit. */
export const MANAGED_HANDOFF_INITIAL: ManagedHandoffState = {
  export: { kind: "idle" },
  migration: { kind: "none" },
  commandLine: undefined,
};

/** The exports' and hand-offs' events. `backup-exported` and
 * `migration-dispatched` also mark the backup on the loaded record; the composed
 * surface reducer routes them to both. */
export type ManagedHandoffAction =
  | { type: "export-started" }
  | { type: "export-finished" }
  | { type: "export-failed" }
  | { type: "backup-exported" }
  /** The migration's file downloaded; the spend waits on the operator. */
  | { type: "migration-dispatched"; dispatch: ManagedMigrationDispatch }
  | { type: "migration-confirm-started" }
  | { type: "migration-confirmed" }
  | { type: "migration-refused"; refusal: ManagedHandoffRefusal }
  /** The operator kept the copy on this device instead of confirming. */
  | { type: "migration-kept" }
  | { type: "command-line-handed-off"; handoff: RunLines };

/** The exports' and hand-offs' reducer. A migration once confirmed stays
 * migrated; a refusal or a keep outside the confirmation changes nothing. */
export function managedHandoffReducer(
  state: ManagedHandoffState,
  action: ManagedHandoffAction,
): ManagedHandoffState {
  switch (action.type) {
    case "export-started":
      return { ...state, export: { kind: "busy" } };
    case "export-finished":
    case "backup-exported":
      return { ...state, export: { kind: "idle" } };
    case "export-failed":
      return { ...state, export: { kind: "failed" } };
    case "migration-dispatched":
      return {
        ...state,
        export: { kind: "idle" },
        migration:
          state.migration.kind === "migrated"
            ? state.migration
            : {
                kind: "awaiting-confirm",
                dispatch: action.dispatch,
                refusal: undefined,
              },
      };
    case "migration-confirm-started":
      return {
        ...state,
        export: { kind: "busy" },
        migration:
          state.migration.kind === "awaiting-confirm"
            ? { ...state.migration, refusal: undefined }
            : state.migration,
      };
    case "migration-confirmed":
      return {
        ...state,
        export: { kind: "idle" },
        migration: { kind: "migrated" },
      };
    case "migration-refused":
      return {
        ...state,
        export: { kind: "idle" },
        migration:
          state.migration.kind === "awaiting-confirm"
            ? { ...state.migration, refusal: action.refusal }
            : state.migration,
      };
    case "migration-kept":
      return state.migration.kind === "awaiting-confirm"
        ? { ...state, migration: { kind: "none" } }
        : state;
    case "command-line-handed-off":
      return { ...state, commandLine: action.handoff };
  }
}

/** The migration awaiting the operator's attestation that its file is saved. */
export function managedMigrationAwaitingConfirm(
  state: ManagedHandoffState,
): ManagedMigrationDispatch | undefined {
  return state.migration.kind === "awaiting-confirm"
    ? state.migration.dispatch
    : undefined;
}

/** The store's refusal of the migration's spend, while the confirmation shows. */
export function managedMigrationRefusal(
  state: ManagedHandoffState,
): ManagedHandoffRefusal | undefined {
  return state.migration.kind === "awaiting-confirm"
    ? state.migration.refusal
    : undefined;
}

/** Whether a run holds the migration back: the polled reading, or the spend's own
 * refusal at a click the poll's last reading was too old to hold back. */
export function managedRunHoldsMigration(
  state: ManagedHandoffState,
  runInFlight: boolean,
): boolean {
  return runInFlight || managedMigrationRefusal(state) === "run-in-flight";
}

/** Whether the spend was refused for a reason no retry clears -- the downloaded
 * file is out of date, or the record it came from is gone -- as against a run,
 * which ends. */
export function managedMigrationStale(state: ManagedHandoffState): boolean {
  const refusal = managedMigrationRefusal(state);
  return refusal !== undefined && refusal !== "run-in-flight";
}
