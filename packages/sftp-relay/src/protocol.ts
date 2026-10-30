// The SFTP relay's wire: the request path, the close codes, and the bounds,
// each stated in docs/spec/SFTP_RELAY.md.

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

/**
 * The most bytes the relay holds for one direction of one connection: the
 * high mark, plus what was already read when reading stopped -- one TCP read
 * of 64 KiB toward the browser, and toward the target one read and one
 * partly read message.
 */
export const SFTP_RELAY_BUFFERED_BOUND_BYTES =
  SFTP_RELAY_SEND_BUFFER_HIGH_BYTES + 3 * 64 * 1024;

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
  /** A message above {@link SFTP_RELAY_MAX_MESSAGE_BYTES}, closed by `ws`. */
  messageTooBig: 1009,
  /** The target's connection failed after it was accepted. */
  targetFailed: 4000,
  /** The target refused the connection or did not accept it in time. */
  targetUnreachable: 4001,
});
