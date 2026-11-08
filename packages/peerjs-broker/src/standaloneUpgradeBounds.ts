import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * The pre-101 bounds the standalone runners and the console server put on
 * their HTTP servers, kept apart from `standalone.ts` (which listens at import
 * time) so a test can apply them. See
 * docs/spec/SIGNALING_SERVER_BOUNDS.md#web-signaling-surface-bounds.
 */

/** Bound (ms) for the complete request headers. */
export const SIGNALING_HEADERS_TIMEOUT_MS = 10_000;

/** Bound (ms) for the entire request. Node refuses one below
 * {@link SIGNALING_HEADERS_TIMEOUT_MS}. */
export const SIGNALING_REQUEST_TIMEOUT_MS = 15_000;

/** Idle bound (ms) for a socket that has not begun its request, or stopped
 * part-way; the two above arm only once parsing has begun. */
export const SIGNALING_PREHANDSHAKE_IDLE_MS = 10_000;

// Per-server idle hooks, so a repeated harden replaces rather than stacks
// them. They close over their per-call idle bound, so unlike the shared
// listeners below they cannot be removed by identity alone.
const idleHooksByServer = new WeakMap<
  Server,
  { arm: (socket: Socket) => void; handOffToTls: (socket: Socket) => void }
>();

// The reap armed on each socket, so handing the bound to a wrapping socket
// can detach it: `setTimeout(0)` alone leaves it subscribed to `timeout`,
// where Node's own keep-alive handling could later fire it.
const idleReapCallbackBySocket = new WeakMap<Socket, () => void>();

// The request each socket is delivering. `request` fires once the headers are
// parsed; `complete` says whether the body has arrived too.
const pendingRequestBySocket = new WeakMap<Socket, IncomingMessage>();

/**
 * Close a stalled or malformed handshake. Node does this from its own
 * `clientError` default, which any other `clientError` listener suppresses
 * (an embedding framework, or a test environment that loads `ws`). Answers a
 * still-writable socket, then destroys it once the answer has flushed, since
 * `end()` alone only half-closes.
 */
function closeStalledHandshake(
  err: NodeJS.ErrnoException,
  socket: Duplex,
): void {
  if (socket.writable) {
    const status =
      err.code === "ERR_HTTP_REQUEST_TIMEOUT"
        ? "408 Request Timeout"
        : "400 Bad Request";
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () =>
      socket.destroy(),
    );
  } else {
    socket.destroy();
  }
}

/**
 * A socket wrapping another, as a TLS connection wraps the accepted TCP
 * socket. `_parent` is the only link Node exposes between the two, and Node's
 * timer refresh walks it, so a bound left on the inner socket is kept alive by
 * the wrapper's traffic while every release sees only the wrapper. The HTTPS
 * tests fail if a Node release drops the link.
 */
type WrappingSocket = Socket & { _parent?: Socket | null };

/** Clear a socket's idle bound and detach the state this module put on it. */
function releaseIdleBound(socket: Socket): void {
  socket.setTimeout(0);
  const reapCallback = idleReapCallbackBySocket.get(socket);
  if (reapCallback) {
    socket.removeListener("timeout", reapCallback);
    idleReapCallbackBySocket.delete(socket);
  }
  pendingRequestBySocket.delete(socket);
}

/** Placeholder listener; see {@link trackPendingRequest}. */
function deferTimeoutToIdleReap(): void {}

/**
 * Record the request a socket has begun delivering, for the reap to weigh.
 * Node destroys a timed-out socket unless the request, the response or the
 * server has a `timeout` listener; one on the response leaves the decision to
 * the reap for exactly as long as a response is in flight.
 */
function trackPendingRequest(req: IncomingMessage, res: ServerResponse): void {
  pendingRequestBySocket.set(req.socket, req);
  res.on("timeout", deferTimeoutToIdleReap);
}

/**
 * Bound the window before `server` has a whole request in hand: header and
 * request timeouts, and a per-socket idle reap for a socket that sends nothing
 * or stops part-way, a complete-headers request whose announced body stalls
 * included. None reaches a request wholly in hand, a slow handler, or an
 * established WebSocket (`ws` clears the socket timeout on the 101). Over TLS
 * the bound moves to the `TLSSocket` once the handshake completes. Nothing is
 * wired on `upgrade`: the signaling server reads `listenerCount("upgrade")`.
 * Idempotent per server. `closeOnClientError` answers a client error here
 * rather than through Node's default; the overrides are for tests.
 */
export function hardenUpgradeSurface(
  server: Server,
  options: {
    headersTimeoutMs?: number;
    requestTimeoutMs?: number;
    preHandshakeIdleMs?: number;
    closeOnClientError?: boolean;
  } = {},
): void {
  server.headersTimeout =
    options.headersTimeoutMs ?? SIGNALING_HEADERS_TIMEOUT_MS;
  server.requestTimeout =
    options.requestTimeoutMs ?? SIGNALING_REQUEST_TIMEOUT_MS;
  server.removeListener("clientError", closeStalledHandshake);
  if (options.closeOnClientError === true)
    server.on("clientError", closeStalledHandshake);

  const idleMs = options.preHandshakeIdleMs ?? SIGNALING_PREHANDSHAKE_IDLE_MS;
  const previousHooks = idleHooksByServer.get(server);
  if (previousHooks) {
    server.removeListener("connection", previousHooks.arm);
    server.removeListener("secureConnection", previousHooks.handOffToTls);
  }
  const armPreHandshakeIdleBound = (socket: Socket): void => {
    const reapUnlessRequestIsInHand = (): void => {
      if (socket.destroyed) return;
      if (!pendingRequestBySocket.get(socket)?.complete) socket.destroy();
    };
    idleReapCallbackBySocket.set(socket, reapUnlessRequestIsInHand);
    // Not passed to `setTimeout`, which subscribes for one firing only.
    socket.on("timeout", reapUnlessRequestIsInHand);
    socket.setTimeout(idleMs);
  };
  // Until the TLS handshake completes, the accepted socket holds the only
  // bound on a peer that never starts one. Inert on plain HTTP.
  const handOffIdleBoundToTlsSocket = (tlsSocket: Socket): void => {
    const wrappedSocket = (tlsSocket as WrappingSocket)._parent;
    if (wrappedSocket) releaseIdleBound(wrappedSocket);
    armPreHandshakeIdleBound(tlsSocket);
  };
  idleHooksByServer.set(server, {
    arm: armPreHandshakeIdleBound,
    handOffToTls: handOffIdleBoundToTlsSocket,
  });
  server.on("connection", armPreHandshakeIdleBound);
  server.on("secureConnection", handOffIdleBoundToTlsSocket);

  server.removeListener("request", trackPendingRequest);
  server.on("request", trackPendingRequest);
}

/**
 * The standalone runners' bounds: {@link hardenUpgradeSurface} with Node's own
 * `clientError` answer left in place. The overrides are for tests.
 */
export function applyStandaloneUpgradeBounds(
  server: Server,
  overrides: {
    headersTimeoutMs?: number;
    requestTimeoutMs?: number;
    preHandshakeIdleMs?: number;
  } = {},
): void {
  hardenUpgradeSurface(server, overrides);
}
