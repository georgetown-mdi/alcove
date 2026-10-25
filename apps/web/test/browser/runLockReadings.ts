/**
 * Holding a saved exchange's run lock from outside the page, for the browser
 * suites that check what a surface offers and does while a run is in flight.
 */

import { managedExchangeLockName } from "@psi/managed/managedExchangeLock";

/** Hold this record's run+rotate lock the way a second tab's run or the scheduled
 * runtime does, until the returned release is called. */
export async function holdRunLockElsewhere(id: string): Promise<() => void> {
  let release: () => void = () => undefined;
  const untilReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((granted) => {
    void navigator.locks.request(managedExchangeLockName(id), () => {
      granted();
      return untilReleased;
    });
  });
  return release;
}
