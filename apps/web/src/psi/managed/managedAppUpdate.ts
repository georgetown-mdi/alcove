/**
 * Applying a waiting app update between scheduled runs. An installed app left
 * open to run its schedule may see no navigation for weeks, and a new
 * deployment's worker waits behind the running page until something applies it
 * (`apps/web/src/utils/appShellUpdate.ts`). So the runner applies it itself,
 * before a window's first attempt, and only when nothing would be lost by the
 * reload here or by the takeover elsewhere:
 *
 * - no same-origin window holds, or has queued for, a managed record's
 *   run+rotate lock (a run, a re-invite, relay enrollment, an import replace);
 * - no window has its leave-page prompt armed, and no view in this window
 *   shows what the page holds only in memory
 *   (`apps/web/src/utils/appShellUpdateHold.ts`).
 *
 * The worker takes over first and the page reloads only once it has, so the
 * reloaded page loads under the new worker and has nothing left to apply. A
 * takeover that has not landed within {@link APP_UPDATE_TAKEOVER_WAIT_MS}
 * leaves the window to make its attempt on the current version.
 *
 * Normative rule: docs/spec/MANAGED_EXCHANGE_RECORD.md, "Applying a waiting app
 * version between windows".
 */

import {
  APP_SHELL_UPDATE_HOLD_LOCK_NAME,
  appShellUpdateHeldHere,
} from "@utils/appShellUpdateHold";
import {
  appShellUpdateReady,
  applyAppShellUpdate,
  takeOverWaitingAppShell,
} from "@utils/appShellUpdate";

import { isManagedExchangeLockName } from "./managedExchangeLock";

/**
 * How long the runner waits for a waiting worker's takeover to land before it
 * makes the window's attempt on the current version instead. The basis, a
 * measured takeover time, is in docs/spec/MANAGED_EXCHANGE_RECORD.md,
 * "Applying a waiting app version between windows".
 */
export const APP_UPDATE_TAKEOVER_WAIT_MS = 10_000;

/** The boundaries the apply reads through, injectable so each case is drivable
 * without a service worker. */
export interface WaitingAppUpdateSeams {
  /** Whether a newer app version is ready for this page. */
  updateReady: () => boolean;
  /** Whether a view in this window holds the update back. */
  heldHere: () => boolean;
  /** The names of every Web Lock held or queued for across the origin. */
  lockNames: () => Promise<Array<string>>;
  /** Have the waiting worker take over, resolving whether it has within the
   * wait ({@link takeOverWaitingAppShell}). */
  takeOver: () => Promise<boolean>;
  /** Start the reload onto the version that has taken over. */
  apply: () => void;
}

/** Every held and queued Web Lock name the origin reports. */
async function originLockNames(): Promise<Array<string>> {
  const snapshot = await globalThis.navigator.locks.query();
  return [...(snapshot.held ?? []), ...(snapshot.pending ?? [])].flatMap(
    (lock) => (lock.name === undefined ? [] : [lock.name]),
  );
}

const browserWaitingAppUpdateSeams: WaitingAppUpdateSeams = {
  updateReady: appShellUpdateReady,
  heldHere: appShellUpdateHeldHere,
  lockNames: originLockNames,
  takeOver: () => takeOverWaitingAppShell(APP_UPDATE_TAKEOVER_WAIT_MS),
  apply: applyAppShellUpdate,
};

/** Whether a lock of this name means a reload or a takeover would cost
 * someone something. */
function holdsAppUpdate(name: string): boolean {
  return (
    isManagedExchangeLockName(name) || name === APP_SHELL_UPDATE_HOLD_LOCK_NAME
  );
}

/** Whether nothing holds the update back now; a lock state that cannot be
 * read holds it back. */
async function nothingHoldsAppUpdate(
  seams: WaitingAppUpdateSeams,
): Promise<boolean> {
  if (seams.heldHere()) return false;
  let names: Array<string>;
  try {
    names = await seams.lockNames();
  } catch {
    return false;
  }
  return !names.some(holdsAppUpdate) && !seams.heldHere();
}

/**
 * Apply a waiting app update when nothing would be lost, resolving `true` when
 * the page is reloading onto it, so the caller starts nothing more. Resolves
 * `false`, applying nothing here, when no update is ready, when anything holds
 * it back, when the lock state cannot be read, and when the takeover has not
 * landed within {@link APP_UPDATE_TAKEOVER_WAIT_MS}. The holds are read again
 * once it has, since a run or a view may have started during the wait.
 */
export async function applyWaitingAppUpdateBetweenRuns(
  seams: WaitingAppUpdateSeams = browserWaitingAppUpdateSeams,
): Promise<boolean> {
  if (!seams.updateReady() || !(await nothingHoldsAppUpdate(seams)))
    return false;
  if (!(await seams.takeOver())) return false;
  if (!(await nothingHoldsAppUpdate(seams))) return false;
  seams.apply();
  return true;
}
