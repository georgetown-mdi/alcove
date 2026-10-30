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
 * Send `data` to `destination` as one binary message, calling `hold` when the
 * destination's send buffer is then above the window's high mark and
 * `release` once a send completes with it at or below the low mark: the
 * pause-and-resume forwarding of docs/spec/WEBSOCKET_RELAY.md, Forwarding,
 * which the SFTP relay applies toward its browser too.
 */
export function sendWithinWindow(
  destination: WebSocket,
  data: Buffer,
  window: SendWindow,
  hold: () => void,
  release: () => void,
): void {
  destination.send(data, { binary: true }, () => {
    if (destination.bufferedAmount <= window.lowBytes) release();
  });
  if (destination.bufferedAmount > window.highBytes) hold();
}
