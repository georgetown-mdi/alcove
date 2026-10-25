import { useEffect, useState } from "react";

import { managedExchangeRunLockHeld } from "@psi/managed/managedExchangeLock";

/** How often the mounted surface re-reads the record's run lock. Web Locks raises no
 * change event, so the only reading available is a poll; this is short enough that a
 * note the operator is looking at shows, and clears, within a beat of the run
 * starting or ending. */
const RUN_LOCK_POLL_MS = 400;

/** What a surface noting a run in flight gets. */
interface ManagedRunInFlight {
  /** Whether a run of this record is in flight anywhere this browser profile can
   * see. */
  inFlight: boolean;
  /** Whether the record's run lock reads as held, whatever this surface's own run
   * state: false once a finished run here has released it. */
  lockHeld: boolean;
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
 * What this gates is presentation only, a note beside each download: no control
 * waits on a run, and no write decides on this reading.
 */
export function useManagedRunInFlight(
  id: string,
  runningHere: boolean,
): ManagedRunInFlight {
  const [lockHeld, setLockHeld] = useState(false);

  useEffect(() => {
    let live = true;
    const read = () => {
      // A query this browser will not answer reads as no run: the reading only
      // places a note.
      void managedExchangeRunLockHeld(id)
        .catch(() => false)
        .then((held) => {
          if (live) setLockHeld(held);
        });
    };
    read();
    const poll = window.setInterval(read, RUN_LOCK_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(poll);
    };
  }, [id]);

  return { inFlight: runningHere || lockHeld, lockHeld };
}
