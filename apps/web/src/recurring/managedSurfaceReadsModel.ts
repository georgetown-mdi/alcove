import type { DisclosureAccountingRead } from "@psi/disclosureAccountingStore";
import type { ParkedResultsRead } from "@psi/parkedResultsStore";
import type { UnfiledDisclosureRead } from "@psi/unfiledDisclosureStore";

/**
 * The managed run surface's reads of the stores beside the record: the accounting
 * of disclosures, the runs it is short, and the results a scheduled run left. Each
 * read is read on its own, never folded into the record load: an unreadable
 * accounting must not present the exchange as unloadable, and an unloadable record
 * must not hide a readable accounting. Each lands as the store's own classified
 * read, `undefined` while it is in flight, so a store that did not answer is never
 * shown as an empty one.
 */

/** One store read and the number of reads asked for; the surface reads the store
 * again each time the number moves. */
export interface ManagedStoreRead<T> {
  reads: number;
  read: T | undefined;
}

/** The store reads' whole state. */
export interface ManagedStoreReads {
  accounting: ManagedStoreRead<DisclosureAccountingRead>;
  /** The runs the accounting is short, read again with it, so one retry answers
   * for the whole section. */
  unfiled: UnfiledDisclosureRead | undefined;
  parkedResults: ManagedStoreRead<ParkedResultsRead>;
  /** The exchange this visit found flagged as holding a run this browser could
   * record nowhere. The id rather than a flag, so it does not follow a switch to
   * another exchange, and a later read that finds the flag already cleared cannot retract what
   * this visit has shown. */
  flaggedUnrecordedId: string | undefined;
}

/** Every read under way. */
export const MANAGED_STORE_READS_INITIAL: ManagedStoreReads = {
  accounting: { reads: 0, read: undefined },
  unfiled: undefined,
  parkedResults: { reads: 0, read: undefined },
  flaggedUnrecordedId: undefined,
};

/** The store reads' events. */
export type ManagedStoreReadAction =
  | { type: "accounting-read"; read: DisclosureAccountingRead }
  | { type: "unfiled-disclosures-read"; read: UnfiledDisclosureRead }
  | { type: "parked-results-read"; read: ParkedResultsRead }
  | { type: "unrecorded-run-flagged"; id: string }
  /** Read the accounting and its shortfall again, dropping the verdicts on screen
   * so no control stays live under a click already taken. */
  | { type: "accounting-read-requested" }
  /** Read the parked results again, dropping the verdict on screen. */
  | { type: "parked-results-read-requested" };

/** The store reads' reducer. */
export function managedStoreReadsReducer(
  state: ManagedStoreReads,
  action: ManagedStoreReadAction,
): ManagedStoreReads {
  switch (action.type) {
    case "accounting-read":
      return {
        ...state,
        accounting: { ...state.accounting, read: action.read },
      };
    case "unfiled-disclosures-read":
      return { ...state, unfiled: action.read };
    case "parked-results-read":
      return {
        ...state,
        parkedResults: { ...state.parkedResults, read: action.read },
      };
    case "unrecorded-run-flagged":
      return state.flaggedUnrecordedId === action.id
        ? state
        : { ...state, flaggedUnrecordedId: action.id };
    case "accounting-read-requested":
      return {
        ...state,
        accounting: { reads: state.accounting.reads + 1, read: undefined },
        unfiled: undefined,
      };
    case "parked-results-read-requested":
      return {
        ...state,
        parkedResults: {
          reads: state.parkedResults.reads + 1,
          read: undefined,
        },
      };
  }
}

/** Whether this visit found `id` flagged as holding a run it could record
 * nowhere. */
export function managedUnrecordedRunFlagged(
  state: ManagedStoreReads,
  id: string,
): boolean {
  return state.flaggedUnrecordedId === id;
}
