import {
  ConnectionError,
  MAX_WEBRTC_FRAME_BYTES,
  QueuedMessageConnection,
  asConnectionError,
} from "@alcove/core";

import { INACTIVITY_TIMEOUT_GUIDANCE } from "../timeoutGuidance";
import { BoundedInboundFrames } from "./inboundBounds";
import {
  PeerJsFrameEncoder,
  packCloseSentinel,
  toFrameBytes,
} from "./peerjsWire";
import { openWebRtcPeerSession } from "./weriftPeer";

import type { WebRtcPeerOptions, WebRtcPeerSession } from "./weriftPeer";
import type { MessageConnection } from "@alcove/core";
import type { RTCDataChannel } from "werift";

/**
 * The CLI's WebRTC transport as a {@link MessageConnection}: the binding that
 * lets the post-handshake exchange pipeline run over a werift data channel
 * without knowing it is one. The web app's `peerMessageConnection.ts` is the
 * same mapping over a PeerJS DataConnection, and the two agree on every
 * observable: a remote close half-closes (so a final frame already queued is
 * drained before the close is reported), an error fails, and a deliberate close
 * flushes.
 *
 * Two things this side has to do differently, because it drives the raw channel
 * rather than PeerJS:
 *
 * - Framing. Outbound values are BinaryPack-packed and chunked into the
 *   envelopes a browser peer reassembles; inbound datagrams go through the
 *   bounded reassembler (`inboundBounds.ts`) before anything is delivered.
 * - Draining. Both transports wait for the peer before a clean close resolves,
 *   on the strongest signal each stack exposes: PeerJS's flushing close is just
 *   the in-band sentinel, so the web waits for the PEER to close the channel on
 *   reading it -- which SCTP ordering necessarily places behind everything
 *   already handed to `send` -- and leaves the connection standing. A CLI
 *   process cannot leave it standing, so it sends the same sentinel and waits
 *   for the peer to ACKNOWLEDGE the bytes before tearing down.
 *
 *   That wait is critical, not hygiene, and what it waits ON is the whole
 *   point: tearing the connection down while data is outstanding loses it --
 *   measured at 4 MiB handed off and zero bytes received -- and the channel's
 *   own `bufferedAmount` is not the signal that says it is safe. It reaches
 *   zero while chunks are still unacknowledged, so a close gated on it lost
 *   roughly one frame in three over a loopback channel with no packet loss at
 *   all. The condition the drain actually waits on is the SCTP association's
 *   send and unacknowledged queues both being empty (see
 *   `weriftPeer.ts`), which is the peer having the bytes. This is the
 *   final-frame loss the delivery contract in docs/COMMUNICATION.md ("Message
 *   delivery and teardown") exists to prevent.
 *
 *   Either half of a clean close then closes the data channel and waits for
 *   that close to complete; the why is on `closeChannel`.
 */

/**
 * Parked-receive inactivity budget, matching the web WebRTC transport's.
 * Hour-scale because the timer arms only while a receive waits on an empty
 * queue, so it bounds the peer's per-step single-threaded PSI compute -- which
 * sends no keepalive while it runs -- and thus the workable dataset size.
 *
 * By design a transport-local constant rather than core's file-sync
 * `DEFAULT_PEER_TIMEOUT_MS`: the two govern unrelated transports and only
 * coincide in value, so tuning one must not silently move the other.
 */
export const DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Ceiling on the clean close's outbound drain. Sized from the two facts that
 * bound it: a frame may be as large as `MAX_WEBRTC_FRAME_BYTES` (256 MiB), and
 * werift's measured loopback send path runs at a few MiB/s, so a worst-case
 * final frame needs minutes. It is a ceiling, not a wait -- the drain returns
 * the moment the buffer empties, which for a lockstep protocol's final frame is
 * normally milliseconds -- and on expiry the connection tears down anyway
 * rather than hanging an unattended run forever.
 *
 * It is the safety check rather than the usual exit against a peer that has gone:
 * werift's own consent-freshness check leaves the `connected` state about
 * thirty seconds after a peer disappears (measured), and the drain watches that
 * (see {@link drainOutbound}). The ceiling covers the remaining case -- a peer
 * that answers ICE but stops acknowledging data.
 */
export const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How often the drain re-reads the acknowledgement condition. Polled because
 * werift raises no event for it: the channel's `bufferedAmountLow` event is
 * about a different (and, for delivery, useless) counter, and `bytesSent` /
 * `messagesSent` are counted at hand-off rather than as bytes leave, so they
 * reach their final value before the drain even starts.
 */
const CLOSE_FLUSH_POLL_INTERVAL_MS = 10;

/**
 * Ceiling on getting the close sentinel itself onto the wire, once every frame
 * before it has been acknowledged. Short because the sentinel is a single small
 * chunk and the only thing waited on is its transmission, not its
 * acknowledgement -- which never arrives, since a peer closes on reading it.
 */
const SENTINEL_HANDOFF_TIMEOUT_MS = 2_000;

/**
 * Ceiling on the data channel's own close completing once this side has asked
 * for it. That close is an SCTP stream reset the peer answers, so it costs a
 * round trip -- tens of milliseconds against a browser peer on a loopback link
 * -- and this bounds a peer that stops answering rather than sizing the normal
 * case.
 */
const CHANNEL_CLOSE_TIMEOUT_MS = 2_000;

/** The send window's high and low marks: docs/spec/WEBRTC_TRANSPORT.md, Outbound pacing. */
const SEND_WINDOW_BYTES = 1024 * 1024;
const SEND_WINDOW_LOW_BYTES = 256 * 1024;

/**
 * How often a send waiting on the window re-reads the channel even without a
 * low-buffer event, so a channel that closes or a peer that goes while the
 * buffer is full ends the wait.
 */
const SEND_WINDOW_POLL_INTERVAL_MS = 250;

export interface WebRtcMessageConnectionOptions {
  inactivityTimeoutMs?: number;
  closeFlushTimeoutMs?: number;
  channelCloseTimeoutMs?: number;
  /** Outbound window bounds; tests only. */
  sendWindowBytes?: number;
  sendWindowLowBytes?: number;
  /** Per-bound overrides for the inbound reassembler; tests only. Its
   * `maxFrameBytes` is also the bound the connection states for the partner's
   * receive path (`outboundWebRtcFrameBound`), which a PSI round sizes the parts of its
   * sets to. */
  inboundBounds?: ConstructorParameters<typeof BoundedInboundFrames>[0];
}

/**
 * What a flushing close rejects with when the peer did not acknowledge every
 * frame handed over before it: the connection is torn down either way, and the
 * partner may or may not have the last frame this side sent.
 */
export class FinalFrameUnconfirmedError extends ConnectionError {
  constructor(message: string) {
    super(message, "transport");
  }
}

/** @internal */
export const FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_MESSAGE =
  "the exchange partner did not confirm receiving this side's last message " +
  "before the wait for them ran out, so their exchange may have ended " +
  "without it. Check with your partner that their exchange finished before " +
  "either of you relies on their copy.";

/** @internal */
export const FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE =
  "the connection closed before the exchange partner confirmed receiving " +
  "this side's last message, so they may or may not have received it. Check " +
  "with your partner that their exchange finished before either of you " +
  "relies on their copy.";

/**
 * Wait until `settled` holds -- or until there is no live peer left to drain
 * to, or the budget runs out -- and return whether it held.
 *
 * The liveness condition is not belt-and-braces. An acknowledgement never comes
 * from a peer that has gone, so a drain that watched only the clock would turn
 * a partner's crash into a wait as long as the ceiling. werift's
 * consent-freshness check leaves the `connected` state about thirty seconds
 * after the peer disappears -- slow, but two orders of magnitude below it.
 */
async function drainOutbound(
  channel: RTCDataChannel,
  session: Pick<WebRtcPeerSession, "isConnected">,
  settled: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (
    !settled() &&
    channel.readyState === "open" &&
    session.isConnected() &&
    Date.now() < deadline
  ) {
    // A ref'd timer: the drain IS the delivery guarantee, so it
    // must hold the event loop open rather than letting a process that has
    // finished its exchange exit with the last frame still in flight.
    await new Promise((resolve) =>
      setTimeout(resolve, CLOSE_FLUSH_POLL_INTERVAL_MS),
    );
  }
  return settled();
}

/**
 * Close the data channel and wait for that close to complete -- the peer having
 * answered the stream reset, which is what takes the channel to `closed`.
 *
 * That wait is the delivery confirmation a browser partner gives: PeerJS takes
 * its receipt from the channel closing, never from anything sent back to it,
 * and handing the sentinel to the wire is not the peer having it. Both halves
 * of a clean close wait here, the one this side asks for and the one it
 * answers; an error teardown does not, the link being unusable already.
 *
 * Returns early once the peer connection is no longer up: a peer that has gone
 * answers nothing, so waiting on it would spend the whole ceiling.
 */
async function closeChannel(
  channel: RTCDataChannel,
  session: Pick<WebRtcPeerSession, "isConnected">,
  timeoutMs: number,
): Promise<void> {
  channel.close();
  const deadline = Date.now() + timeoutMs;
  while (
    channel.readyState !== "closed" &&
    session.isConnected() &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, CLOSE_FLUSH_POLL_INTERVAL_MS),
    );
  }
}

/**
 * Wrap an open data channel as a {@link MessageConnection}. The inbound handler
 * is attached synchronously here, before anything else can run, so a frame the
 * peer sends the instant the channel opens is queued rather than dropped.
 *
 * Takes ownership of `session`: closing the connection closes the channel, the
 * peer connection and the broker socket beneath it.
 */
export function webRtcMessageConnection(
  session: WebRtcPeerSession,
  options?: WebRtcMessageConnectionOptions,
): MessageConnection {
  const { channel } = session;
  const closeFlushTimeoutMs =
    options?.closeFlushTimeoutMs ?? DEFAULT_CLOSE_FLUSH_TIMEOUT_MS;
  const channelCloseTimeoutMs =
    options?.channelCloseTimeoutMs ?? CHANNEL_CLOSE_TIMEOUT_MS;
  const sendWindowBytes = options?.sendWindowBytes ?? SEND_WINDOW_BYTES;
  const sendWindowLowBytes =
    options?.sendWindowLowBytes ?? SEND_WINDOW_LOW_BYTES;

  return new QueuedMessageConnection(
    (controls) => {
      const encoder = new PeerJsFrameEncoder();
      const bounds = new BoundedInboundFrames(options?.inboundBounds);
      let peerCloseRead = false;
      let sendStopped = false;
      let sendQueue: Promise<void> = Promise.resolve();
      const sendWake = sendWindowWake(SEND_WINDOW_POLL_INTERVAL_MS);
      const wake = sendWake.wake;
      channel.bufferedAmountLowThreshold = sendWindowLowBytes;
      channel.addEventListener("bufferedamountlow", wake);

      const sendable = (): boolean =>
        !sendStopped && channel.readyState === "open" && session.isConnected();

      const sendCut = (): ConnectionError =>
        new ConnectionError(
          "the connection to the exchange partner closed before a message " +
            "could be sent",
          "transport",
        );

      const sendFrame = async (data: unknown): Promise<void> => {
        for (const datagram of encoder.encode(data)) {
          while (channel.bufferedAmount >= sendWindowBytes) {
            if (!sendable()) throw sendCut();
            await sendWake.wait();
          }
          // werift queues a send on a channel that has left `open` without
          // complaint, so a datagram handed over then would never arrive.
          if (!sendable()) throw sendCut();
          channel.send(Buffer.from(datagram));
        }
      };

      channel.onmessage = ({ data }) => {
        let outcome;
        try {
          outcome = bounds.accept(toFrameBytes(data));
        } catch (err) {
          controls.fail(asConnectionError(err, "protocol"));
          return;
        }
        if (outcome.kind === "pending") return;
        if (outcome.kind === "close") {
          peerCloseRead = true;
          // The peer's in-band clean close. `finish` rather than `fail`: the
          // sentinel travels the same ordered channel behind every frame the
          // peer already sent, so a final frame may still be queued here and
          // must be drained before the close is reported.
          controls.finish(
            new ConnectionError("peer connection closed", "transport"),
          );
          return;
        }
        controls.deliver(outcome.value);
      };
      channel.onclose = () =>
        controls.finish(
          new ConnectionError("peer connection closed", "transport"),
        );
      channel.onerror = ({ error }) =>
        controls.fail(asConnectionError(error, "transport"));
      // A partner that vanishes -- crashed, or cut off -- closes neither the
      // channel nor the exchange, so without this the connection would sit on
      // its hour-scale inactivity budget instead of failing. `fail`, not
      // `finish`: nothing about a dropped peer is a clean close. Idempotent
      // against this side's own teardown, which reaches a terminal state before
      // it closes the peer connection.
      session.onDisconnected(() =>
        controls.fail(
          new ConnectionError(
            "the connection to the exchange partner was lost",
            "transport",
          ),
        ),
      );

      return {
        outboundWebRtcFrameBound: () =>
          options?.inboundBounds?.maxFrameBytes ?? MAX_WEBRTC_FRAME_BYTES,
        send: (data) => {
          const frame = sendQueue.then(() => sendFrame(data));
          sendQueue = frame.catch(() => {});
          return frame;
        },
        close: async (closeOptions) => {
          sendStopped = true;
          wake();
          channel.removeEventListener("bufferedamountlow", wake);
          channel.onmessage = undefined;
          channel.onclose = undefined;
          channel.onerror = undefined;
          let unconfirmed: FinalFrameUnconfirmedError | undefined;
          // Flush only an open channel: on a closed one the sentinel cannot be
          // written and there is nothing left to drain, so the wait would be
          // pure delay on a path that is already failing.
          if (closeOptions?.flush && channel.readyState === "open") {
            // Phase one: every frame already handed over reaches the peer. This
            // is the delivery guarantee, so it waits for acknowledgement and
            // gets the whole budget; a drain that ends without it is reported
            // once the teardown below has run.
            const acknowledged = await drainOutbound(
              channel,
              session,
              session.outboundAcknowledged,
              closeFlushTimeoutMs,
            );
            if (!acknowledged)
              unconfirmed = new FinalFrameUnconfirmedError(
                channel.readyState === "open" && session.isConnected()
                  ? FINAL_FRAME_UNCONFIRMED_WAIT_EXPIRED_MESSAGE
                  : FINAL_FRAME_UNCONFIRMED_LINK_LOST_MESSAGE,
              );
            try {
              channel.send(Buffer.from(packCloseSentinel()));
            } catch {
              // The channel went while the sentinel was being written; the peer
              // will see the drop instead of the clean close, and every frame
              // before it has already been acknowledged.
            }
            // Phase two: the sentinel goes on the wire. It is NOT waited on
            // for acknowledgement -- a peer closes the moment it reads the
            // sentinel, so it stops acknowledging at exactly that point and
            // this wait would always spend the whole budget. Losing the
            // sentinel costs the peer its clean-close signal (it falls back
            // to observing the connection drop), never a frame.
            await drainOutbound(
              channel,
              session,
              session.outboundTransmitted,
              SENTINEL_HANDOFF_TIMEOUT_MS,
            );
          }
          // Phase three: the channel's own close, which is the delivery
          // signal a browser partner reads (see `closeChannel`).
          const cleanClose = closeOptions?.flush === true || peerCloseRead;
          if (cleanClose && channel.readyState === "open")
            await closeChannel(channel, session, channelCloseTimeoutMs);
          await session.close();
          if (unconfirmed !== undefined) throw unconfirmed;
        },
        // No `setInboundFrameCap`: this transport bounds its inbound path with
        // its own fixed reassembly envelope rather than a per-exchange cap, so
        // the connection's setInboundFrameCap is a no-op here by construction
        // (see MessageConnection.setInboundFrameCap).
      };
    },
    {
      inactivityTimeoutMs:
        options?.inactivityTimeoutMs ?? DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS,
      inactivityHint: INACTIVITY_TIMEOUT_GUIDANCE,
    },
  );
}

/**
 * The send window's one wait: `wait` resolves on the next `wake` (the
 * channel's low-buffer event, or a close) or after `pollIntervalMs`, whichever
 * comes first, and the caller re-reads the channel.
 *
 * @internal
 */
export function sendWindowWake(pollIntervalMs: number): {
  wait: () => Promise<void>;
  wake: () => void;
} {
  let pending: (() => void) | undefined;
  return {
    wake: () => pending?.(),
    wait: () => {
      // One slot holds because the send queue runs one frame at a time.
      if (pending !== undefined)
        throw new Error(
          "a second send waited on the send window while one was waiting",
        );
      return new Promise((resolve) => {
        const poll = setTimeout(done, pollIntervalMs);
        poll.unref();
        pending = done;
        function done(): void {
          clearTimeout(poll);
          pending = undefined;
          resolve();
        }
      });
    },
  };
}

/**
 * Rendezvous with the exchange partner and return the resulting
 * {@link MessageConnection}. The single entry point a caller needs: it registers
 * with the broker, negotiates the peer connection, waits for the data channel,
 * and wraps it.
 */
export async function openWebRtcMessageConnection(
  options: WebRtcPeerOptions & WebRtcMessageConnectionOptions,
): Promise<MessageConnection> {
  const session = await openWebRtcPeerSession(options);
  return webRtcMessageConnection(session, options);
}
