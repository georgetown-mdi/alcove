import { useCallback, useEffect, useReducer, useRef } from "react";

import { managedExchangeRunLockHeld } from "@psi/managed/managedExchangeLock";

import {
  MANAGED_RUN_LOCK_READING_INITIAL,
  managedRunLockReadingReducer,
  managedRunLockReadsHeld,
} from "./managedRunLockReading";

/** How often the mounted surface re-reads the record's run lock. Web Locks raises no
 * change event, so the only reading available is a poll; this is short enough that a
 * control the operator is looking at goes gray, and comes back, within a beat of the
 * run starting or ending. */
const RUN_LOCK_POLL_MS = 400;

/** What a surface gating on a run in flight gets: the current reading, the
 * immediate re-read a click takes before acting on it, and the report of an
 * export the lock refused. */
interface ManagedRunInFlight {
  /** Whether a run of this record is in flight anywhere this browser profile can
   * see. */
  inFlight: boolean;
  /** Whether the record's run lock reads as held, whatever this surface's own run
   * state: false once a finished run here has released it. */
  lockHeld: boolean;
  /** Re-read the record's run lock right now, updating {@link inFlight} and resolving
   * what it read. A click handler takes this rather than trusting the poll, whose
   * last reading can be a beat old. */
  recheckLock: () => Promise<boolean>;
  /** Report that an export taking the lock found it held. {@link inFlight} reads
   * true until the next poll reading begun after it. */
  lockRefused: () => void;
}

/**
 * Whether a run of managed exchange `id` is in flight, in ANY context this browser
 * profile can see: this surface's own run, a second tab's, or the scheduled runtime's.
 *
 * Two signals, because neither covers the other. The record's run+rotate lock
 * ({@link managedExchangeRunLockHeld}) is origin-wide, so it is what sees a run this
 * surface did not start -- but it is a poll rather than an event, and it is released
 * the moment that run ends. `runningHere` is this surface's own run state: instant,
 * and standing for the run's whole life including the tail past the lock's release.
 *
 * What this gates is presentation. The lock can be taken or released between the poll
 * and the click that follows it, so an export decides its own precondition: it takes
 * this same lock (`ifAvailable`), so a click that slips past this reading is refused
 * there rather than accepted, and reports the refusal through
 * {@link ManagedRunInFlight.lockRefused} so the reason shows in the same words.
 */
export function useManagedRunInFlight(
  id: string,
  runningHere: boolean,
): ManagedRunInFlight {
  const [reading, dispatchReading] = useReducer(
    managedRunLockReadingReducer,
    MANAGED_RUN_LOCK_READING_INITIAL,
  );
  const refusals = useRef(0);

  const recheckLock = useCallback(async (): Promise<boolean> => {
    const refusalsBefore = refusals.current;
    // A query this browser will not answer leaves the gate open rather than shut:
    // the reading is advisory either way, since the export behind the gate takes
    // the lock itself and refuses what this could not see.
    const held = await managedExchangeRunLockHeld(id).catch(() => false);
    dispatchReading({ type: "read", held, refusalsBefore });
    return held;
  }, [id]);

  const lockRefused = useCallback(() => {
    refusals.current += 1;
    dispatchReading({ type: "refused", refusal: refusals.current });
  }, []);

  useEffect(() => {
    let live = true;
    const read = () => {
      const refusalsBefore = refusals.current;
      void managedExchangeRunLockHeld(id)
        .catch(() => false)
        .then((held) => {
          if (live) dispatchReading({ type: "read", held, refusalsBefore });
        });
    };
    read();
    const poll = window.setInterval(read, RUN_LOCK_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(poll);
    };
  }, [id]);

  const lockHeld = managedRunLockReadsHeld(reading);
  return {
    inFlight: runningHere || lockHeld,
    lockHeld,
    recheckLock,
    lockRefused,
  };
}
