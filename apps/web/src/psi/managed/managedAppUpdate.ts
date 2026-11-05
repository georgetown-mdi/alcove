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
  appShellUpdateHoldersHere,
  appUpdateHolderOfHoldLock,
} from "@utils/appShellUpdateHold";
import {
  appShellUpdateReady,
  applyAppShellUpdate,
  noteAutomaticAppShellUpdate,
  takeOverWaitingAppShell,
} from "@utils/appShellUpdate";
import { orderedAppUpdateHolders } from "@utils/appUpdateHolder";

import { isManagedExchangeLockName } from "./managedExchangeLock";

import type { AppUpdateHolder } from "@utils/appUpdateHolder";

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
  /** What the views in this window hold the update back for. */
  holdersHere: () => ReadonlyArray<AppUpdateHolder>;
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
  holdersHere: appShellUpdateHoldersHere,
  lockNames: originLockNames,
  takeOver: () => takeOverWaitingAppShell(APP_UPDATE_TAKEOVER_WAIT_MS),
  apply: () => {
    noteAutomaticAppShellUpdate();
    applyAppShellUpdate();
  },
};

/** What a lock of this name holds the update back for, or `undefined` where
 * it holds nothing back. */
function holderOfLock(name: string): AppUpdateHolder | undefined {
  return isManagedExchangeLockName(name)
    ? "run"
    : appUpdateHolderOfHoldLock(name);
}

/** What holds the update back now, read across windows and in this one. */
export interface AppUpdateHolders {
  /** Every holder found, in display order; empty where nothing is found. */
  holders: ReadonlyArray<AppUpdateHolder>;
  /** `false` where the origin's lock state could not be read, which holds the
   * update back without naming what does. */
  locksRead: boolean;
}

/** Read what holds the update back now. */
export async function readAppUpdateHolders(
  seams: Pick<
    WaitingAppUpdateSeams,
    "holdersHere" | "lockNames"
  > = browserWaitingAppUpdateSeams,
): Promise<AppUpdateHolders> {
  let names: Array<string>;
  try {
    names = await seams.lockNames();
  } catch {
    return { holders: seams.holdersHere(), locksRead: false };
  }
  return {
    holders: orderedAppUpdateHolders([
      ...seams.holdersHere(),
      ...names.flatMap((name) => {
        const holder = holderOfLock(name);
        return holder === undefined ? [] : [holder];
      }),
    ]),
    locksRead: true,
  };
}

/** What {@link applyWaitingAppUpdateBetweenRuns} did. */
export type WaitingAppUpdateOutcome =
  /** The page is reloading onto the update; the caller starts nothing more. */
  | { kind: "applying" }
  /** No update is ready for this page. */
  | { kind: "none-waiting" }
  /** Something held it back; `holders` is empty where the lock state could
   * not be read and nothing in this window holds it. */
  | { kind: "held"; holders: ReadonlyArray<AppUpdateHolder> }
  /** The takeover did not land within the wait. */
  | { kind: "not-taken-over" };

/** The outcome for a reading that found a hold, or `undefined` for none. */
function heldOutcome(
  reading: AppUpdateHolders,
): WaitingAppUpdateOutcome | undefined {
  return reading.holders.length > 0 || !reading.locksRead
    ? { kind: "held", holders: reading.holders }
    : undefined;
}

/**
 * Apply a waiting app update when nothing would be lost. Applies nothing here
 * when no update is ready, when anything holds it back, when the lock state
 * cannot be read, and when the takeover has not landed within
 * {@link APP_UPDATE_TAKEOVER_WAIT_MS}. The holds are read again once it has,
 * since a run or a view may have started during the wait.
 */
export async function applyWaitingAppUpdateBetweenRuns(
  seams: WaitingAppUpdateSeams = browserWaitingAppUpdateSeams,
): Promise<WaitingAppUpdateOutcome> {
  if (!seams.updateReady()) return { kind: "none-waiting" };
  const before = heldOutcome(await readAppUpdateHolders(seams));
  if (before !== undefined) return before;
  if (!(await seams.takeOver())) return { kind: "not-taken-over" };
  const after = heldOutcome(await readAppUpdateHolders(seams));
  if (after !== undefined) return after;
  seams.apply();
  return { kind: "applying" };
}
