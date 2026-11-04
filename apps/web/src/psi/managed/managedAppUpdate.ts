/**
 * Applying a waiting app update between scheduled runs. An installed app left
 * open to run its schedule may see no navigation for weeks, and a new
 * deployment's worker waits behind the running page until something applies it
 * (`apps/web/src/utils/appShellUpdate.ts`). So the runner applies it itself,
 * before a window's first attempt, through the banner's own reload-led path,
 * and only when nothing would be lost by the reload here or by the takeover
 * elsewhere:
 *
 * - no same-origin window holds, or has queued for, a managed record's
 *   run+rotate lock (a run, a re-invite, relay enrollment, an import replace);
 * - no window has its leave-page prompt armed, and no view in this window
 *   shows what the page holds only in memory
 *   (`apps/web/src/utils/appShellUpdateHold.ts`).
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
} from "@utils/appShellUpdate";

import { isManagedExchangeLockName } from "./managedExchangeLock";

/** The boundaries the apply reads through, injectable so each case is drivable
 * without a service worker. */
export interface WaitingAppUpdateSeams {
  /** Whether a newer app version is installed and waiting. */
  updateReady: () => boolean;
  /** Whether a view in this window holds the update back. */
  heldHere: () => boolean;
  /** The names of every Web Lock held or queued for across the origin. */
  lockNames: () => Promise<Array<string>>;
  /** Start the reload that applies the update. */
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
  apply: applyAppShellUpdate,
};

/** Whether a lock of this name means a reload or a takeover would cost
 * someone something. */
function holdsAppUpdate(name: string): boolean {
  return (
    isManagedExchangeLockName(name) || name === APP_SHELL_UPDATE_HOLD_LOCK_NAME
  );
}

/**
 * Apply a waiting app update when nothing would be lost, resolving `true` when
 * the page is reloading onto it, so the caller starts nothing more. Resolves
 * `false`, applying nothing, when no update is waiting, when anything holds it
 * back, and when the lock state cannot be read.
 */
export async function applyWaitingAppUpdateBetweenRuns(
  seams: WaitingAppUpdateSeams = browserWaitingAppUpdateSeams,
): Promise<boolean> {
  if (!seams.updateReady() || seams.heldHere()) return false;
  let names: Array<string>;
  try {
    names = await seams.lockNames();
  } catch {
    return false;
  }
  if (names.some(holdsAppUpdate) || seams.heldHere()) return false;
  seams.apply();
  return true;
}
