import { Readable } from "node:stream";

import {
  redactAndSanitizeForDisplay,
  TransportOperationStalledError,
} from "@alcove/core";

import { fittedCauseLink } from "./causeLink";

/**
 * Per-operation liveness bounds for the SFTP adapter's server-driven
 * operations, each failing with a terminal
 * {@link TransportOperationStalledError}, and the non-fatal slow-operation
 * warning
 * (docs/spec/TRANSPORT_LIVENESS.md#per-operation-liveness-bounds,
 * docs/spec/TRANSPORT_LIVENESS.md#slow-operation-warning).
 */

/**
 * How long, in milliseconds, an SFTP operation may wait on the server before it
 * is judged stalled: a whole-operation deadline or a progress idle window,
 * depending on the operation. Fixed, not operator-configurable.
 */
export const SFTP_STALL_DEADLINE_MS = 60_000;

/**
 * The terminal error for an SFTP operation that made no progress within its
 * bound. `path` and `serverReported` are peer-controlled and unbounded, so each
 * gets its own cause link and cannot crowd out the first-party text.
 */
export function transportOperationStalledError(
  operation: string,
  path: string,
  detail: string,
  serverReported?: string,
): TransportOperationStalledError {
  return new TransportOperationStalledError(
    `SFTP ${operation} stalled; refusing to wait on the server further`,
    {
      details: [
        fittedCauseLink(`how the ${operation} stalled: `, detail),
        // eslint-disable-next-line no-restricted-syntax -- the path joins the operator's configured directory to a peer-chosen name, and an offline accept seeds the directory from the invitation, so it keeps the escape.
        fittedCauseLink(`stalled ${operation} path: `, path),
        ...(serverReported === undefined
          ? []
          : [fittedCauseLink("error the server reported: ", serverReported)]),
      ],
    },
  );
}

/**
 * Race `promise` against a deadline of `ms`, rejecting with `makeError()` on
 * expiry. It only races: the operation may still settle afterwards, and a
 * handle it holds is not reclaimed here, so an operation holding a reusable
 * handle ({@link ./ssh2SftpAdapter}'s `list()`) closes it on its own failure
 * path.
 */
export function withSftpOperationDeadline<T>(
  promise: Promise<T>,
  ms: number,
  makeError: () => TransportOperationStalledError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
    timer.unref();
  });
  // A late rejection of the losing `promise` must not go unhandled.
  const settled = promise.finally(() => clearTimeout(timer));
  void settled.catch(() => {});
  return Promise.race([settled, deadline]);
}

/**
 * Chunk size, in bytes, of the bounded `put` source. ssh2 calls back a write
 * stream write only once every packet of it is acked, so one whole-payload
 * write would show no progress until it finished; 64 KiB chunks let a
 * ~1 KiB/s upload progress within the idle window.
 */
export const SFTP_PUT_PROGRESS_CHUNK_BYTES = 64 * 1024;

/** The bounded `put` source returned by {@link createBoundedPutSource}. */
export interface BoundedPutSource {
  /** The chunked {@link Readable} for ssh2-sftp-client's `put(source, dest)`. */
  source: Readable;
  /**
   * Resolves with the `put()` value on {@link BoundedPutSource.complete}, or
   * rejects with a {@link TransportOperationStalledError} once the upload makes
   * no progress for the idle window.
   */
  result: Promise<unknown>;
  /**
   * Mark the underlying `put()` resolved; resolves `result` with its value unless
   * the idle window already fired (then a no-op).
   */
  complete: (value: unknown) => void;
  /**
   * Mark the underlying `put()` rejected; rejects `result` with `err` unless it has
   * already settled (idle window fired or completed).
   */
  fail: (err: unknown) => void;
}

/**
 * Build a chunked source that bounds an outbound SFTP `put` by progress rather
 * than total time, the write-side counterpart of
 * {@link ./frameSizeGuard.createCappedSink}. The parts of `payload` are emitted
 * as zero-copy views. Write acks pace the pulls, so the idle timer, reset on
 * each chunk and at end of file, fires when the server withholds them.
 * Single-use: build a fresh one per retry.
 */
export function createBoundedPutSource(
  path: string,
  payload: Buffer | readonly Uint8Array[],
  chunkBytes: number = SFTP_PUT_PROGRESS_CHUNK_BYTES,
  stallDeadlineMs: number = SFTP_STALL_DEADLINE_MS,
): BoundedPutSource {
  const parts: readonly Uint8Array[] = Buffer.isBuffer(payload)
    ? [payload]
    : payload;
  // Buffer.from(view) would copy the bytes.
  const asBuffer = (view: Uint8Array): Buffer =>
    Buffer.isBuffer(view)
      ? view
      : Buffer.from(
          view.buffer as ArrayBuffer,
          view.byteOffset,
          view.byteLength,
        );
  let settled = false;
  let partIndex = 0;
  let offset = 0;
  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (err: unknown) => void;
  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectResult(
        transportOperationStalledError(
          "file write",
          path,
          `made no upload progress for ${stallDeadlineMs} ms (the server ` +
            `withheld write acknowledgement)`,
        ),
      );
      // Destroy with an error, not bare: ssh2-sftp-client tears the write
      // stream down at the server only on the source's 'error' (see
      // createCappedSink).
      source.destroy(new Error("outbound transfer stalled"));
    }, stallDeadlineMs);
    idleTimer.unref();
  };

  const source = new Readable({
    highWaterMark: chunkBytes,
    read() {
      if (settled) return;
      // Skip empty parts first, so trailing empty parts still reach EOF.
      while (partIndex < parts.length && offset >= parts[partIndex].length) {
        partIndex += 1;
        offset = 0;
      }
      if (partIndex >= parts.length) {
        armIdle();
        this.push(null);
        return;
      }
      const part = parts[partIndex];
      const end = Math.min(offset + chunkBytes, part.length);
      const chunk = asBuffer(part.subarray(offset, end));
      offset = end;
      armIdle();
      this.push(chunk);
    },
  });

  // Absorb the stall destroy's 'error' whether or not ssh2-sftp-client has
  // attached its own handler yet; the outcome is already on `result`.
  source.on("error", () => {});

  // Armed before the first pull, so a server that acks no write is bounded.
  armIdle();

  return {
    source,
    result,
    complete: (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      resolveResult(value);
      // ssh2-sftp-client does not destroy a caller-provided source on a write
      // error, so every terminal path does; a bare destroy() is idempotent.
      source.destroy();
    },
    fail: (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      rejectResult(err);
      source.destroy();
    },
  };
}

/**
 * Elapsed time, in milliseconds, after which {@link withSlowOperationWarning}
 * warns; below {@link SFTP_STALL_DEADLINE_MS} so a stalled read warns once
 * before it fails.
 */
export const SFTP_SLOW_OPERATION_WARNING_MS = 30_000;

/**
 * If `promise` has not settled within `thresholdMs`, log one warning naming the
 * operation, the elapsed time and any `progress(elapsedMs)`. Never alters the
 * result; the stall bounds are what fail an operation.
 */
export function withSlowOperationWarning<T>(
  promise: Promise<T>,
  options: {
    operation: string;
    path: string;
    log: { warn: (message: string) => void };
    thresholdMs?: number;
    progress?: (elapsedMs: number) => string;
  },
): Promise<T> {
  const thresholdMs = options.thresholdMs ?? SFTP_SLOW_OPERATION_WARNING_MS;
  const start = Date.now();
  const timer = setTimeout(() => {
    // Measured, not thresholdMs: a late timer would inflate get()'s rate.
    const elapsedMs = Date.now() - start;
    const observed = options.progress?.(elapsedMs);
    // `path` may be a peer-supplied filename.
    options.log.warn(
      `SFTP ${options.operation} of ${redactAndSanitizeForDisplay(options.path)} is ` +
        `still running after ` +
        `${elapsedMs} ms${observed ? ` (${observed})` : ""}; this may be a ` +
        "slow transfer or an unresponsive server",
    );
  }, thresholdMs);
  timer.unref();
  return promise.finally(() => clearTimeout(timer));
}
