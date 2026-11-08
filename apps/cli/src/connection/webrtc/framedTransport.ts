import {
  BoundedInboundFrames,
  ConnectionError,
  PeerJsFrameEncoder,
  asConnectionError,
  toFrameBytes,
} from "@alcove/core";

import type { QueuedMessageConnection } from "@alcove/core";

type TransportControls = Parameters<
  ConstructorParameters<typeof QueuedMessageConnection>[0]
>[0];

/**
 * What one partner-bound transport supplies to {@link framedTransport}: the
 * WebRTC data channel and the WebSocket relay socket each keep their own
 * hand-off, window wait and close.
 */
export interface FramedTransportHooks {
  /** Builds the inbound reassembler; a test lowers its limits through it. */
  inboundFrames?: () => BoundedInboundFrames;
  /** Hands one chunk envelope to the transport. */
  send: (datagram: Buffer<ArrayBuffer>) => void;
  /** Whether a chunk handed over now would be delivered. */
  sendable: () => boolean;
  /**
   * Undefined while the send window has room. Otherwise a wait that resolves
   * once it has, or rejects with {@link sendCutError} once `sendable` fails.
   */
  waitForWindow: () => Promise<void> | undefined;
  /** Runs on reading the partner's close sentinel, before the half-close. */
  onInboundClose: () => void;
}

/** The framing both transports share, wired to one connection's controls. */
export interface FramedTransport {
  /** The hooks the connection drives that framing alone answers. */
  hooks: {
    outboundWebRtcFrameBound: () => number;
    requireBinaryFrames: () => void;
    send: (data: unknown) => Promise<void>;
  };
  /** Takes one inbound message off the transport. */
  accept: (data: unknown) => void;
  /** Settles, never rejecting, once every frame sent so far has settled. */
  queued: () => Promise<void>;
}

/**
 * The failure of a send the connection closed beneath, before or while its
 * chunks were handed over.
 */
export function sendCutError(): ConnectionError {
  return new ConnectionError(
    "the connection to the exchange partner closed before a message " +
      "could be sent",
    "transport",
  );
}

/**
 * Frame a transport's traffic as docs/spec/WEBRTC_TRANSPORT.md, Framing,
 * states: outbound values BinaryPack-packed and chunked, one frame at a time
 * and each chunk behind the send window, and inbound messages through the
 * bounded reassembler before anything is delivered.
 */
export function framedTransport(
  controls: Pick<TransportControls, "deliver" | "fail" | "finish">,
  transport: FramedTransportHooks,
): FramedTransport {
  const encoder = new PeerJsFrameEncoder();
  const bounds = transport.inboundFrames?.() ?? new BoundedInboundFrames();
  let sendQueue: Promise<void> = Promise.resolve();

  const sendFrame = async (data: unknown): Promise<void> => {
    for (const datagram of encoder.encode(data)) {
      const waiting = transport.waitForWindow();
      if (waiting !== undefined) await waiting;
      // werift queues a send on a channel that has left `open` without
      // complaint, so a datagram handed over then would never arrive; each
      // transport answers this before every hand-off.
      if (!transport.sendable()) throw sendCutError();
      transport.send(Buffer.from(datagram));
    }
  };

  return {
    hooks: {
      outboundWebRtcFrameBound: () => bounds.limits.maxFrameBytes,
      requireBinaryFrames: () => bounds.requireBinaryFrames(),
      send: (data) => {
        const frame = sendQueue.then(() => sendFrame(data));
        sendQueue = frame.catch(() => {});
        return frame;
      },
    },
    accept: (data) => {
      let outcome;
      try {
        outcome = bounds.accept(toFrameBytes(data));
      } catch (err) {
        controls.fail(asConnectionError(err, "protocol"));
        return;
      }
      if (outcome.kind === "pending") return;
      if (outcome.kind === "close") {
        transport.onInboundClose();
        // The partner's in-band clean close. `finish` rather than `fail`: the
        // sentinel travels the same ordered path behind every frame the
        // partner already sent, so a final frame may still be queued here and
        // must be drained before the close is reported.
        controls.finish(
          new ConnectionError("peer connection closed", "transport"),
        );
        return;
      }
      controls.deliver(outcome.value, outcome.receivedBytes);
    },
    queued: () => sendQueue,
  };
}
