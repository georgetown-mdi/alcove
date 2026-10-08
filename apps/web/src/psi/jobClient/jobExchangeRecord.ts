/**
 * The browser-side reader for a console run's self-attested exchange record:
 * whether the console has one for a job, how the run that wrote it ended,
 * where to download the pair from, and what to name the saved files. The
 * console is the authority, so a terminated run that disclosed still offers
 * its record (docs/spec/SERVER_JOB_API.md, "The `GET /api/jobs/:jobId` status
 * body"; docs/spec/EXCHANGE_RECORD.md, "When a record is owed").
 */

import { EXCHANGE_RECORD_OUTCOMES, recordFileStamp } from "@alcove/core";

import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  readBoundedJson,
} from "@psi/jobClient/jobApiBody";
import { delayUntilAborted } from "@psi/delayUntilAborted";

import type { ExchangeRecordOutcome } from "@alcove/core";
import type { RecordDownloads } from "../exchangeLifecycle";
import type { RecordUnavailableReason } from "@jobContract/recordUnavailableReason";

/** The console endpoint the shareable record downloads from; the console
 * resolves the file's path inside the job's own workdir. */
function jobRecordUrl(jobId: string): string {
  return `/api/jobs/${jobId}/record`;
}

/** The console endpoint the private verification keys download from, paired
 * with {@link jobRecordUrl}. */
function jobKeysUrl(jobId: string): string {
  return `/api/jobs/${jobId}/keys`;
}

/** The record pair's download hrefs and save names, stamped from the record's
 * own `createdAt` as the in-browser path ({@link @psi/runOutputs}) stamps its
 * files. */
export function jobRecordDownloads(
  jobId: string,
  createdAt: string,
): RecordDownloads {
  const stamp = recordFileStamp(createdAt);
  return {
    recordUrl: jobRecordUrl(jobId),
    recordFileName: `alcove-record-${stamp}.json`,
    keysUrl: jobKeysUrl(jobId),
    keysFileName: `alcove-record-${stamp}.keys.json`,
  };
}

/**
 * What one ask told the caller about this run's exchange record. `none` is
 * the console holding no record, which renders as nothing. `undescribable` is
 * a record on disk the console cannot offer, so the controls that destroy the
 * workdir confirm first. `unanswered` is an ask with no readable answer, never
 * folded into `none`.
 */
export type JobExchangeRecordOffer =
  | {
      kind: "available";
      outcome: ExchangeRecordOutcome;
      /** Whether the record states that the certificate the partner presented
       * is not the pinned identity; only a literal `true` does. */
      recordCertificateMismatchObserved: boolean;
      downloads: RecordDownloads;
    }
  | { kind: "undescribable" }
  | { kind: "none" }
  | { kind: "unanswered" };

/** What one ask answered: an offer, or `not-settled` while the run's child has
 * not exited, which {@link askJobExchangeRecordOffer} re-asks. */
export type JobExchangeRecordAnswer =
  JobExchangeRecordOffer | { kind: "not-settled" };

/** The status-body fields this reader looks at, unknown until read. */
interface JobStatusFields {
  recordAvailable?: unknown;
  recordCreatedAt?: unknown;
  recordOutcome?: unknown;
  recordCertificateMismatchObserved?: unknown;
  recordUnavailableReason?: unknown;
}

/** The answer for each reason the console can give for withholding the pair.
 * A total map, so a new reason fails to compile here until classified. */
const OFFER_FOR_UNAVAILABLE_REASON: Record<
  RecordUnavailableReason,
  JobExchangeRecordAnswer
> = {
  "not-settled": { kind: "not-settled" },
  "no-record": { kind: "none" },
  "undescribable-record": { kind: "undescribable" },
};

/** The answer a body denying availability leaves. An absent reason is an older
 * console's plain denial; an unrecognized one is `unanswered`, never `none`,
 * since `none` licenses destroying the run's workdir. */
function offerForUnavailableRecord(reason: unknown): JobExchangeRecordAnswer {
  if (reason === undefined) return { kind: "none" };
  for (const [known, offer] of Object.entries(OFFER_FOR_UNAVAILABLE_REASON))
    if (reason === known) return offer;
  return { kind: "unanswered" };
}

/** The status body's `recordOutcome`, when it is one the record format
 * admits. */
function recordOutcomeOf(value: unknown): ExchangeRecordOutcome | undefined {
  return EXCHANGE_RECORD_OUTCOMES.find((outcome) => outcome === value);
}

/**
 * Where this job's record stands, read off `GET /api/jobs/:jobId` in one ask.
 * A denial is read from `recordUnavailableReason`. A body asserting
 * `recordAvailable: true` without a string `recordCreatedAt` and a known
 * `recordOutcome` is `unanswered`, never `none`, as is an ask with no readable
 * body.
 */
export async function fetchJobExchangeRecordOffer(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobExchangeRecordAnswer> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return { kind: "unanswered" };
    const body: unknown = await readBoundedJson(
      response,
      MAX_JOB_STATUS_RESPONSE_BYTES,
    );
    if (body === null || typeof body !== "object") return { kind: "none" };
    const status = body as JobStatusFields;
    if (status.recordAvailable !== true)
      return offerForUnavailableRecord(status.recordUnavailableReason);
    const outcome = recordOutcomeOf(status.recordOutcome);
    if (typeof status.recordCreatedAt !== "string" || outcome === undefined)
      return { kind: "unanswered" };
    return {
      kind: "available",
      outcome,
      recordCertificateMismatchObserved:
        status.recordCertificateMismatchObserved === true,
      downloads: jobRecordDownloads(jobId, status.recordCreatedAt),
    };
  } catch {
    return { kind: "unanswered" };
  }
}

/** The gap between asks while the run is unsettled or an ask had no answer. */
const RECORD_AVAILABILITY_RETRY_MS = 2_000;

/**
 * Consecutive unanswered asks before the caller gives up on this run.
 *
 * @internal exported for the unit test, which pins where a failing route stops.
 */
export const RECORD_AVAILABILITY_UNANSWERED_LIMIT = 5;

/**
 * Ask the console where this job's record stands, once the caller has seen the
 * run's terminal event. `not-settled` is re-asked without bound, since a
 * failing run emits its terminal before its child exits; `unanswered` is
 * re-asked up to {@link RECORD_AVAILABILITY_UNANSWERED_LIMIT} times in a row.
 * Any other answer is final. A caller that stops the ask gets `none`.
 */
export async function askJobExchangeRecordOffer(
  jobId: string,
  signal: AbortSignal,
  {
    fetchImpl = fetch,
    delay = delayUntilAborted,
  }: {
    fetchImpl?: typeof fetch;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<JobExchangeRecordOffer> {
  // Read the live abort state through a call so the re-check after the ask is not
  // narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  let unanswered = 0;
  for (;;) {
    if (aborted()) return { kind: "none" };
    const offer = await fetchJobExchangeRecordOffer(jobId, fetchImpl);
    if (offer.kind === "not-settled") unanswered = 0;
    else if (offer.kind !== "unanswered") return offer;
    else if (++unanswered >= RECORD_AVAILABILITY_UNANSWERED_LIMIT)
      return { kind: "unanswered" };
    if (aborted()) return { kind: "none" };
    await delay(RECORD_AVAILABILITY_RETRY_MS, signal);
  }
}
