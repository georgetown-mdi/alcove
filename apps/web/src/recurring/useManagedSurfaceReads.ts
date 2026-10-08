import { useCallback, useEffect } from "react";

import {
  clearUnfiledExchangeFlag,
  unfiledExchangeFlagged,
} from "@psi/unfiledDisclosureFlag";
import { readDisclosureAccounting } from "@psi/disclosureAccountingStore";
import { readParkedResults } from "@psi/parkedResultsStore";
import { readUnfiledDisclosures } from "@psi/unfiledDisclosureStore";

import type {
  ManagedStoreReadAction,
  ManagedStoreReads,
} from "./managedSurfaceReadsModel";

/**
 * Read the stores beside the managed record for exchange `id` and report each
 * read through `dispatch`: again each time a read count in `reads` moves, and the
 * accounting and its shortfall again when a run finishes (`finishedAt`), so the
 * entry that run filed, or failed to file, shows without a reload. Each read
 * classifies its own failures, so what lands is a state to render rather than an
 * error to interpret; a read that rejects anyway lands as unavailable, which
 * claims nothing about what is stored, where a rejection would leave its section
 * on a spinner.
 *
 * Returns the call that drops the store's unrecorded-run flag, made by the alert
 * that shows it once it has rendered: the surface shows nothing for a missing,
 * unloadable or spent exchange, and dropping the flag on the visit instead would
 * destroy the only trace of that run unseen.
 */
export function useManagedSurfaceReads(
  id: string,
  reads: ManagedStoreReads,
  finishedAt: Date | undefined,
  dispatch: (action: ManagedStoreReadAction) => void,
): { dropUnrecordedRunFlag: () => void } {
  const accountingReads = reads.accounting.reads;
  const parkedResultsReads = reads.parkedResults.reads;

  useEffect(() => {
    let live = true;
    void readDisclosureAccounting(id)
      .then((read) => {
        if (live) dispatch({ type: "accounting-read", read });
      })
      .catch(() => {
        if (live)
          dispatch({ type: "accounting-read", read: { kind: "unavailable" } });
      });
    return () => {
      live = false;
    };
  }, [id, finishedAt, accountingReads, dispatch]);

  useEffect(() => {
    let live = true;
    if (unfiledExchangeFlagged(id))
      dispatch({ type: "unrecorded-run-flagged", id });
    void readUnfiledDisclosures(id)
      .then((read) => {
        if (live) dispatch({ type: "unfiled-disclosures-read", read });
      })
      .catch(() => {
        if (live)
          dispatch({
            type: "unfiled-disclosures-read",
            read: { kind: "unavailable" },
          });
      });
    return () => {
      live = false;
    };
  }, [id, finishedAt, accountingReads, dispatch]);

  // The read applies the retention as it goes, so what lands is what is still
  // offered, never an entry the stated retention has released.
  useEffect(() => {
    let live = true;
    void readParkedResults(id)
      .then((read) => {
        if (live) dispatch({ type: "parked-results-read", read });
      })
      .catch(() => {
        if (live)
          dispatch({
            type: "parked-results-read",
            read: { kind: "unavailable" },
          });
      });
    return () => {
      live = false;
    };
  }, [id, parkedResultsReads, dispatch]);

  // Stable across renders, so the alert's mount effect runs once.
  const dropUnrecordedRunFlag = useCallback(() => {
    void clearUnfiledExchangeFlag(id);
  }, [id]);

  return { dropUnrecordedRunFlag };
}
