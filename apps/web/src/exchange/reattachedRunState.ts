import { RECONNECTING_HEADING, recoveredExchangeHeading } from "./RunSurface";

import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";
import type { ReattachedRunState } from "./RunSurface";

/** How a run section stands toward an exchange the console already held. */
export interface RunReattachView {
  /** Whether a busy (409) create re-attached this section to that exchange. */
  reattachedRun: boolean;
  reattachState: ReattachedRunState;
  /** Whether fresh-run framing (the share block, the keep-open callout, the
   * fresh title) is withheld: once re-attached, and during the reconnecting
   * interim, so it never flashes while the 409 is being resolved. */
  recovering: boolean;
}

/**
 * The re-attachment view the three run sections share. A busy (409) create at
 * start -- a second tab, a navigate-away-and-back, or an orphaned job -- means
 * the section watches an exchange the console already held, so it heads with
 * recovery copy and never displays as a fresh success, while the completion
 * affordances (the results summary and the recurring hand-off) still show.
 */
export function runReattachView(args: {
  reattached: JobRunStatus | undefined;
  reattaching: boolean;
  failed: boolean;
  hasOutputs: boolean;
}): RunReattachView {
  const { reattached, reattaching, failed, hasOutputs } = args;
  const reattachedRun = reattached !== undefined;
  return {
    reattachedRun,
    reattachState: reattachedRunState({
      failed,
      hasOutputs,
      status: reattached ?? "running",
    }),
    recovering: reattaching || reattachedRun,
  };
}

/** The heading a run section shows in place of its fresh-run title while
 * re-attached or reconnecting; undefined on a fresh run. */
export function reattachHeading(view: RunReattachView): string | undefined {
  if (view.reattachedRun) return recoveredExchangeHeading(view.reattachState);
  return view.recovering ? RECONNECTING_HEADING : undefined;
}

/**
 * The state a re-attached console run starts in, used by both run sections and the
 * strand-recovery panel: a delivered terminal result (a run failure, or received
 * outputs) wins; otherwise the busy probe's initial status decides, so a
 * re-attached terminal run never shows "still running" before the replay
 * arrives. A `stopped` run has no downloads.
 */
export function reattachedRunState(args: {
  failed: boolean;
  hasOutputs: boolean;
  status: JobRunStatus;
}): ReattachedRunState {
  const { failed, hasOutputs, status } = args;
  if (
    failed ||
    (!hasOutputs && (status === "failed" || status === "cancelled"))
  )
    return "stopped";
  if (hasOutputs || status === "succeeded") return "finished";
  return "running";
}
