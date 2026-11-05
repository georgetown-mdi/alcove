import { useEffect } from "react";

import { orderedAppUpdateHolders } from "./appUpdateHolder";

import type { AppUpdateHolder } from "./appUpdateHolder";

/**
 * What holds back the scheduled runner's own apply of a waiting app update
 * (`apps/web/src/psi/managed/managedAppUpdate.ts`), in two reaches:
 *
 * - Across every same-origin window: a page whose leave-page prompt is armed
 *   holds a lock named by {@link appShellUpdateHoldLockName}, in shared mode,
 *   so no window's apply hands the origin to a new worker under it.
 * - In this window only: a view showing what the page holds only in memory --
 *   a finished run's downloads, an edit not yet saved -- counts a hold here.
 *   The apply reloads only its own window, so another window's view is not
 *   lost by it.
 *
 * Each hold names its `AppUpdateHolder` (`./appUpdateHolder.ts`), which the
 * update banner and a scheduled run's record state. Neither prompts anything; the banner's Reload
 * ignores both.
 */

/** The holders a leave-page prompt is armed for. */
export type AppUpdateHolderAcrossWindows = Extract<
  AppUpdateHolder,
  "run" | "file"
>;

/** The prefix of every cross-window hold's Web Locks name. */
export const APP_SHELL_UPDATE_HOLD_LOCK_NAME = "alcove-app-shell-update-hold";

/** The Web Locks name a page holds, in shared mode, while its leave-page
 * prompt is armed for `holder`. Any number of pages hold it at once. */
export function appShellUpdateHoldLockName(
  holder: AppUpdateHolderAcrossWindows,
): string {
  return `${APP_SHELL_UPDATE_HOLD_LOCK_NAME}:${holder}`;
}

/** The holder a cross-window hold's lock name stands for, or `undefined` for
 * any other name. A hold name this build does not know -- the bare prefix a
 * page of an earlier build holds, or another suffix -- still holds the update,
 * and is stated as `"file"`, which leaving that page releases. */
export function appUpdateHolderOfHoldLock(
  name: string,
): AppUpdateHolderAcrossWindows | undefined {
  if (name === appShellUpdateHoldLockName("run")) return "run";
  if (name === appShellUpdateHoldLockName("file")) return "file";
  if (
    name === APP_SHELL_UPDATE_HOLD_LOCK_NAME ||
    name.startsWith(`${APP_SHELL_UPDATE_HOLD_LOCK_NAME}:`)
  ) {
    return "file";
  }
  return undefined;
}

const heldHere = new Map<AppUpdateHolder, number>();

/** Whether a view in this window holds the update back. */
export function appShellUpdateHeldHere(): boolean {
  return heldHere.size > 0;
}

/** What the views in this window hold the update back for. */
export function appShellUpdateHoldersHere(): Array<AppUpdateHolder> {
  return orderedAppUpdateHolders(heldHere.keys());
}

/** Hold the update back in this window for `holder` until the returned
 * function is called; a second call of it releases nothing more. */
export function holdAppShellUpdateHere(holder: AppUpdateHolder): () => void {
  heldHere.set(holder, (heldHere.get(holder) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (heldHere.get(holder) ?? 1) - 1;
    if (count > 0) heldHere.set(holder, count);
    else heldHere.delete(holder);
  };
}

/** Hold the update back in this window for `holder` while `held`. */
export function useAppShellUpdateHold(
  held: boolean,
  holder: AppUpdateHolder,
): void {
  useEffect(() => {
    if (!held) return;
    return holdAppShellUpdateHere(holder);
  }, [held, holder]);
}

/** The lock manager this context reaches, or `undefined` where it has none. */
function lockManager(): LockManager | undefined {
  try {
    return (globalThis.navigator as Navigator | undefined)?.locks;
  } catch {
    return undefined;
  }
}

/**
 * Hold the cross-window lock for `holder` until the returned function is
 * called. A browser without Web Locks holds nothing, and runs no scheduled
 * runner that could read it either: the run lock needs the same API.
 */
export function holdAppShellUpdateAcrossWindows(
  holder: AppUpdateHolderAcrossWindows,
): () => void {
  const locks = lockManager();
  if (locks === undefined) return () => undefined;
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new AbortController();
  locks
    .request(
      appShellUpdateHoldLockName(holder),
      { mode: "shared", signal: pending.signal },
      () => released,
    )
    .catch(() => undefined);
  return () => {
    pending.abort();
    release();
  };
}

/** @internal */
export function resetAppShellUpdateHold(): void {
  heldHere.clear();
}
