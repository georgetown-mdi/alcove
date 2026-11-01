// The SFTP relay's wire: the request path, the close codes, and the bounds,
// each stated in docs/spec/SFTP_RELAY.md.

import {
  PAUSED_READ_AHEAD_BYTES,
  QUEUED_MESSAGE_OVERHEAD_BYTES,
  QUEUE_LIMIT_BYTES,
} from "@alcove/websocket-relay/forwarding";

/** The request path a browser opens its relay socket on. */
export const SFTP_RELAY_PATH = "/sftp";

/** The largest message the relay takes from a browser, in bytes: an SSH
 * packet of the 35,000 bytes RFC 4253 requires a peer to take, rounded up. */
export const SFTP_RELAY_MAX_MESSAGE_BYTES = 64 * 1024;

/** A direction's send buffer, in bytes, above which the relay stops reading
 * from that direction's source. */
export const SFTP_RELAY_SEND_BUFFER_HIGH_BYTES = 1024 * 1024;

/** A direction's send buffer, in bytes, at or below which the relay reads
 * from that direction's source again. */
export const SFTP_RELAY_SEND_BUFFER_LOW_BYTES = 256 * 1024;

/** The browser's counted queue, in bytes, above which the relay closes the
 * browser with 4000 and ends the target: the WebSocket relay's limit
 * ({@link QUEUE_LIMIT_BYTES}). */
export const SFTP_RELAY_BROWSER_QUEUE_LIMIT_BYTES = QUEUE_LIMIT_BYTES;

/** The step, in bytes, in which the buffer of browser bytes waiting behind a
 * write to the target grows, so its unused capacity stays under one step. */
export const SFTP_RELAY_PENDING_GROWTH_BYTES = 64 * 1024;

/**
 * The most memory the relay holds for one direction of one connection, for
 * bytes read and not yet written, toward the target: the high mark, a partly
 * read message and its 14-byte frame header, the 64 KiB read that crossed the
 * mark, the unused capacity of the write in flight and of the pending buffer,
 * each under one growth step, and the paused source socket's read-ahead,
 * counted as memory ({@link PAUSED_READ_AHEAD_BYTES}). Toward the browser it
 * is less: {@link SFTP_RELAY_BROWSER_BOUND_BYTES}.
 */
export const SFTP_RELAY_BUFFERED_BOUND_BYTES =
  SFTP_RELAY_SEND_BUFFER_HIGH_BYTES +
  (SFTP_RELAY_MAX_MESSAGE_BYTES + 14) +
  64 * 1024 +
  2 * SFTP_RELAY_PENDING_GROWTH_BYTES +
  PAUSED_READ_AHEAD_BYTES;

/**
 * The most memory the relay holds toward the browser of one connection: the
 * high mark, the 64 KiB read that crossed it with its 10-byte frame header
 * and {@link QUEUED_MESSAGE_OVERHEAD_BYTES}, and the paused target socket's
 * read-ahead, counted as memory ({@link PAUSED_READ_AHEAD_BYTES}).
 */
export const SFTP_RELAY_BROWSER_BOUND_BYTES =
  SFTP_RELAY_SEND_BUFFER_HIGH_BYTES +
  64 * 1024 +
  10 +
  QUEUED_MESSAGE_OVERHEAD_BYTES +
  PAUSED_READ_AHEAD_BYTES;

/** The most connections the relay holds at once, each a WebSocket and its
 * TCP connection; an upgrade above it is refused with 503. */
export const SFTP_RELAY_MAX_CONNECTIONS = 64;

/** How long (ms) the relay waits for the target to accept a connection. */
export const SFTP_RELAY_CONNECT_TIMEOUT_MS = 10_000;

/** How long (ms) a close may wait behind the bytes queued ahead of it before
 * the socket is dropped. */
export const SFTP_RELAY_CLOSE_WAIT_MS = 30_000;

/** How often (ms) the relay pings each WebSocket it holds. */
export const SFTP_RELAY_PING_INTERVAL_MS = 30_000;

/** The window (ms) in which the relay reports an unreachable target at most
 * once. */
export const SFTP_RELAY_FAULT_REPORT_WINDOW_MS = 60_000;

/** The codes the relay closes a browser's WebSocket with. */
export const SftpRelayCloseCode = Object.freeze({
  /** The target ended its connection normally. */
  targetClosed: 1000,
  /** The relay is shutting down. */
  goingAway: 1001,
  /** A text message: the relay forwards binary messages only. */
  textMessage: 1003,
  /** A message in more fragments than `ws` allows, closed by `ws`. */
  tooManyFragments: 1008,
  /** A message above {@link SFTP_RELAY_MAX_MESSAGE_BYTES}, closed by `ws`. */
  messageTooBig: 1009,
  /** The target's connection failed after it was accepted, or what it sent
   * and the browser has not read counted above
   * {@link SFTP_RELAY_BROWSER_QUEUE_LIMIT_BYTES}. */
  targetFailed: 4000,
  /** The target refused the connection or did not accept it in time. */
  targetUnreachable: 4001,
});
