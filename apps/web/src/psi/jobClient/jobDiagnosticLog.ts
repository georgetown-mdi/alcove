/**
 * The browser-side reader for a diagnostic run's captured log: whether the
 * console has one for a job, and where to download it from. The console is
 * the authority on both, so a re-attached run can still offer the log
 * (docs/spec/SERVER_JOB_API.md, "The `GET /api/jobs/:jobId` status body").
 */

import {
  askUntilAnswered,
  readJobStatusBody,
} from "@psi/jobClient/jobStatusAsk";
import { delayUntilAborted } from "@psi/delayUntilAborted";

/** The console endpoint the log downloads from; the console resolves the
 * file's path inside the job's own workdir. */
export function jobDiagnosticLogUrl(jobId: string): string {
  return `/api/jobs/${jobId}/log`;
}

/** The download name for the log, stamped with the job id. */
export function jobDiagnosticLogFileName(jobId: string): string {
  return `alcove-run-${jobId}.log`;
}

/**
 * What one ask told the caller. `unanswered` is an ask with no answer about
 * the log at all (a rejected request, a forgotten job, a lost connection, a
 * body that is not the status body); it is neither `none` nor `pending`.
 */
type JobDiagnosticLogState = "none" | "pending" | "available" | "unanswered";

/**
 * Where this job's diagnostic log stands, read off `GET /api/jobs/:jobId`.
 * `logAvailable` false alone does not separate a log that is coming from one
 * that never was; `logRequested` does.
 */
export function fetchJobLogState(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobDiagnosticLogState> {
  return readJobStatusBody<JobDiagnosticLogState>(jobId, fetchImpl, {
    unanswered: "unanswered",
    notAnObject: "unanswered",
    read: (status: { logAvailable?: unknown; logRequested?: unknown }) => {
      if (status.logAvailable === true) return "available";
      if (status.logRequested === false) return "none";
      return status.logRequested === true ? "pending" : "unanswered";
    },
  });
}

/** The gap between availability asks while a run is in progress. */
const LOG_AVAILABILITY_RETRY_MS = 2_000;

/**
 * Consecutive unanswered asks before a watch gives up on this run.
 *
 * @internal exported for the unit test, which pins where a failing route stops.
 */
export const LOG_AVAILABILITY_UNANSWERED_LIMIT = 5;

/**
 * How a watch ended: `available` once the console has the log, `unavailable`
 * when it said this run has none (or the caller stopped the watch first), and
 * `unanswered` when it stopped answering about this run, which the caller
 * tells the operator.
 */
type JobDiagnosticLogWatchOutcome = "available" | "unavailable" | "unanswered";

/**
 * Ask the console where this job's log stands until it answers for good, the
 * caller aborts, or it stops answering. The console returns the job id without
 * waiting for the log file, so a single ask at start races the file.
 *
 * `none` ends the watch at once. `pending` is re-asked while the run is
 * unsettled and ends it once `settled` is set. `unanswered` is re-asked up to
 * {@link LOG_AVAILABILITY_UNANSWERED_LIMIT} times in a row; any answered ask
 * resets the count.
 */
export async function watchJobDiagnosticLog(
  jobId: string,
  signal: AbortSignal,
  {
    settled = false,
    fetchImpl = fetch,
    delay = delayUntilAborted,
  }: {
    /** Whether the run has reached a terminal state. */
    settled?: boolean;
    fetchImpl?: typeof fetch;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<JobDiagnosticLogWatchOutcome> {
  return askUntilAnswered<JobDiagnosticLogState, JobDiagnosticLogWatchOutcome>({
    ask: () => fetchJobLogState(jobId, fetchImpl),
    step: (state) => {
      if (state === "available") return { end: "available" };
      if (state === "none") return { end: "unavailable" };
      if (state === "pending")
        return settled ? { end: "unavailable" } : "reask";
      return "unanswered";
    },
    stopped: "unavailable",
    gaveUp: "unanswered",
    unansweredLimit: LOG_AVAILABILITY_UNANSWERED_LIMIT,
    retryMs: LOG_AVAILABILITY_RETRY_MS,
    signal,
    delay,
  });
}
