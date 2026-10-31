import type { WebSocket } from "ws";

/** The send-buffer marks, in bytes, a forwarder stops and resumes reading its
 * source at. */
export interface SendWindow {
  /** Above this, the source is held. */
  highBytes: number;
  /** At or below this, the source is released. */
  lowBytes: number;
}

/**
 * The heap and buffer memory, in bytes, a message queued by
 * {@link sendWithinWindow} holds beyond its payload: its frame header, Node's
 * write entries, the buffer objects and the completion callback. Measured on
 * Node v26.13 with the pinned `ws` at 636 to 864 bytes for messages of
 * 1 byte, 1 KiB and 16 KiB, and rounded up to 1 KiB;
 * test/queuedMessageOverhead.test.ts fails when the running Node and `ws`
 * measure above it.
 */
export const QUEUED_MESSAGE_OVERHEAD_BYTES = 1024;

const queuedMessages = new WeakMap<WebSocket, number>();

/**
 * The bytes the messages queued toward `destination` are charged against its
 * window: its send buffer, which counts each message's payload and frame
 * header, plus {@link QUEUED_MESSAGE_OVERHEAD_BYTES} for each message sent
 * through {@link sendWithinWindow} that has not yet been written.
 */
export function queuedBytes(destination: WebSocket): number {
  return (
    destination.bufferedAmount +
    (queuedMessages.get(destination) ?? 0) * QUEUED_MESSAGE_OVERHEAD_BYTES
  );
}

/**
 * Send `data` to `destination` as one binary message, calling `hold` when the
 * destination's queued bytes ({@link queuedBytes}) are then above the
 * window's high mark and `release` once a send completes with them at or
 * below the low mark: the pause-and-resume forwarding of
 * docs/spec/WEBSOCKET_RELAY.md, Forwarding, which the SFTP relay applies
 * toward its browser too.
 */
export function sendWithinWindow(
  destination: WebSocket,
  data: Buffer,
  window: SendWindow,
  hold: () => void,
  release: () => void,
): void {
  // An unpooled copy, so a queued message keeps its own bytes and not the
  // read or the shared pool block it arrived in.
  const message = Buffer.allocUnsafeSlow(data.length);
  data.copy(message);
  queuedMessages.set(destination, (queuedMessages.get(destination) ?? 0) + 1);
  // `ws` frames the message inside `send`, its header from Buffer's shared
  // pool, where one queued header would keep a whole pool block alive; with
  // the pool off for the call, the header is its own few bytes.
  const poolSize = Buffer.poolSize;
  Buffer.poolSize = 0;
  try {
    destination.send(message, { binary: true }, () => {
      queuedMessages.set(
        destination,
        (queuedMessages.get(destination) ?? 1) - 1,
      );
      if (queuedBytes(destination) <= window.lowBytes) release();
    });
  } finally {
    Buffer.poolSize = poolSize;
  }
  if (queuedBytes(destination) > window.highBytes) hold();
}
