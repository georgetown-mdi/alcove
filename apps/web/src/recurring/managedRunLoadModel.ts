import { runnableManagedExchange } from "@psi/managed/managedExchangeRecord";

import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedBackupMarker } from "@psi/managed/managedBackupState";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";

/**
 * The managed run surface's record load. A load failure stays on screen; a read
 * landing under it replaces it only with another failure.
 */

/** A record this browser can run, with what the load read beside it. */
export interface ManagedRunnableLoad {
  kind: "runnable";
  record: RunnableManagedExchangeRecord;
  /** The local sibling state as the load read it: the import marker is what tells
   * a restored copy's stale secret from a handshake nothing on this device
   * explains. */
  localState: ManagedLocalState | undefined;
  backupMarker: ManagedBackupMarker | undefined;
}

/** A record holding no secret: a configuration imported from the command line,
 * which edits and exports here and runs there. It is not a runnable record, so no
 * run control can be reached with it. */
export interface ManagedConfigurationLoad {
  kind: "configuration";
  configuration: ManagedExchangeRecord;
}

/** A load the surface shows a record from. */
export type ManagedLoadedRecord =
  ManagedRunnableLoad | ManagedConfigurationLoad;

/**
 * A load the surface cannot run from, each with its own page: `missing` (the store
 * holds no record -- deleted or cleared) and `unloadable` (the read rejects: a stored
 * record this app version can no longer load, whose recovery is re-invite -- see
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "Versioning").
 */
export type ManagedLoadFailure = { kind: "missing" } | { kind: "unloadable" };

/** The record load's whole state. `reads` counts the reads asked for; the surface
 * reads the store again each time it moves. */
export type ManagedLoadState = { reads: number } & (
  { kind: "loading" } | ManagedLoadedRecord | ManagedLoadFailure
);

/** The first read under way. */
export const MANAGED_LOAD_INITIAL: ManagedLoadState = {
  kind: "loading",
  reads: 0,
};

/** The record load's events. */
export type ManagedLoadAction =
  | {
      type: "record-read";
      record: ManagedExchangeRecord | undefined;
      localState: ManagedLocalState | undefined;
    }
  | { type: "record-read-failed" }
  /** Read the store again, keeping what is on screen until the read answers. */
  | { type: "record-read-requested" }
  /** A store write returned the record it wrote, holding the secret it read. */
  | { type: "record-adopted"; record: RunnableManagedExchangeRecord }
  | { type: "configuration-edited"; configuration: ManagedExchangeRecord }
  /** A failed run's reload of the local sibling state. */
  | { type: "local-state-reloaded"; localState: ManagedLocalState | undefined }
  | { type: "backup-marked"; marker: ManagedBackupMarker };

/** What one read of the store found, before it lands on the state. */
export type ManagedRecordRead = ManagedLoadedRecord | { kind: "missing" };

/** Classify a read of the record and its local sibling state: the record's shape
 * decides between a runnable record and a configuration. */
export function classifyManagedRecordRead(
  record: ManagedExchangeRecord | undefined,
  localState: ManagedLocalState | undefined,
): ManagedRecordRead {
  if (record === undefined) return { kind: "missing" };
  if (!runnableManagedExchange(record))
    return { kind: "configuration", configuration: record };
  return {
    kind: "runnable",
    record,
    localState,
    backupMarker: localState?.backup,
  };
}

/** Whether the load ended on a page the surface cannot run from. */
export function managedLoadFailed(
  state: ManagedLoadState,
): state is ManagedLoadState & ManagedLoadFailure {
  return state.kind === "missing" || state.kind === "unloadable";
}

function readLanded(
  state: ManagedLoadState,
  read: ManagedRecordRead | { kind: "unloadable" },
): ManagedLoadState {
  const { reads } = state;
  if (read.kind === "runnable" || read.kind === "configuration") {
    // A configuration keeps its own surface over a later runnable read.
    if (
      managedLoadFailed(state) ||
      (state.kind === "configuration" && read.kind === "runnable")
    )
      return state;
    return { ...read, reads };
  }
  return { kind: read.kind, reads };
}

/** The record load's reducer. */
export function managedLoadReducer(
  state: ManagedLoadState,
  action: ManagedLoadAction,
): ManagedLoadState {
  switch (action.type) {
    case "record-read":
      return readLanded(
        state,
        classifyManagedRecordRead(action.record, action.localState),
      );
    case "record-read-failed":
      return readLanded(state, { kind: "unloadable" });
    case "record-read-requested":
      return { ...state, reads: state.reads + 1 };
    // A write that lands after the record left the runnable state has no record
    // on screen to update.
    case "record-adopted":
      return state.kind === "runnable"
        ? { ...state, record: action.record }
        : state;
    case "configuration-edited":
      return state.kind === "configuration"
        ? { ...state, configuration: action.configuration }
        : state;
    case "local-state-reloaded":
      return state.kind === "runnable"
        ? { ...state, localState: action.localState }
        : state;
    case "backup-marked":
      return state.kind === "runnable"
        ? { ...state, backupMarker: action.marker }
        : state;
  }
}
