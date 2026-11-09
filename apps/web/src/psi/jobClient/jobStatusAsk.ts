/**
 * The one status read and the one bounded re-ask the console job readers
 * share: the receipt ({@link ./jobReceipt}), the exchange record
 * ({@link ./jobExchangeRecord}) and the diagnostic log
 * ({@link ./jobDiagnosticLog}). Each reader keeps its own classification of
 * the status body's fields.
 */

import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  isRecord,
  readBoundedJson,
} from "@psi/jobClient/jobApiBody";

/** How a reader folds one ask of `GET /api/jobs/:jobId` into its answer. */
export interface JobStatusFold<TAnswer> {
  /** The answer to an ask with no readable body: a failed or refused request,
   * or a body over the cap or not JSON. */
  unanswered: TAnswer;
  /** The answer to a readable body that is not a JSON object. */
  notAnObject: TAnswer;
  /** The answer a status object gives, its fields unknown until read. */
  read: (status: Record<string, unknown>) => TAnswer;
}

/** Ask the console for this job's status body once, folded by `fold`. */
export async function readJobStatusBody<TAnswer>(
  jobId: string,
  fetchImpl: typeof fetch,
  fold: JobStatusFold<TAnswer>,
): Promise<TAnswer> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}`, { method: "GET" });
    if (!response.ok) return fold.unanswered;
    const body = await readBoundedJson(response, MAX_JOB_STATUS_RESPONSE_BYTES);
    return isRecord(body) ? fold.read(body) : fold.notAnObject;
  } catch {
    return fold.unanswered;
  }
}

/** What one answer does to the asking: ends it with `end`, asks again with
 * the unanswered count reset, or counts as unanswered. */
export type AskStep<TResult> = { end: TResult } | "reask" | "unanswered";

/** What {@link askUntilAnswered} asks, and how it ends. */
export interface AskUntilAnsweredOptions<TAnswer, TResult> {
  ask: () => Promise<TAnswer>;
  step: (answer: TAnswer) => AskStep<TResult>;
  /** The result once the caller stops the asking. */
  stopped: TResult;
  /** The result after `unansweredLimit` unanswered asks in a row. */
  gaveUp: TResult;
  unansweredLimit: number;
  retryMs: number;
  signal: AbortSignal;
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Ask until an answer ends the asking, the caller aborts `signal`, or
 * `unansweredLimit` asks in a row go unanswered, waiting `retryMs` between
 * asks.
 */
export async function askUntilAnswered<TAnswer, TResult>(
  options: AskUntilAnsweredOptions<TAnswer, TResult>,
): Promise<TResult> {
  const { signal } = options;
  // Read the live abort state through a call so the re-check after the ask is
  // not narrowed to a constant by the first guard.
  const aborted = () => signal.aborted;
  let unanswered = 0;
  for (;;) {
    if (aborted()) return options.stopped;
    const step = options.step(await options.ask());
    if (step === "reask") unanswered = 0;
    else if (step !== "unanswered") return step.end;
    else if (++unanswered >= options.unansweredLimit) return options.gaveUp;
    if (aborted()) return options.stopped;
    await options.delay(options.retryMs, signal);
  }
}
