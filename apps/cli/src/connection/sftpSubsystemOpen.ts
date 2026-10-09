// The bound on the `subsystem sftp` request after authentication, which ssh2's
// `readyTimeout` does not cover:
// docs/spec/TRANSPORT_LIVENESS.md#connect-probe-bound.

import { DEFAULT_SERVER_CONNECT_TIMEOUT_MS, TimeoutError } from "@alcove/core";

import { subsystemOpenTimeoutMessage } from "./sftpAdapterWarnings";

/**
 * The rejection this bound raises. The dial treats it as terminal, while any
 * other `TimeoutError` in a dial stays retryable; elsewhere it is an
 * availability failure (exit 69) like its base type.
 */
export class SubsystemOpenTimeoutError extends TimeoutError {
  constructor(message: string) {
    super(message);
    this.name = "SubsystemOpenTimeoutError";
  }
}

/**
 * The ssh2 `Client` members the bound subscribes to `'ready'` through.
 * Optional, as in {@link ./sftpClientInternals.Ssh2SftpClientInternals}.
 */
export interface SubsystemOpenWatchTarget {
  once?(event: "ready", listener: () => void): void;
  removeListener?(event: "ready", listener: () => void): void;
}

/**
 * The subsystem-open bound in milliseconds: the dial's `readyTimeout`, or the
 * schema default when it has no usable one.
 *
 * @param readyTimeoutMs - The dial's `readyTimeout`, as the connect options hold
 * it.
 */
export function subsystemOpenTimeoutMs(readyTimeoutMs: unknown): number {
  return typeof readyTimeoutMs === "number" &&
    Number.isFinite(readyTimeoutMs) &&
    readyTimeoutMs > 0
    ? readyTimeoutMs
    : DEFAULT_SERVER_CONNECT_TIMEOUT_MS;
}

/** A dial's armed subsystem-open bound, raced against the dial itself. */
export interface SubsystemOpenWatch {
  /**
   * Rejects with a {@link SubsystemOpenTimeoutError} once the bound has elapsed
   * since authentication; it settles no other way.
   */
  readonly expired: Promise<never>;
  /**
   * Cancel the timer and the subscription. Idempotent, and required on every
   * path: the ssh2 `Client` outlives the dial, so listeners would accumulate.
   */
  cancel(): void;
}

/**
 * Arm the subsystem-open bound on `client`, starting at ssh2's `'ready'`, the
 * event ssh2-sftp-client waits for before requesting the subsystem. Returns
 * `undefined` when the `Client` cannot be subscribed to.
 *
 * @param client - The ssh2 `Client`, as ssh2-sftp-client exposes it.
 * @param timeoutMs - The bound, from {@link subsystemOpenTimeoutMs}.
 */
export function watchSubsystemOpen(
  client: SubsystemOpenWatchTarget | undefined,
  timeoutMs: number,
): SubsystemOpenWatch | undefined {
  if (typeof client?.once !== "function") return undefined;
  const removeListener = client.removeListener;
  if (typeof removeListener !== "function") return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: ((error: Error) => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const armBound = (): void => {
    timer = setTimeout(
      () =>
        fail?.(
          new SubsystemOpenTimeoutError(subsystemOpenTimeoutMessage(timeoutMs)),
        ),
      timeoutMs,
    );
    // The live socket already holds the process open; the timer must not.
    timer.unref();
  };
  client.once("ready", armBound);
  return {
    expired,
    cancel(): void {
      clearTimeout(timer);
      removeListener.call(client, "ready", armBound);
    },
  };
}
