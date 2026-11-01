import type { WebSocket } from "ws";

/** The send-buffer marks, in bytes, a forwarder stops and resumes reading its
 * source at, and the limit it ends the forwarding at. */
export interface SendWindow {
  /** Above this, the source is held. */
  highBytes: number;
  /** At or below this, the source is released. */
  lowBytes: number;
  /** Above this, the forwarding ends. */
  limitBytes: number;
}

/**
 * The counted queue, in bytes, above which the relays end a forwarding
 * ({@link sendWithinWindow}): 1.25 MiB, 256 KiB over the 1 MiB high mark.
 * The largest counted queue measured in honest rounds through the WebSocket
 * relay was 1,093,869 bytes, 45,293 over the high mark, in a 539,000,000-byte
 * round whose reader stopped for 45 seconds (docs/spec/WEBSOCKET_RELAY.md,
 * Measured counted queues).
 */
export const QUEUE_LIMIT_BYTES = 1280 * 1024;

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
 * header, plus {@link QUEUED_MESSAGE_OVERHEAD_BYTES} for each message and
 * ping answer queued here that has not yet been written.
 */
export function queuedBytes(destination: WebSocket): number {
  return (
    destination.bufferedAmount +
    (queuedMessages.get(destination) ?? 0) * QUEUED_MESSAGE_OVERHEAD_BYTES
  );
}

/** Node's read size and a TCP socket's read high-water mark, in bytes. */
const READ_BYTES = 64 * 1024;

/**
 * The memory, in bytes, a chunk in a paused socket's read buffer holds beyond
 * its own bytes. Measured on Node v26.13 at about 219 bytes for chunks of one
 * or two bytes, and rounded up.
 */
export const READ_CHUNK_OVERHEAD_BYTES = 256;

/**
 * The most memory, in bytes, a paused TCP socket's read-ahead holds when its
 * read high-water mark is `highWaterMark` bytes: Node reads on until its
 * buffer reaches the mark, in chunks of at least one byte each counted with
 * {@link READ_CHUNK_OVERHEAD_BYTES}, plus the one read that crossed the mark.
 */
export function pausedReadAheadBytes(highWaterMark: number): number {
  return (
    highWaterMark + READ_BYTES + (highWaterMark + 1) * READ_CHUNK_OVERHEAD_BYTES
  );
}

/** The most memory, in bytes, a paused TCP socket's read-ahead holds at
 * Node's default 64 KiB read high-water mark. */
export const PAUSED_READ_AHEAD_BYTES = pausedReadAheadBytes(READ_BYTES);

// Counts one frame toward `destination` until `write` completes it, with
// Buffer's pool off: `ws` takes a frame's header from the shared pool, where
// one queued header would keep a whole pool block alive.
function queueFrame(
  destination: WebSocket,
  write: (done: () => void) => void,
  done: () => void,
): void {
  queuedMessages.set(destination, (queuedMessages.get(destination) ?? 0) + 1);
  const poolSize = Buffer.poolSize;
  Buffer.poolSize = 0;
  try {
    write(() => {
      queuedMessages.set(
        destination,
        (queuedMessages.get(destination) ?? 1) - 1,
      );
      done();
    });
  } finally {
    Buffer.poolSize = poolSize;
  }
}

/**
 * Send `data` to `destination` as one binary message, calling `overLimit`
 * when the destination's queued bytes ({@link queuedBytes}) are then above
 * the window's limit, `hold` when they are above its high mark, and
 * `release` once a send completes with them at or below the low mark: the
 * pause-and-resume forwarding of docs/spec/WEBSOCKET_RELAY.md, Forwarding,
 * which the SFTP relay applies toward its browser too.
 */
export function sendWithinWindow(
  destination: WebSocket,
  data: Buffer,
  window: SendWindow,
  hold: () => void,
  release: () => void,
  overLimit: () => void,
): void {
  // An unpooled copy, so a queued message keeps its own bytes and not the
  // read or the shared pool block it arrived in.
  const message = Buffer.allocUnsafeSlow(data.length);
  data.copy(message);
  queueFrame(
    destination,
    (done) => destination.send(message, { binary: true }, done),
    () => {
      if (queuedBytes(destination) <= window.lowBytes) release();
    },
  );
  const queued = queuedBytes(destination);
  if (queued > window.limitBytes) overLimit();
  else if (queued > window.highBytes) hold();
}

/**
 * Answer a ping from `destination` when the answer fits under the window's
 * high mark, counting the answer as a queued message, and drop it otherwise;
 * `release` is called once the answer is written with the queued bytes at or
 * below the low mark.
 */
export function pongWithinWindow(
  destination: WebSocket,
  data: Buffer,
  window: SendWindow,
  release: () => void,
): void {
  // 2: the header of an unmasked control frame of up to 125 bytes.
  const answerBytes = 2 + data.length + QUEUED_MESSAGE_OVERHEAD_BYTES;
  if (queuedBytes(destination) + answerBytes > window.highBytes) return;
  const payload = Buffer.allocUnsafeSlow(data.length);
  data.copy(payload);
  queueFrame(
    destination,
    (done) => destination.pong(payload, false, done),
    () => {
      if (queuedBytes(destination) <= window.lowBytes) release();
    },
  );
}
