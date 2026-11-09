/** Turn a worker `onerror` / `onmessageerror` event into an Error. The event is a
 * browser ErrorEvent whose `message` names the fault; fall back to `fallbackMessage`
 * when it has none. */
export function errorFromWorkerEvent(
  event: unknown,
  fallbackMessage: string,
): Error {
  const message =
    typeof event === "object" &&
    event !== null &&
    typeof (event as { message?: unknown }).message === "string"
      ? (event as { message: string }).message
      : fallbackMessage;
  return new Error(message);
}

/** The failure events of the slice of the `Worker` API a controller drives. */
export interface WorkerFailureEvents {
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
}

/** Which of a worker's failure events fired. */
export type WorkerFailureSource = "error" | "messageerror";

/**
 * Route both of `worker`'s failure events to `onFail`: `onerror`, a fault in
 * the worker, and `onmessageerror`, a reply that fails to deserialize on this
 * thread. That reply fires neither `onmessage` nor `onerror`, so a controller
 * with no handler for it leaves its pending call unsettled.
 */
export function attachWorkerFailure(
  worker: WorkerFailureEvents,
  onFail: (event: unknown, source: WorkerFailureSource) => void,
): void {
  worker.onerror = (event) => onFail(event, "error");
  worker.onmessageerror = (event) => onFail(event, "messageerror");
}
