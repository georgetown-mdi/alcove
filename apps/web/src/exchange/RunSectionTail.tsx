import { useEffect, useRef } from "react";

import { RecurringHandoff } from "@recurring/RecurringHandoff";

import {
  AnotherExchangeFoot,
  DonePanel,
  RunDownloads,
  RunWarningsAlert,
} from "./RunSurface";
import { DiagnosticLogPanel } from "./DiagnosticLogPanel";
import { ReceiptDownload } from "./ReceiptDownload";
import { RecordDownload } from "./RecordDownload";
import { StatusPanel } from "./StatusPanel";

import type { DiscardFolder } from "./discardFolder";
import type { ExchangeRun } from "./exchangeRun";
import type { JobExchangeRecordOfferState } from "./useJobExchangeRecordOffer";
import type { RunDownloadItem } from "./RunSurface";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * The focus a run section's h1 takes. At completion the heading always takes
 * focus, so the results are read. On any other change of phase, failure, or
 * re-attachment it takes focus only when focus was orphaned onto <body> (a
 * share block, an alert, or a button that held it unmounted), so focus the
 * operator placed on a live element is not stolen. While a failure shows,
 * `FailureAlert` focuses itself. On mount nothing moves unless `focusOnMount`
 * asks for the heading, and then not over an alert already showing.
 */
export function useRunHeadingFocus({
  phase,
  failure,
  reattaching,
  reattachedRun,
  focusOnMount = false,
}: {
  phase: "share" | "running" | "done";
  failure: RunFailure | undefined;
  reattaching: boolean;
  reattachedRun: boolean;
  /** Whether the heading takes focus on mount: true where no host moves focus
   * to the incoming section. */
  focusOnMount?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (focusOnMount && failure === undefined) headingRef.current?.focus();
      return;
    }
    if (phase === "done") {
      headingRef.current?.focus();
      return;
    }
    if (failure !== undefined) return;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
    // `focusOnMount` is read on mount alone, so it is not a dependency.
  }, [phase, failure, reattaching, reattachedRun]);
  return headingRef;
}

/**
 * The results tail every run section ends with: the completion panel, the
 * run's warnings, the status panel, the downloads, the exchange record, the
 * console's receipt and log, the recurring hand-off, and the workfoot out to
 * a new exchange. The status panel keeps one stable mount through every phase
 * so its live region persists.
 *
 * A server-job run's files are on the console, so it offers no per-download
 * tracking and leaves behind the console's own confirm; a browser run passes
 * `onDownload` and the `leaveConfirm` naming the files it would leave behind.
 */
export function RunSectionTail({
  run,
  outputs,
  failure,
  warnings,
  done,
  serverJob,
  jobId,
  recordOffer,
  discardFolder,
  onDownload,
  leaveConfirm,
  onAbandon,
}: {
  run: ExchangeRun;
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
  warnings: ReadonlyArray<string>;
  done: boolean;
  /** Whether the console conducts this run rather than this browser. */
  serverJob: boolean;
  /** The console job id of a server-job run, once created. */
  jobId: string | undefined;
  recordOffer: JobExchangeRecordOfferState | undefined;
  discardFolder: DiscardFolder | undefined;
  /** Counts a browser run's download as taken; unused on a server-job run. */
  onDownload?: (item: RunDownloadItem) => void;
  /** The confirm leaving a browser run owes; unused on a server-job run. */
  leaveConfirm?: { title: string; body: string };
  onAbandon: () => void;
}) {
  // The three console-artifact panels key on the run reaching a terminal:
  // each states its artifact's standing once the run is past producing it.
  const settled = done || failure !== undefined;
  return (
    <>
      {done && <DonePanel outputs={outputs} finishedAt={run.finishedAt} />}
      <RunWarningsAlert warnings={warnings} />
      <StatusPanel run={run} done={done} halted={failure !== undefined} />
      {done && outputs !== undefined && (
        <RunDownloads
          outputs={outputs}
          heading="h2"
          onDownload={serverJob ? undefined : onDownload}
        />
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
        <RecurringHandoff jobId={jobId} collapsible={!done} />
      )}
      {(done || failure?.category === "output") && (
        <AnotherExchangeFoot
          onNavigate={onAbandon}
          confirmBeforeLeave={serverJob}
          leaveConfirm={serverJob ? undefined : leaveConfirm}
          folder={discardFolder}
        />
      )}
    </>
  );
}
