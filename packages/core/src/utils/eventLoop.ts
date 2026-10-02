/** Resolves on a later turn of the event loop, after waiting timers and I/O. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The longest a paced loop holds its thread between two yields. An arbitrary
 * working value: short against the seconds a transport's liveness check
 * allows an answer, long against the cost of a yield.
 */
export const EVENT_LOOP_HOLD_MS = 50;

/**
 * How many records a paced loop takes between two readings of the clock: few
 * enough that a stretch of them stays well inside {@link EVENT_LOOP_HOLD_MS}.
 */
export const PACED_STRETCH_RECORDS = 1024;

/**
 * Paces a loop over records so its thread's event loop runs while it does. A
 * transport on the same thread answers its partner's liveness checks only
 * from the event loop, so a loop that holds the thread for the whole of a
 * large input ends the connection (docs/spec/DEPENDENCY_PINS.md, The
 * behavioural assumptions).
 */
export class EventLoopPacer {
  private lastYieldAt = performance.now();

  /**
   * Yields to the event loop once {@link EVENT_LOOP_HOLD_MS} have passed since
   * the last yield, and returns at once otherwise. Reads the clock on every
   * call, so a loop calls it once in a stretch of records.
   */
  async yieldWhenDue(): Promise<void> {
    if (performance.now() - this.lastYieldAt < EVENT_LOOP_HOLD_MS) return;
    await yieldToEventLoop();
    this.lastYieldAt = performance.now();
  }
}

/**
 * A computation over records written once for both a caller that must not
 * hold its thread and one that runs it in a single stretch: it yields once in
 * every {@link PACED_STRETCH_RECORDS} records and returns its result.
 */
export type PaceableSteps<T> = Generator<void, T>;

/** Runs `steps` to their result in one stretch. */
export function runUnpaced<T>(steps: PaceableSteps<T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Runs `steps` to their result, yielding to the event loop as `pacer` says. */
export async function runPaced<T>(
  steps: PaceableSteps<T>,
  pacer: EventLoopPacer,
): Promise<T> {
  let step = steps.next();
  while (!step.done) {
    await pacer.yieldWhenDue();
    step = steps.next();
  }
  return step.value;
}
