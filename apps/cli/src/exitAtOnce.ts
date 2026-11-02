// The one way a signal handler that is waiting before it exits lets a repeated
// signal end the wait: the PSI worker stop (psiWorkerHost.ts) and the
// file-channel teardown (protocol.ts) both offer it.

/** The signals whose repeat ends a wait before exit at once. */
export type ExitSignal = "SIGINT" | "SIGTERM";

const EXIT_SIGNALS: readonly ExitSignal[] = ["SIGINT", "SIGTERM"];

/** How a signal handler reports a wait before exit and ends it at once. */
export interface ExitWaitOptions {
  announce: (line: string) => void;
  exitAtOnce: (signal: ExitSignal) => void;
}

let exitAtOnceListeners: Map<ExitSignal, () => void> | undefined;
const announced = new Set<string>();

/**
 * Print `notice` through `announce`, once until {@link withdrawExitAtOnce},
 * and from then on call `exitAtOnce` on a further SIGINT or SIGTERM. Two
 * waits may each announce their own notice; the listeners are installed once.
 */
export function offerExitAtOnce(
  notice: string,
  options: ExitWaitOptions,
): void {
  if (!announced.has(notice)) {
    announced.add(notice);
    options.announce(notice);
  }
  if (exitAtOnceListeners !== undefined) return;
  exitAtOnceListeners = new Map();
  for (const signal of EXIT_SIGNALS) {
    const listener = (): void => {
      options.exitAtOnce(signal);
    };
    exitAtOnceListeners.set(signal, listener);
    // Ahead of the exchange's own handler, which would otherwise print its
    // interrupt lines again before this exit.
    process.prependListener(signal, listener);
  }
}

/** Remove what {@link offerExitAtOnce} installed, and forget its notices. */
export function withdrawExitAtOnce(): void {
  announced.clear();
  if (exitAtOnceListeners === undefined) return;
  for (const [signal, listener] of exitAtOnceListeners)
    process.off(signal, listener);
  exitAtOnceListeners = undefined;
}
