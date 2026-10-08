/**
 * The browser-side reader for a console run's signed receipt: whether the
 * console has one for a job, where to download it from, and what to name the
 * saved file. The ask is independent of how the run ended, so the download is
 * never gated on a successful terminal (docs/spec/SERVER_JOB_API.md, "The
 * `GET /api/jobs/:jobId/receipt` response").
 */

import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  readBoundedJson,
} from "@psi/jobClient/jobApiBody";
import { delayUntilAborted } from "@psi/delayUntilAborted";

import { recordFileStamp } from "@alcove/core";

/** The console endpoint the receipt downloads from; the console resolves the
 * file's path inside the job's own workdir. */
function jobReceiptUrl(jobId: string): string {
  return `/api/jobs/${jobId}/receipt`;
}

/**
 * What one ask told the caller about this run's receipt. `missing` is a run
 * that asked for a receipt the console does not have; `none` is a readable
 * answer that establishes nothing; `unanswered` is an ask with no readable
 * body, which is never folded into `none` because `none` renders as nothing.
 */
export type JobReceiptOffer =
  | { kind: "available"; receiptUrl: string; receiptFileName: string }
  | { kind: "missing" }
  | { kind: "none" }
  | { kind: "unanswered" };

/**
 * The download name for the receipt, on the record downloads' stamped
 * convention (the CLI's `defaultReceiptPath`). The stamp falls back to the job
 * id where the status body reports no record, since a run can have a receipt
 * without one.
 */
function receiptFileName(jobId: string, status: JobStatusFields): string {
  const stamp =
    status.recordAvailable === true &&
    typeof status.recordCreatedAt === "string"
      ? recordFileStamp(status.recordCreatedAt)
      : jobId;
  return `alcove-receipt-${stamp}.json`;
}

/** The status-body fields this reader looks at, unknown until read. */
interface JobStatusFields {
  receiptAvailable?: unknown;
  receiptRequested?: unknown;
  recordAvailable?: unknown;
  recordCreatedAt?: unknown;
}

/**
 * Where this job's receipt stands, read off `GET /api/jobs/:jobId` in one ask.
 * Only a literal `true` on either receipt field answers; any other readable
 * body is `none`. An ask with no readable body is `unanswered`.
 */
export async function fetchJobReceiptOffer(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobReceiptOffer> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return { kind: "unanswered" };
    const body: unknown = await readBoundedJson(
      response,
      MAX_JOB_STATUS_RESPONSE_BYTES,
    );
    if (body === null || typeof body !== "object") return { kind: "none" };
    const status = body as JobStatusFields;
    if (status.receiptAvailable === true)
      return {
        kind: "available",
        receiptUrl: jobReceiptUrl(jobId),
        receiptFileName: receiptFileName(jobId, status),
      };
    return status.receiptRequested === true
      ? { kind: "missing" }
      : { kind: "none" };
  } catch {
    return { kind: "unanswered" };
  }
}

/** The gap between asks after one with no answer. */
const RECEIPT_AVAILABILITY_RETRY_MS = 2_000;

/**
 * Consecutive unanswered asks before the caller gives up on this run.
 *
 * @internal exported for the unit test, which pins where a failing route stops.
 */
export const RECEIPT_AVAILABILITY_UNANSWERED_LIMIT = 5;

/**
 * Ask the console where this job's receipt stands, re-asking only while an
 * ask has no answer: the run has already settled, so any answer is final.
 * Unanswered asks are re-asked up to
 * {@link RECEIPT_AVAILABILITY_UNANSWERED_LIMIT} times in a row before ending in
 * `unanswered`. A caller that stops the ask gets `none`.
 */
export async function askJobReceiptOffer(
  jobId: string,
  signal: AbortSignal,
  {
    fetchImpl = fetch,
    delay = delayUntilAborted,
  }: {
    fetchImpl?: typeof fetch;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<JobReceiptOffer> {
  // Read the live abort state through a call so the re-check after the ask is
  // not narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  let unanswered = 0;
  for (;;) {
    if (aborted()) return { kind: "none" };
    const offer = await fetchJobReceiptOffer(jobId, fetchImpl);
    if (offer.kind !== "unanswered") return offer;
    if (++unanswered >= RECEIPT_AVAILABILITY_UNANSWERED_LIMIT)
      return { kind: "unanswered" };
    if (aborted()) return { kind: "none" };
    await delay(RECEIPT_AVAILABILITY_RETRY_MS, signal);
  }
}
