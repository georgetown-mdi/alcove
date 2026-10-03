import { useEffect, useRef, useState } from "react";

import { Alert, Button } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { describeResolvedMatching } from "@alcove/core";

import { dateTimeLabel, invitationUsable } from "@psi/formatting";
import { OPENED_EXCHANGE_CONTINUES } from "@console/mountedConfiguration";
import { RecurringHandoff } from "@recurring/RecurringHandoff";
import { TermsChangeRecovery } from "@console/TermsChangeRecovery";
import styles from "@styles/app.module.css";

import { isConsoleBuild } from "@utils/clientConfig";

import { awaitingPartner } from "./exchangeRun";
import { invitationMessage } from "./invitationMessage";
import { invitationReach } from "./invitationReach";

import {
  AnotherExchangeFoot,
  CopyRow,
  DonePanel,
  FailureAlert,
  FailureRecoveryButton,
  RECONNECTING_HEADING,
  ReattachNotice,
  RunDownloads,
  RunWarningsAlert,
  SERVER_JOB_KEEP_OPEN_BODY,
  SERVER_JOB_PEER_WINDOW_BODY,
  recoveredExchangeHeading,
  untakenRecordConfirm,
} from "./RunSurface";
import { DiagnosticLogPanel } from "./DiagnosticLogPanel";
import { ReceiptDownload } from "./ReceiptDownload";
import { RecordDownload } from "./RecordDownload";
import { StatusPanel } from "./StatusPanel";
import { reattachedRunState } from "./reattachedRunState";
import { useDiscardFolder } from "./discardFolder";
import { useJobExchangeRecordOffer } from "./useJobExchangeRecordOffer";

import type { AvailableRecordOffer, RunOutputs } from "@psi/runOutputs";
import type { ExchangeRun } from "./exchangeRun";
import type { GeneratedInvitation } from "@psi/invitation";
import type { JobRunStatus } from "@psi/jobClient/serverJobExchangeDriver";
import type { RunFailure } from "./useInviterExchange";

/**
 * The inviter's post-create work column, through the run's three phases: the
 * share screen (copy artifacts, one-time-secret guidance, expiry) while the
 * browser listens for the partner, the running screen once a protocol stage
 * begins, and the completion panel with the downloads and their caveats. The
 * status panel spans all three from one stable mount so its live region
 * persists. A failed run renders the failure vocabulary's alert for its
 * category, each with its one concrete way forward; no failure clears what
 * the operator authored.
 */
export function InviterExchangeSection({
  invitation,
  inviterName,
  run,
  outputs,
  failure,
  runRecord,
  warnings,
  partnerAcceptsByCli,
  onDownloadAcceptKit,
  serverJob,
  continuesOpenedExchange = false,
  jobId,
  reattached,
  reattaching,
  onTryAgain,
  onStartOver,
  onReviewAppliedTerms,
  onAbandon,
}: {
  invitation: GeneratedInvitation;
  /** The name the inviter gave, which signs the message offered for a
   * browser partner. */
  inviterName: string;
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  /** The exchange record a failed in-browser run holds (`useFailedRunRecord`),
   * offered in the record panel a console run's record takes; undefined on
   * every other run. */
  runRecord: AvailableRecordOffer | undefined;
  /** The run's accumulated non-fatal warnings (the driver's `onWarning` slot),
   * rendered beside the status panel through every phase. */
  warnings: ReadonlyArray<string>;
  /** Whether the partner accepts through the command-line tool (the CLI
   * transports' server-job runs), whose accept takes the bare code -- the
   * share screen then offers the code beside the link. A browser partner
   * needs only the link: the accept form swallows a pasted deep link whole
   * (tokenFromInput), so the bare code adds nothing but a second secret to
   * leave on screen. */
  partnerAcceptsByCli: boolean;
  /** Write the partner's accept kit -- the printable instruction sheet sent
   * alongside the invitation -- to the operator's disk. Omitted wherever no kit
   * applies: a WebRTC partner accepts in their browser and needs none, and the
   * hosted build's CLI transports mint on the save surface rather than here. */
  onDownloadAcceptKit?: () => void;
  /** Whether this run executes on the console (a server-job run) rather
   * than in this browser. On the console the CLI child conducts the exchange
   * while the tab stays open, so the keep-open callout names the running exchange
   * the tab is holding rather than a browser listener. */
  serverJob: boolean;
  /** Whether the run continues the exchange the opened configuration set up,
   * under the key file beside it. The invitation this screen holds is then
   * never sent: the share block gives way to a line saying so, and a retry
   * does not wait on that invitation's expiry. */
  continuesOpenedExchange?: boolean;
  /** The console job id of a server-job run, once created. Threads the run's job
   * to the recurring hand-off panel; undefined on a browser run. */
  jobId: string | undefined;
  /** The live status of the exchange this run re-attached to on a busy (409)
   * create, or undefined on a fresh run. When set, the surface heads with
   * recovery-style copy (it is watching an exchange the console already held,
   * not a fresh one) and drops the fresh-run share / keep-open framing, while
   * keeping the completion affordances -- the results summary and the recurring
   * hand-off -- so the operator still sees their run's outcome and graduation. */
  reattached: JobRunStatus | undefined;
  /** True during the brief interim between a busy (409) create being detected and
   * the liveness probe settling: the surface suppresses the fresh-run share block
   * and shows a reconnecting notice, before it resolves to the recovery view or
   * the run's alert. */
  reattaching: boolean;
  onTryAgain: () => void;
  onStartOver: () => void;
  /** Leave a run whose partner's changed terms were applied to the mounted
   * configuration for Review & create, with that configuration opened again
   * so the next run is composed from the terms it now holds. */
  onReviewAppliedTerms: () => void;
  /** Discard the current server-job exchange (cancel-if-running + DELETE), fired
   * as the operator leaves for a fresh exchange from the completion workfoot, so
   * the console's single slot frees for the next one. A no-op on a browser run
   * (no console job). */
  onAbandon: () => void;
}) {
  const phase =
    outputs !== undefined ? "done" : awaitingPartner(run) ? "share" : "running";
  // The run reached a terminal, which is what the three console-artifact
  // panels below key on: each states its artifact's standing once the run is
  // past producing it.
  const settled = phase === "done" || failure !== undefined;

  // Where this run's exchange record stands on the console. Asked only once the
  // run has settled and only where the completion downloads are not already
  // holding the pair, so the ordinary successful run makes no second request. The
  // one answer drives both the record panel and whether the failure recoveries --
  // each of which DELETEs the run's folder -- confirm before doing so.
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

  // A busy (409) create at start re-attached this surface to an exchange the
  // console already held (a second tab, a navigate-away-and-back, or an orphaned
  // job). It then heads with recovery-style copy and drops the fresh-run share /
  // keep-open framing, so it never displays as a fresh success -- but the completion
  // affordances (the results summary and the recurring hand-off) still show, since
  // those hold however the operator reached completion.
  const reattachedRun = reattached !== undefined;
  const reattachState = reattachedRunState({
    failed: failure !== undefined,
    hasOutputs: outputs !== undefined,
    status: reattached ?? "running",
  });
  // Fresh-run framing (the share block, the keep-open callout, the fresh title) is
  // suppressed both once re-attached and during the reconnecting interim, so the
  // fresh block never flashes while the 409 is being resolved.
  const recovering = reattaching || reattachedRun;

  // A retry is genuine only while the invitation can still be accepted:
  // re-listening on a lapsed credential cannot succeed, so an expired
  // exchange failure routes to start-over and stops advertising the link.
  const retryable =
    failure?.retry === "offered" &&
    (continuesOpenedExchange ||
      invitationUsable(invitation.expires, new Date()));

  // Every non-retryable failure except output (whose exchange already succeeded, so
  // nothing here may invite a re-run) offers exactly one recovery: a fresh invitation
  // via start-over, back to Review & create with every input intact.
  //
  // Once the partner's changed terms are applied to the mounted configuration,
  // the terms-change recovery's own control is the way forward: starting over
  // without reopening the file would run the terms it no longer holds.
  const [termsApplied, setTermsApplied] = useState(false);
  useEffect(() => {
    setTermsApplied(false);
  }, [failure]);
  const offersStartOver =
    !retryable &&
    !termsApplied &&
    failure !== undefined &&
    failure.category !== "output";

  // The phase-level focus throughline. The console host moves focus to the h1
  // when the section mounts; within the section, focus moves again when the
  // partner connects or a retry clears the alert -- the share block or the
  // alert (either of which may hold focus, on a copy button or the Try again
  // button) unmounts, so without this the browser drops focus to <body> --
  // and at completion, so the results are read. The reconnecting-interim and
  // recovery swaps run through it too (via the deps) so an orphaned focus lands
  // on the recovery heading. The recovery moves fire only when focus was
  // actually orphaned onto <body>, so focus the user placed on a live element is
  // not stolen; completion always moves it. While a failure is showing, the
  // alert-focus effect below owns the moment.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (phase === "done") {
      headingRef.current?.focus();
      return;
    }
    if (failure !== undefined) return;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [phase, failure, reattaching, reattachedRun]);

  const title = reattachedRun
    ? recoveredExchangeHeading(reattachState)
    : reattaching
      ? RECONNECTING_HEADING
      : phase === "done"
        ? "Exchange complete"
        : phase === "running"
          ? "Exchange in progress"
          : continuesOpenedExchange
            ? "Waiting for your partner"
            : "Your invitation is ready";

  return (
    <>
      <h1 tabIndex={-1} ref={headingRef}>
        {title}
      </h1>
      {/* Run status rather than a notice: the pair the terms exchange fixed
          reads beneath the heading from the moment it is known, and the
          completion panel restates it. */}
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
          {failure.termsChange !== undefined && (
            <TermsChangeRecovery
              termsChange={failure.termsChange}
              jobId={jobId}
              canApply={serverJob && continuesOpenedExchange}
              onApplied={() => setTermsApplied(true)}
              onReviewApplied={onReviewAppliedTerms}
            />
          )}
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
              label={
                continuesOpenedExchange
                  ? "Start over"
                  : "Start over with a fresh invitation"
              }
              onAct={onStartOver}
              recordConfirm={recordConfirm}
              folder={discardFolder}
            />
          )}
        </FailureAlert>
      )}
      {/* The copy artifacts drop out once the partner connects (nothing left
          to share) and on any failure except a retryable one -- a dead
          invitation (failed authentication, terminal config fault, lapsed
          expiry) must not keep being advertised for copying, while a
          retryable failure's link stays valid for another attempt. */}
      {phase === "share" &&
        continuesOpenedExchange &&
        failure === undefined &&
        !recovering && <p>{OPENED_EXCHANGE_CONTINUES}</p>}
      {phase === "share" &&
        !continuesOpenedExchange &&
        (failure === undefined || retryable) &&
        !recovering && (
          <>
            <h2>Share this invitation</h2>
            <LimitedReachAlert
              link={invitation.deepLink}
              partnerAcceptsByCli={partnerAcceptsByCli}
            />
            {partnerAcceptsByCli ? (
              <p>
                Send one of these to your partner over a trusted channel (for
                example, secure email). It carries a one-time secret, so treat
                it as confidential. Keep this tab open while your partner
                accepts.
              </p>
            ) : (
              <p>
                Send this link to your partner over a trusted channel (for
                example, secure email). It carries a one-time secret, so treat
                it as confidential. If the link arrives broken, your partner can
                paste the whole link into the accept form. Keep this tab open
                while your partner accepts.
              </p>
            )}
            <CopyRow label="Invitation link" value={invitation.deepLink} />
            {!partnerAcceptsByCli && (
              <CopyRow
                label="A message to send"
                hint="The link with a note on what it is, when it expires, and where to practice first"
                value={invitationMessage({
                  inviterName,
                  deepLink: invitation.deepLink,
                  expires: invitation.expires,
                  practiceOrigin: practiceOriginFor(invitation.deepLink),
                })}
                previewOf={invitation.deepLink}
                noun="message"
              />
            )}
            {partnerAcceptsByCli && (
              <CopyRow
                label="Invitation code"
                hint="Your partner accepts with this same code, whichever transport they run"
                value={invitation.encoded}
              />
            )}
            {onDownloadAcceptKit !== undefined && (
              <>
                <p className={styles.small}>
                  Your partner accepts from the command line -- send them the
                  code, with these instructions alongside it. The sheet takes
                  them from nothing to accepting and carries no secret, so it
                  can travel any way that suits them.
                </p>
                <Button variant="default" onClick={onDownloadAcceptKit}>
                  Download instructions for your partner
                </Button>
              </>
            )}
            <p className={styles.small}>
              <strong>
                This invitation expires{" "}
                <span className={styles.mono}>
                  {dateTimeLabel(new Date(invitation.expires))}
                </span>
                .
              </strong>
            </p>
          </>
        )}
      {/* The keep-open callout drops the moment any failure lands: the run it
          describes has torn down, so it outlives no failure, not even a retryable
          one. On a server-job run the console conducts the exchange and this tab
          only watches it, so the callout persists into the running phase -- leaving
          does not stop the run, and the recovery panel is the way back. The browser
          listener's copy is share-only: once the partner connects, nothing it says
          still holds, so it does not extend past the share phase. */}
      {(phase === "share" || (phase === "running" && serverJob)) &&
        failure === undefined &&
        !recovering && (
          <div className={styles.callout}>
            <p className={styles.calloutLead}>Keep this tab open.</p>
            <p className={styles.small}>
              {serverJob
                ? SERVER_JOB_KEEP_OPEN_BODY
                : "Your browser is listening for your partner. Closing the tab cancels the invitation; reloading starts over."}
            </p>
            {serverJob && phase === "share" && (
              <p className={styles.small}>{SERVER_JOB_PEER_WINDOW_BODY}</p>
            )}
          </div>
        )}
      {phase === "done" && (
        <DonePanel outputs={outputs} finishedAt={run.finishedAt} />
      )}
      <RunWarningsAlert warnings={warnings} />
      <StatusPanel
        run={run}
        done={phase === "done"}
        halted={failure !== undefined}
      />
      {phase === "done" && outputs !== undefined && (
        <RunDownloads outputs={outputs} heading="h2" />
      )}
      <RecordDownload
        offer={recordOffer}
        heldBy={serverJob ? "console" : "page"}
      />
      {serverJob && jobId !== undefined && (
        <>
          <ReceiptDownload jobId={jobId} settled={settled} />
          <DiagnosticLogPanel jobId={jobId} settled={settled} />
        </>
      )}
      {/* The hand-off is composed at job creation and served for the record's
          lifetime, so the panel stands from the moment the console holds the
          job: collapsed while the run is still in flight (graduation is not the
          job at hand yet), expanded once the run completes and it is. It drops
          on a failure, whose surface offers its own one way forward. */}
      {serverJob && jobId !== undefined && failure === undefined && (
        <RecurringHandoff jobId={jobId} collapsible={phase !== "done"} />
      )}
      {(phase === "done" || failure?.category === "output") && (
        <AnotherExchangeFoot
          onNavigate={onAbandon}
          confirmBeforeLeave={serverJob}
          folder={discardFolder}
        />
      )}
    </>
  );
}

/**
 * The warning a share screen shows when its invitation link was created on an
 * address a partner elsewhere cannot open. A partner accepting from the command
 * line reads the code, which names no address of this page, so only the link
 * is limited for them.
 */
function LimitedReachAlert({
  link,
  partnerAcceptsByCli,
}: {
  link: string;
  partnerAcceptsByCli: boolean;
}) {
  const reach = invitationReach(link);
  if (reach === "anywhere") return null;
  const where =
    reach === "thisComputer" ? "this computer" : "your local network";
  return (
    <Alert
      color="yellow"
      icon={<IconAlertTriangle aria-hidden />}
      title={
        partnerAcceptsByCli
          ? `The invitation link only works on ${where}`
          : `This invitation only works on ${where}`
      }
      role="status"
      mb="md"
    >
      {partnerAcceptsByCli
        ? "Send your partner the invitation code instead of the link."
        : reach === "thisComputer"
          ? "This page runs on your own computer, so a partner on another computer cannot accept. To exchange with them, create the invitation on an Alcove site both of you can reach."
          : "This page runs on an address inside your network, so a partner outside it cannot accept. To exchange with them, create the invitation on an Alcove site both of you can reach."}
    </Alert>
  );
}

/**
 * The site a browser partner can practice on before accepting: this one, when
 * it is the hosted web app and reachable from beyond this network. A console's
 * sample data writes into the operator's own folder, so it is never offered.
 */
function practiceOriginFor(link: string): string | undefined {
  if (isConsoleBuild() || invitationReach(link) !== "anywhere")
    return undefined;
  return new URL(link).origin;
}
