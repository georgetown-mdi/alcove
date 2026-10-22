import { ConnectionError } from "@alcove/core";

import { watchIceGathering } from "./iceGathering";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";
import type { WebRtcPathFailure } from "./relayFallback";

/**
 * Human-timescale ceiling for one operator to wait for the other party to show
 * up. Shared by both roles' browsers: the inviter's inbound wait
 * ({@link waitForIncomingConnection}) and the acceptor's dial-retry budget (the
 * `dialAsAcceptor` rendezvous), so neither side hangs the page waiting on the
 * other. It exists so an abandoned wait reports an error instead of hanging.
 *
 * It is distinct from the 30s channel-open bound in `waitForOpen.ts`, which times
 * the WebRTC handshake once both peers are already dialing.
 */
export const DEFAULT_PEER_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Raised when the wait for the other party spent its whole budget without
 * them arriving -- the no-show condition, from either role's half of the
 * shared {@link DEFAULT_PEER_WAIT_TIMEOUT_MS} budget. Not raised for a
 * partner who was reached: a channel that will not open, a fatal broker
 * error, and an operator abort each reject with a plain error instead. A
 * managed re-run uses that split to record the benign `"missed"` outcome
 * only for this error (see {@link ./managedRun.ts}, `rerunFailureLastRun`).
 */
export class PartnerNoShowError extends Error {
  /** When the wait ended, where the waiting side knows its own deadline; a
   * caller that states the time to the operator falls back to the moment the
   * error reached it. */
  readonly waitedUntil: Date | undefined;

  constructor(message: string, waitedUntil?: Date) {
    super(message);
    this.name = "PartnerNoShowError";
    this.waitedUntil = waitedUntil;
  }
}

/** PeerJS's error types for a coordination server socket that failed or
 * closed, as against an answer from the server. */
const UNREACHABLE_SIGNALING_ERROR_TYPES: ReadonlySet<unknown> = new Set([
  "network",
  "socket-error",
  "socket-closed",
]);

/**
 * Whether `err` is PeerJS's error for a coordination server socket that failed
 * or closed, as against a refusal from the server: an `ERROR`, `ID-TAKEN` or
 * `INVALID-KEY` message, or a frame over the signaling bound
 * (`./signalingBounds.ts`).
 */
export function signalingSocketFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    UNREACHABLE_SIGNALING_ERROR_TYPES.has((err as { type?: unknown }).type)
  );
}

/** What the inviter's wait fails with when the coordination server's socket
 * failed or closed ({@link signalingSocketFailed}). */
const SIGNALING_FAILED_DURING_WAIT =
  "the connection to the coordination server failed while waiting for the " +
  "other party to connect";

/** What the inviter's wait fails with when the coordination server refused
 * the peer, or the peer left it with no error before. */
const SIGNALING_ENDED_DURING_WAIT =
  "the connection to the coordination server ended while waiting for the " +
  "other party to connect";

/**
 * Resolves with the first incoming {@link DataConnection} on `peer`, or
 * rejects with a {@link PartnerNoShowError} at the deadline, with a
 * `transport`-kind {@link ConnectionError} of fixed text when the peer leaves
 * the coordination server, or with a plain abort error if `signal` aborts
 * first. No rejection holds text or fields from a PeerJS error. A settle-once
 * guard, independent of any caller's teardown, runs cleanup exactly once for
 * whichever of {connection, coordination server left, timeout, abort} wins,
 * even when two fire in the same tick.
 *
 * @param peer     The local PeerJS peer awaiting an inbound connection.
 * @param options  `timeoutMs` overrides the {@link DEFAULT_PEER_WAIT_TIMEOUT_MS}
 *                 bound; `until` sets the deadline itself instead, for a caller
 *                 that shows the operator the time the wait ends, and is the
 *                 `waitedUntil` the no-show error states; `signal` lets the
 *                 owner cancel the wait (on unmount or a sibling teardown)
 *                 and settle it promptly rather than leaving the promise
 *                 pending until the timer fires; `onPathFailed` takes the
 *                 coordination server's socket failing or closing as a path
 *                 failure, before the wait rejects. A refusal from the server
 *                 ends the wait with no path failure.
 */
export function waitForIncomingConnection(
  peer: Peer,
  options?: {
    signal?: AbortSignal;
    onPathFailed?: (failure: WebRtcPathFailure) => void;
  } & (
    { timeoutMs?: number; until?: never } | { until: Date; timeoutMs?: never }
  ),
): Promise<DataConnection> {
  const signal = options?.signal;
  const onPathFailed = options?.onPathFailed;
  const waitedUntil =
    options?.until ??
    new Date(Date.now() + (options?.timeoutMs ?? DEFAULT_PEER_WAIT_TIMEOUT_MS));
  const timeoutMs = Math.max(0, waitedUntil.getTime() - Date.now());
  return new Promise<DataConnection>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      peer.off("connection", onConnection);
      peer.off("error", onPeerError);
      peer.off("disconnected", onDisconnected);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    // Watched in the tick PeerJS hands the connection out, before it gathers
    // (see ./iceGathering.ts).
    const onConnection = (conn: DataConnection) => {
      watchIceGathering(conn);
      settle(() => resolve(conn));
    };
    // Only the type of the last error the peer emitted before `disconnected`
    // is read: PeerJS builds a server-error from the server's ERROR frame,
    // fields included (test/browser/relayFallback.test.ts drives the real one).
    let lastPeerError: unknown;
    const onPeerError = (err: unknown) => {
      lastPeerError = err;
    };
    // A PeerJS peer does not register again once its socket has gone, so no
    // partner's connection can reach this wait after it. Only a socket that
    // failed or closed is a path failure; a refusal from the server, or a
    // disconnect no error explains, fails the run
    // (docs/spec/WEBRTC_TRANSPORT.md, What sends the start). The failure is
    // built before `settle`, which disarms the deadline and the abort.
    const onDisconnected = () => {
      const socketFailed = signalingSocketFailed(lastPeerError);
      const failure = new ConnectionError(
        socketFailed
          ? SIGNALING_FAILED_DURING_WAIT
          : SIGNALING_ENDED_DURING_WAIT,
        "transport",
      );
      if (socketFailed) onPathFailed?.("signaling-unreachable");
      settle(() => reject(failure));
    };
    const onAbort = () =>
      settle(() =>
        reject(new Error("waiting for the other party to connect was aborted")),
      );
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new PartnerNoShowError(
              "timed out waiting for the other party to connect",
              waitedUntil,
            ),
          ),
        ),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    peer.once("connection", onConnection);
    peer.on("error", onPeerError);
    peer.on("disconnected", onDisconnected);
    signal?.addEventListener("abort", onAbort);
  });
}
