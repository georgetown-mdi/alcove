/**
 * The run+rotate lock as a surface last read it: the poll's reading, and an
 * export's refusal on the lock since then. No React and no I/O -- the hook
 * ({@link ./useManagedRunInFlight.ts}) polls the lock and reports each reading
 * and refusal here.
 *
 * An export that takes the lock itself can find it held between two poll
 * readings. That refusal counts as a held reading until the first poll reading
 * begun after it, so the run-in-progress reason it shows clears on the next
 * poll tick however short the hold was. A reading begun before the refusal
 * cannot clear it: it may predate the hold the refusal met.
 */

/** The lock's last reading. `refusal` is the number of the latest refusal no
 * reading begun after it has answered. */
export interface ManagedRunLockReading {
  held: boolean;
  refusal: number | undefined;
}

/** Nothing read and nothing refused yet. */
export const MANAGED_RUN_LOCK_READING_INITIAL: ManagedRunLockReading = {
  held: false,
  refusal: undefined,
};

/** A poll or click-time reading of the lock, begun once `refusalsBefore`
 * refusals had been counted; or an export's refusal, numbered from 1. */
export type ManagedRunLockReadingEvent =
  | { type: "read"; held: boolean; refusalsBefore: number }
  | { type: "refused"; refusal: number };

/** Fold a reading or a refusal into the lock's last reading. */
export function managedRunLockReadingReducer(
  state: ManagedRunLockReading,
  event: ManagedRunLockReadingEvent,
): ManagedRunLockReading {
  switch (event.type) {
    case "read":
      return {
        held: event.held,
        refusal:
          state.refusal !== undefined && state.refusal > event.refusalsBefore
            ? state.refusal
            : undefined,
      };
    case "refused":
      return { ...state, refusal: event.refusal };
  }
}

/** Whether the lock reads as held: by the last reading, or by a refusal no
 * later reading has answered. */
export function managedRunLockReadsHeld(state: ManagedRunLockReading): boolean {
  return state.held || state.refusal !== undefined;
}
