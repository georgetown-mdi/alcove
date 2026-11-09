import styles from "@styles/app.module.css";

import {
  FailureAlert,
  FailureRecoveryButton,
  ReattachNotice,
  SERVER_JOB_KEEP_OPEN_BODY,
  untakenRecordConfirm,
} from "./RunSurface";
import { RunSectionTail, useRunHeadingFocus } from "./RunSectionTail";
import { reattachHeading, runReattachView } from "./reattachedRunState";
import { awaitingPartner } from "./exchangeRun";
import { useDiscardFolder } from "./discardFolder";
import { useJobExchangeRecordOffer } from "./useJobExchangeRecordOffer";

import type { ExchangeRun } from "./exchangeRun";
import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * The direct-exchange run column: the running screen (status panel plus the
 * keep-open callout while the console conducts the exchange) then the completion
 * panel with downloads -- the result, and the self-attested disclosure record and
 * its verification keys. Unlike the inviter's run column there is no share phase:
 * a direct exchange mints no invitation, so both parties run their halves against
 * the agreed server at once.
 *
 * Leaving the page does not stop the run (the strand-recovery panel is the way
 * back); the keep-open callout says so, and the peer-window callout adds that
 * both consoles must run their halves in the same window while still awaiting
 * the partner. A failed run shows the failure alert for its category: Try again
 * where the failure offers a retry, Start over for a terms mismatch or any
 * other non-retryable, non-output failure.
 */
export function DirectRunSection({
  run,
  outputs,
  failure,
  warnings,
  peerWindowBody,
  jobId,
  reattached,
  reattaching,
  onTryAgain,
  onStartOver,
  onAbandon,
}: {
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  warnings: ReadonlyArray<string>;
  /** The callout shown while the run still waits for the partner
   * (`serverJobPeerWindowBody` for the run's channel and peer timeout). */
  peerWindowBody: string;
  /** The console job id of this run, once created. Threads the run's job to the
   * recurring hand-off panel; undefined before the job exists. */
  jobId: string | undefined;
  /** The live status of the exchange this run re-attached to on a busy (409)
   * create, or undefined on a fresh run. When set, the surface heads with
   * recovery-style copy (it is watching an exchange the console already held, not
   * a fresh one) and drops the fresh-run keep-open framing, while keeping the
   * completion affordances -- the results summary and the recurring hand-off -- so
   * the operator still sees their run's outcome and graduation. */
  reattached: JobRunStatus | undefined;
  /** True during the brief interim between a busy (409) create being detected and
   * the liveness probe settling: the surface suppresses the fresh-run framing and
   * shows a reconnecting notice, before it resolves to the recovery view or the
   * run's alert. */
  reattaching: boolean;
  onTryAgain: () => void;
  onStartOver: () => void;
  /** Discard the current server-job exchange (cancel-if-running + DELETE), fired as
   * the operator leaves for a fresh exchange from the completion workfoot, so the
   * console's single slot frees for the next one. */
  onAbandon: () => void;
}) {
  const done = outputs !== undefined;
  const settled = done || failure !== undefined;
  // Where this run's exchange record stands on the console -- the one ask that
  // both offers the record and decides whether the failure recoveries, each of
  // which DELETEs the run's folder, confirm before doing so.
  const recordOffer = useJobExchangeRecordOffer(
    jobId,
    settled && outputs?.record === undefined,
  );
  const recordConfirm = untakenRecordConfirm(recordOffer);
  const discardFolder = useDiscardFolder(jobId, settled);
  const awaiting = awaitingPartner(run);
  // A retryable failure is a transport/exchange fault other than an internal
  // fault; the terms mismatch is a config failure, which -- like a security
  // failure -- is not retried as-is but sends the operator back to start over.
  // A shared name also offers start-over beside the retry: it keeps every
  // input, and the name is changed on the server step.
  const retryable = failure?.retry === "offered";
  const offersStartOver =
    failure !== undefined &&
    (!retryable || failure.sharedName === true) &&
    failure.category !== "output";

  const reattach = runReattachView({
    reattached,
    reattaching,
    failed: failure !== undefined,
    hasOutputs: outputs !== undefined,
  });
  const { reattachedRun, reattachState, recovering } = reattach;

  // The console host sends focus to the incoming section's heading on mount.
  const headingRef = useRunHeadingFocus({
    phase: done ? "done" : "running",
    failure,
    reattaching,
    reattachedRun,
  });

  const title =
    reattachHeading(reattach) ??
    (done
      ? "Exchange complete"
      : failure !== undefined
        ? "Exchange stopped"
        : "Exchange in progress");

  return (
    <>
      <h1 tabIndex={-1} ref={headingRef}>
        {title}
      </h1>
      <ReattachNotice
        reattaching={reattaching}
        reattachedRun={reattachedRun}
        state={reattachState}
      />
      {failure !== undefined && (
        <FailureAlert failure={failure}>
          {retryable && (
            <FailureRecoveryButton
              label="Try again"
              onAct={onTryAgain}
              recordConfirm={recordConfirm}
              folder={discardFolder}
            />
          )}
          {offersStartOver && (
            <FailureRecoveryButton
              label="Start over"
              onAct={onStartOver}
              recordConfirm={recordConfirm}
              folder={discardFolder}
            />
          )}
        </FailureAlert>
      )}
      {/* The keep-open callout stands through the whole running run: the console
          conducts the exchange, so leaving does not stop it (the recovery panel is
          the way back). The peer-window callout adds, only while the run still waits
          for the partner, that both consoles must run their halves at once. Both
          drop the moment the run finishes or fails. */}
      {!done && failure === undefined && !recovering && (
        <div className={styles.callout}>
          <p className={styles.calloutLead}>Keep this tab open.</p>
          <p className={styles.small}>{SERVER_JOB_KEEP_OPEN_BODY}</p>
          {awaiting && <p className={styles.small}>{peerWindowBody}</p>}
        </div>
      )}
      <RunSectionTail
        run={run}
        outputs={outputs}
        failure={failure}
        warnings={warnings}
        done={done}
        serverJob
        jobId={jobId}
        recordOffer={recordOffer}
        discardFolder={discardFolder}
        onAbandon={onAbandon}
      />
    </>
  );
}
