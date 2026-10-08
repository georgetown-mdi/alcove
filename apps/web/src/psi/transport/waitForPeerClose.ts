import type { DataConnection } from "peerjs";

/**
 * Default ceiling on the wait for the peer to take the final frame, sized like
 * the CLI's `DEFAULT_CLOSE_FLUSH_TIMEOUT_MS`: a 256 MiB frame
 * (`MAX_WEBRTC_FRAME_BYTES`) needs minutes on a slow link.
 */
export const DEFAULT_PEER_CLOSE_TIMEOUT_MS = 5 * 60 * 1000;

/** Peer-connection states with nothing live left to deliver over.
 * `disconnected` is absent: it can recover, and a peer that never comes back
 * reaches `failed`. */
const DEAD_PEER_STATES: ReadonlySet<RTCPeerConnectionState> = new Set([
  "failed",
  "closed",
]);

/**
 * How the wait for the peer's close ended. Only `peer-closed` is a delivery
 * signal (docs/spec/WEBRTC_TRANSPORT.md, "The clean close").
 */
export type PeerCloseOutcome =
  /** The peer closed the channel, so it read every frame ahead of the close
   * sentinel. */
  | "peer-closed"
  /** The ceiling ran out with the peer still live; the final frame may still
   * be in this side's outbound buffer. */
  | "ceiling"
  /** The peer connection reached `failed` or `closed`, or the channel closed
   * on a dead link with no peer close read. */
  | "peer-gone"
  /** The channel was not open when the wait began. */
  | "channel-not-open"
  /** The caller's signal aborted; no delivery signal. */
  | "run-aborted";

/** The WebRTC objects under a PeerJS connection. PeerJS types both as always
 * present, but a connection that never negotiated has neither. */
function transportOf(conn: DataConnection): {
  channel: RTCDataChannel | undefined;
  peerConnection: RTCPeerConnection | undefined;
} {
  return { channel: conn.dataChannel, peerConnection: conn.peerConnection };
}

/**
 * Whether PeerJS has already ended this connection, which it does on reading
 * the peer's close sentinel and on its own cleanup paths; the flushing close
 * leaves `open` set. A dead link with `open` still true is an end that
 * bypassed PeerJS: this side's own peer-connection teardown. Pinned in
 * apps/web/test/browser/webrtcCloseDelivery.test.ts.
 */
function peerCloseAlreadyRead(conn: DataConnection): boolean {
  return !conn.open;
}

/**
 * Resolves with how the wait for the peer to close the data channel under
 * `conn` ended ({@link PeerCloseOutcome}); never rejects. PeerJS's flushing
 * close only queues its sentinel, so the peer's close is the delivery signal
 * (docs/spec/WEBRTC_TRANSPORT.md, "The clean close").
 *
 * Call this before asking PeerJS to close, so a peer that closes at once
 * cannot beat the listener into place.
 *
 * @param conn       The connection about to be closed; its channel and peer
 *                   connection are read now, before PeerJS can detach them.
 * @param timeoutMs  Ceiling on the wait.
 * @param signal     The run's signal; an abort, already set or later, ends the
 *                   wait with `run-aborted`.
 */
export function waitForPeerClose(
  conn: DataConnection,
  timeoutMs: number = DEFAULT_PEER_CLOSE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<PeerCloseOutcome> {
  if (signal?.aborted) return Promise.resolve("run-aborted");
  const { channel, peerConnection } = transportOf(conn);
  if (channel === undefined || channel.readyState !== "open")
    return Promise.resolve("channel-not-open");
  return new Promise<PeerCloseOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: PeerCloseOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeEventListener("close", onChannelClose);
      channel.removeEventListener("closing", onChannelClosing);
      peerConnection?.removeEventListener(
        "connectionstatechange",
        onPeerConnectionState,
      );
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const noLivePeerConnection = () =>
      peerConnection !== undefined &&
      DEAD_PEER_STATES.has(peerConnection.connectionState);
    const onChannelClosing = () => {
      // Tearing this side's own peer connection down also closes the
      // channel; only a dead link with no peer close read is that teardown.
      settle(
        noLivePeerConnection() && !peerCloseAlreadyRead(conn)
          ? "peer-gone"
          : "peer-closed",
      );
    };
    const onChannelClose = () => {
      // For a stack that never enters `closing`. After a completed close a
      // dead link no longer tells a teardown from the peer's close.
      settle("peer-closed");
    };
    const onAbort = () => {
      settle("run-aborted");
    };
    const onPeerConnectionState = () => {
      if (noLivePeerConnection()) settle("peer-gone");
    };
    const timer = setTimeout(() => {
      settle("ceiling");
    }, timeoutMs);
    channel.addEventListener("close", onChannelClose);
    channel.addEventListener("closing", onChannelClosing);
    peerConnection?.addEventListener(
      "connectionstatechange",
      onPeerConnectionState,
    );
    signal?.addEventListener("abort", onAbort);
    // The peer may already have gone while this side was still sending.
    onPeerConnectionState();
  });
}
