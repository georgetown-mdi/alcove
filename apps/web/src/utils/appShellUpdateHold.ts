import { useEffect } from "react";

/**
 * What holds back the scheduled runner's own apply of a waiting app update
 * (`apps/web/src/psi/managed/managedAppUpdate.ts`), in two reaches:
 *
 * - Across every same-origin window: a page whose leave-page prompt is armed
 *   holds {@link APP_SHELL_UPDATE_HOLD_LOCK_NAME}, in shared mode, so no
 *   window's apply hands the origin to a new worker under it.
 * - In this window only: a view showing what the page holds only in memory --
 *   a finished run's downloads, an edit not yet saved -- counts a hold here.
 *   The apply reloads only its own window, so another window's view is not
 *   lost by it.
 *
 * Neither prompts or shows anything; the banner's Reload ignores both.
 */

/** The Web Locks name a page holds, in shared mode, while its leave-page
 * prompt is armed. Any number of pages hold it at once. */
export const APP_SHELL_UPDATE_HOLD_LOCK_NAME = "alcove-app-shell-update-hold";

let heldHere = 0;

/** Whether a view in this window holds the update back. */
export function appShellUpdateHeldHere(): boolean {
  return heldHere > 0;
}

/** Hold the update back in this window until the returned function is
 * called; a second call of it releases nothing more. */
export function holdAppShellUpdateHere(): () => void {
  heldHere += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    heldHere -= 1;
  };
}

/** Hold the update back in this window while `held`. */
export function useAppShellUpdateHold(held: boolean): void {
  useEffect(() => {
    if (!held) return;
    return holdAppShellUpdateHere();
  }, [held]);
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
 * Hold {@link APP_SHELL_UPDATE_HOLD_LOCK_NAME} until the returned function is
 * called. A browser without Web Locks holds nothing, and runs no scheduled
 * runner that could read it either: the run lock needs the same API.
 */
export function holdAppShellUpdateAcrossWindows(): () => void {
  const locks = lockManager();
  if (locks === undefined) return () => undefined;
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new AbortController();
  locks
    .request(
      APP_SHELL_UPDATE_HOLD_LOCK_NAME,
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
  heldHere = 0;
}
