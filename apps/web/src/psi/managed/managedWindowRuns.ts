/**
 * The runs of saved exchanges this app window holds the run+rotate lock for,
 * and the stop a re-invite or a relay enrollment offers while one of them
 * waits for its partner (docs/spec/MANAGED_EXCHANGE_RECORD.md, Single-owner
 * invariant). A window reaches only its own runs: a run another window or the
 * installed app holds is not listed here, and nothing signals across windows.
 *
 * The run decides whether a stop lands, not the page. A stop is honored only
 * before the run writes its rotation-in-flight marker, and the run checks for
 * one inside the lock at that point ({@link ManagedWindowRun.passMarker}).
 * Both the check and the stop are synchronous, so a stop asked before the
 * check ends the run and one asked after it is refused.
 */

/** Raised by a run a stop ended before it wrote its rotation-in-flight
 * marker: nothing was rotated, and the partner saw no key exchange. */
export class ManagedRunStoppedError extends Error {
  constructor(id: string) {
    super(
      `the run of managed exchange ${id} was stopped while it waited for its partner`,
    );
    this.name = "ManagedRunStoppedError";
  }
}

/** Where a run of this window stands: `"waiting"` before its
 * rotation-in-flight marker, when a stop is honored, and `"exchanging"`
 * after it, when none is. */
export type ManagedWindowRunStage = "waiting" | "exchanging";

interface WindowRunState {
  stop: AbortController;
  stage: ManagedWindowRunStage;
  stopRequested: boolean;
}

const windowRuns = new Map<string, WindowRunState>();

/** A run's entry in this window's list, from taking the lock to releasing it. */
export interface ManagedWindowRun {
  /**
   * Called immediately before the rotation-in-flight marker is written: throws
   * {@link ManagedRunStoppedError} where a stop was asked, and otherwise moves
   * the run to `"exchanging"`, so no later stop is honored.
   */
  passMarker: () => void;
  /** Drop the entry; called as the run releases the lock. */
  release: () => void;
}

/**
 * List a run of `id` this window holds the lock for. `stop` is the run's own
 * controller, aborted with a {@link ManagedRunStoppedError} when a stop is
 * honored.
 */
export function enterManagedWindowRun(
  id: string,
  stop: AbortController,
): ManagedWindowRun {
  const state: WindowRunState = {
    stop,
    stage: "waiting",
    stopRequested: false,
  };
  windowRuns.set(id, state);
  return {
    passMarker: () => {
      if (state.stopRequested) throw new ManagedRunStoppedError(id);
      state.stage = "exchanging";
    },
    release: () => {
      if (windowRuns.get(id) === state) windowRuns.delete(id);
    },
  };
}

/** Where this window's run of `id` stands, or `undefined` where this window
 * holds no run of it. */
export function managedWindowRunStage(
  id: string,
): ManagedWindowRunStage | undefined {
  return windowRuns.get(id)?.stage;
}

/**
 * Stop this window's run of `id` if it is still waiting for its partner.
 * Returns `"stopped"` where it was, the stage it stands at where it was not,
 * or `undefined` where this window holds no run of it. The run releases the
 * lock as it unwinds, so the operation that follows requests the lock queued
 * rather than `ifAvailable`, ahead of any later attempt.
 */
export function stopWaitingManagedWindowRun(
  id: string,
): "stopped" | "exchanging" | undefined {
  const state = windowRuns.get(id);
  if (state === undefined) return undefined;
  if (state.stage === "exchanging") return "exchanging";
  state.stopRequested = true;
  state.stop.abort(new ManagedRunStoppedError(id));
  return "stopped";
}
