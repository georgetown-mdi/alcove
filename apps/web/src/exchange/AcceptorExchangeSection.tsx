import { describeResolvedMatching } from "@alcove/core";

import styles from "@styles/app.module.css";

import {
  BROWSER_RUN_KEEP_OPEN_BODY,
  FailureAlert,
  FailureRecoveryButton,
  ReattachNotice,
  SERVER_JOB_KEEP_OPEN_BODY,
  leftBehindConfirm,
  serverJobPeerWindowBody,
  untakenRecordConfirm,
  useDownloadsLeftBehind,
} from "./RunSurface";
import { RunSectionTail, useRunHeadingFocus } from "./RunSectionTail";
import { reattachHeading, runReattachView } from "./reattachedRunState";
import { useBeforeUnloadPrompt } from "./useUnloadGuard";
import { useDiscardFolder } from "./discardFolder";
import { useJobExchangeRecordOffer } from "./useJobExchangeRecordOffer";

import { acceptorRetryAllowed } from "./useAcceptorExchange";

import type { AvailableRecordOffer, RunOutputs } from "@psi/runOutputs";
import type { AcceptableInvitation } from "@psi/acceptInvitation";
import type { ExchangeRun } from "./exchangeRun";
import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";
import type { RunFailure } from "./useInviterExchange";

/**
 * The acceptor's run/completion work column, re-using the shared run furniture
 * ({@link RunSurface}) with the acceptor's own vocabulary. Unlike the
 * inviter, the acceptor has no share phase: it dials on arrival, so the column
 * opens at the running screen and ends at the completion panel. The status
 * panel spans both from one stable mount so its live region persists.
 *
 * The run's own non-fatal warnings -- the console's rendezvous preflight among
 * them -- show through the shared {@link RunWarningsAlert}, which a failure
 * does not clear.
 *
 * A failed run renders the failure vocabulary's alert for its category, each
 * with its one concrete way forward -- an acceptor seat cannot mint, so every
 * non-retryable recovery is a link to the quick path to paste a fresh
 * invitation, and a config fault returns to the confirm-columns step. A fault
 * no settings change resolves takes the fresh-invitation link instead. No
 * failure clears any operator input.
 */
export function AcceptorExchangeSection({
  invitation,
  run,
  outputs,
  failure,
  runRecord,
  runWarnings,
  serverJob,
  peerTimeoutMs,
  jobId,
  reattached,
  reattaching,
  onTryAgain,
  onFixColumns,
  onAbandon,
}: {
  invitation: AcceptableInvitation;
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  /** The exchange record a failed in-browser run holds (`useFailedRunRecord`),
   * offered in the record panel a console run's record takes; undefined on
   * every other run. */
  runRecord: AvailableRecordOffer | undefined;
  /** The run's accumulated non-fatal warnings (the driver's `onWarning` slot),
   * rendered through the shared alert as the inviter seat renders them. These
   * survive a failure: a preflight warning the failure may have followed from must
   * not vanish with the run. */
  runWarnings: ReadonlyArray<string>;
  /** Whether this accept executes on the console (a server-job run)
   * rather than in this browser. On the console the CLI child conducts the
   * exchange while the tab stays open, so the keep-open callout names the running
   * exchange the tab is holding. */
  serverJob: boolean;
  /** The peer timeout the operator set for this run, or undefined for the
   * channel's default; the peer-window callout states it. */
  peerTimeoutMs: number | undefined;
  /** The console job id of a server-job accept, once created. Threads the run's
   * job to the recurring hand-off panel; undefined on a browser accept. */
  jobId: string | undefined;
  /** The live status of the exchange this accept re-attached to on a busy (409)
   * create, or undefined on a fresh run. When set, the surface heads with
   * recovery-style copy (it is watching an exchange the console already held,
   * not a fresh one) and drops the fresh-run keep-open framing, while keeping the
   * completion affordances -- the results summary and the recurring hand-off -- so
   * the operator still sees their run's outcome and graduation. */
  reattached: JobRunStatus | undefined;
  /** True during the brief interim between a busy (409) create being detected and
   * the liveness probe settling: the surface suppresses the fresh-run framing and
   * shows a reconnecting notice, before it resolves to the recovery view or the
   * run's alert. */
  reattaching: boolean;
  onTryAgain: () => void;
  /** Return to the confirm-columns step with every setting intact -- a prepare-time
   * config failure's recovery, since the acceptor fixes its own settings there. */
  onFixColumns: () => void;
  /** Discard the current server-job exchange (cancel-if-running + DELETE), fired as
   * the operator leaves for a fresh invitation (the start-over link) or a new
   * exchange (the completion workfoot), so the console's single slot frees. A
   * no-op on a browser run. */
  onAbandon: () => void;
}) {
  const phase = outputs !== undefined ? "done" : "running";
  const settled = phase === "done" || failure !== undefined;

  // Where this run's exchange record stands on the console -- the one ask that
  // both offers the record and decides whether the failure recoveries, each of
  // which DELETEs the run's folder, confirm before doing so.
  const jobRecordOffer = useJobExchangeRecordOffer(
    serverJob ? jobId : undefined,
    settled && outputs?.record === undefined,
  );
  const recordConfirm = untakenRecordConfirm(jobRecordOffer);
  const discardFolder = useDiscardFolder(
    serverJob ? jobId : undefined,
    settled,
  );
  // A failed browser run's record confirms nothing on recovery: the confirm
  // speaks of the console's folder, and the panel itself states what discards
  // this page's copy.
  const recordOffer = runRecord ?? jobRecordOffer;

  const reattach = runReattachView({
    reattached,
    reattaching,
    failed: failure !== undefined,
    hasOutputs: outputs !== undefined,
  });
  const { reattachedRun, reattachState, recovering } = reattach;

  const { leftBehind, onDownload } = useDownloadsLeftBehind(outputs);
  useBeforeUnloadPrompt(
    !serverJob && phase === "done" && leftBehind.length > 0,
  );

  // A failure the hook will not retry routes to the fresh-invitation link.
  const retryable =
    failure?.retry === "offered" &&
    acceptorRetryAllowed(invitation.token.expires, new Date());
  // A shared name is changed on the columns step too, so it returns there
  // beside the retry while the invitation can still run.
  const columnsCanResolve =
    (failure?.category === "config" &&
      failure.settingsCannotResolve !== true) ||
    (failure?.sharedName === true && retryable);
  const offersFreshInvitation =
    failure !== undefined &&
    !retryable &&
    (failure.category === "security" ||
      failure.category === "exchange" ||
      (failure.category === "config" && !columnsCanResolve));

  // The h1 takes focus on mount: the acceptor pressed "Start the exchange",
  // whose button unmounts, and the console host does not drive focus for this
  // step, so a keyboard or screen-reader user lands on the run screen.
  const headingRef = useRunHeadingFocus({
    phase,
    failure,
    reattaching,
    reattachedRun,
    focusOnMount: true,
  });

  const title =
    reattachHeading(reattach) ??
    (phase === "done" ? "Exchange complete" : "Exchange in progress");

  return (
    <>
      <h1 tabIndex={-1} ref={headingRef}>
        {title}
      </h1>
      {/* Run status rather than a notice: the pair the terms exchange fixed
          is shown beneath the heading from the moment it is known until the
          run completes. */}
      {phase !== "done" && run.matching !== undefined && (
        <p className={styles.sub}>{describeResolvedMatching(run.matching)}</p>
      )}
      <ReattachNotice
        reattaching={reattaching}
        reattachedRun={reattachedRun}
        state={reattachState}
      />
      {failure !== undefined && (
        <FailureAlert failure={failure}>
          {failure.partnerNoShow === true && retryable && (
            <p>
              Ask your partner to open their invitation page again, then choose
              Keep waiting. If they no longer have it, ask them for a new
              invitation.
            </p>
          )}
          {retryable && (
            <FailureRecoveryButton
              label={
                failure.partnerNoShow === true ? "Keep waiting" : "Try again"
              }
              onAct={onTryAgain}
              recordConfirm={recordConfirm}
              folder={discardFolder}
            />
          )}
          {offersFreshInvitation && (
            <FailureRecoveryButton
              label="Start over with a fresh invitation"
              onAct={onAbandon}
              to="/quick"
              recordConfirm={recordConfirm}
              folder={discardFolder}
            />
          )}
          {/* A prepare-time fault in this party's own settings, or a name it
              likely shares with its partner: the acceptor changes it on the
              confirm-columns step with every input intact. */}
          {columnsCanResolve && (
            <FailureRecoveryButton
              label="Back to your columns"
              onAct={onFixColumns}
              recordConfirm={recordConfirm}
              folder={discardFolder}
            />
          )}
        </FailureAlert>
      )}
      {/* The callout drops the moment a failure lands (the run it describes has
          torn down), so it outlives no failure. On a server-job accept the
          console conducts the run and the tab only watches it: leaving does not
          stop it, and the recovery panel is the way back. An in-browser accept
          ends for both parties if this tab closes. */}
      {phase === "running" && failure === undefined && !recovering && (
        <div className={styles.callout}>
          <p className={styles.calloutLead}>Keep this tab open.</p>
          {serverJob ? (
            <>
              <p className={styles.small}>{SERVER_JOB_KEEP_OPEN_BODY}</p>
              <p className={styles.small}>
                {serverJobPeerWindowBody(
                  invitation.endpoint.channel,
                  peerTimeoutMs,
                )}
              </p>
            </>
          ) : (
            <p className={styles.small}>{BROWSER_RUN_KEEP_OPEN_BODY}</p>
          )}
        </div>
      )}
      <RunSectionTail
        run={run}
        outputs={outputs}
        failure={failure}
        warnings={runWarnings}
        done={phase === "done"}
        serverJob={serverJob}
        jobId={jobId}
        recordOffer={recordOffer}
        discardFolder={discardFolder}
        onDownload={onDownload}
        leaveConfirm={leftBehindConfirm(leftBehind)}
        onAbandon={onAbandon}
      />
    </>
  );
}
