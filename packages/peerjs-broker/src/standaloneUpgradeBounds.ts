import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";

/**
 * The pre-101 bounds the standalone runner puts on its own HTTP server, kept
 * apart from `standalone.ts` (which listens at import time) so a test can apply
 * them. The web app's servers import the same constants. See
 * docs/spec/CHANNEL_SECURITY.md#web-signaling-surface-bounds.
 */

/** Bound (ms) for the complete request headers. Node checks it on a periodic
 * sweep, so a close can come up to one sweep interval later. */
export const SIGNALING_HEADERS_TIMEOUT_MS = 10_000;

/** Bound (ms) for the entire request. Node requires it above
 * {@link SIGNALING_HEADERS_TIMEOUT_MS}. */
export const SIGNALING_REQUEST_TIMEOUT_MS = 15_000;

/** Idle bound (ms) for a socket that has not begun its request, or stopped
 * part-way; the two above arm only once parsing has begun. */
export const SIGNALING_PREHANDSHAKE_IDLE_MS = 10_000;

/** Placeholder listener; see {@link applyStandaloneUpgradeBounds}. */
function deferTimeoutToIdleReap(): void {}

/**
 * Bound the window before the runner has a whole request in hand. None of the
 * bounds reaches a slow handler or an established WebSocket (`ws` clears the
 * socket timeout on the 101). Nothing is wired on `upgrade`: the signaling
 * server reads `listenerCount("upgrade")`. The overrides are for tests.
 */
export function applyStandaloneUpgradeBounds(
  server: Server,
  overrides: {
    headersTimeoutMs?: number;
    requestTimeoutMs?: number;
    preHandshakeIdleMs?: number;
  } = {},
): void {
  server.headersTimeout =
    overrides.headersTimeoutMs ?? SIGNALING_HEADERS_TIMEOUT_MS;
  server.requestTimeout =
    overrides.requestTimeoutMs ?? SIGNALING_REQUEST_TIMEOUT_MS;
  const idleMs = overrides.preHandshakeIdleMs ?? SIGNALING_PREHANDSHAKE_IDLE_MS;

  // `request` fires once headers are parsed; `complete` says whether the body
  // has arrived too.
  const pendingRequestBySocket = new WeakMap<Socket, IncomingMessage>();

  server.on("connection", (socket: Socket) => {
    const reapUnlessRequestIsInHand = (): void => {
      if (socket.destroyed) return;
      if (!pendingRequestBySocket.get(socket)?.complete) socket.destroy();
    };
    // Not passed to `setTimeout`, which subscribes for one firing only.
    socket.on("timeout", reapUnlessRequestIsInHand);
    socket.setTimeout(idleMs);
  });

  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    pendingRequestBySocket.set(request.socket, request);
    // Node destroys a timed-out socket unless something has a `timeout`
    // listener; this one leaves the decision to the reap above.
    response.on("timeout", deferTimeoutToIdleReap);
  });
}
