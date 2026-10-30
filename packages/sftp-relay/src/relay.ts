import { connect } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import { createFaultLatch } from "@alcove/websocket-relay/faultLatch";
import { sendWithinWindow } from "@alcove/websocket-relay/forwarding";

import {
  SFTP_RELAY_CLOSE_WAIT_MS,
  SFTP_RELAY_CONNECT_TIMEOUT_MS,
  SFTP_RELAY_FAULT_REPORT_WINDOW_MS,
  SFTP_RELAY_MAX_CONNECTIONS,
  SFTP_RELAY_MAX_MESSAGE_BYTES,
  SFTP_RELAY_PATH,
  SFTP_RELAY_PING_INTERVAL_MS,
  SFTP_RELAY_SEND_BUFFER_HIGH_BYTES,
  SFTP_RELAY_SEND_BUFFER_LOW_BYTES,
  SftpRelayCloseCode,
} from "./protocol.ts";

import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

/** The one TCP endpoint the relay connects every accepted WebSocket to. */
export interface SftpRelayTarget {
  host: string;
  port: number;
}

/** @internal */
export interface SftpRelayConnectionSockets {
  browserSocket: Duplex;
  browser: WebSocket;
  target: Socket;
}

/** @internal */
export interface SftpRelayObserver {
  connection?(sockets: SftpRelayConnectionSockets): void;
}

/** What {@link attachSftpRelay} needs. */
export interface SftpRelayOptions {
  /** The target, fixed for the relay's life. */
  target: SftpRelayTarget;
  /** The `Origin` values an upgrade must match one of exactly. */
  allowedOrigins: ReadonlyArray<string>;
  /** Where the relay reports a target it could not connect to, at most once
   * a window. The text is raw, for the sink to escape. */
  reportFault: (message: string) => void;
  /** @internal */
  testing?: {
    maxConnections?: number;
    connectTimeoutMs?: number;
    closeWaitMs?: number;
    pingIntervalMs?: number;
    connectTarget?: (target: Readonly<SftpRelayTarget>) => Socket;
    observer?: SftpRelayObserver;
  };
}

/** A relay attached to an HTTP server. */
export interface SftpRelay {
  /** Stop taking upgrades, close every WebSocket with 1001 and drop every
   * TCP connection. */
  close(): void;
}

interface Connection {
  browser: WebSocket;
  target: Socket;
  connected: boolean;
  browserHeld: boolean;
  targetHeld: boolean;
  /** Sockets of the two not yet closed. */
  open: number;
  targetCloseTimer: ReturnType<typeof setTimeout> | undefined;
}

function requestPath(url: string | undefined): string {
  if (url === undefined) return "";
  const queryAt = url.search(/[?#]/);
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

function refuseUpgrade(
  socket: Duplex,
  status: "403 Forbidden" | "404 Not Found" | "503 Service Unavailable",
): void {
  // The HTTP server detaches its own listeners from an upgrade's socket, so
  // an error here would otherwise be thrown.
  socket.on("error", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

/**
 * Whether `request` holds exactly one `Origin` header and its value is one of
 * `allowed`, compared as strings.
 */
export function hasAllowedOrigin(
  request: IncomingMessage,
  allowed: ReadonlySet<string>,
): boolean {
  const values = request.headersDistinct.origin;
  return values?.length === 1 && allowed.has(values[0]);
}

/**
 * Attach the SFTP relay to `server`: it takes upgrades on
 * {@link SFTP_RELAY_PATH} whose `Origin` is allowed, opens one TCP connection
 * to `target` for each, and forwards each binary message to it and each read
 * from it back as one binary message, unread. Nothing a browser sends names
 * or changes the target. The wire: docs/spec/SFTP_RELAY.md.
 */
export function attachSftpRelay(
  server: Server,
  options: SftpRelayOptions,
): SftpRelay {
  const { reportFault, testing = {} } = options;
  const target: Readonly<SftpRelayTarget> = Object.freeze({
    host: options.target.host,
    port: options.target.port,
  });
  const allowedOrigins: ReadonlySet<string> = new Set(options.allowedOrigins);
  const window = Object.freeze({
    highBytes: SFTP_RELAY_SEND_BUFFER_HIGH_BYTES,
    lowBytes: SFTP_RELAY_SEND_BUFFER_LOW_BYTES,
  });
  const maxConnections = testing.maxConnections ?? SFTP_RELAY_MAX_CONNECTIONS;
  const connectTimeoutMs =
    testing.connectTimeoutMs ?? SFTP_RELAY_CONNECT_TIMEOUT_MS;
  const closeWaitMs = testing.closeWaitMs ?? SFTP_RELAY_CLOSE_WAIT_MS;
  const pingIntervalMs = testing.pingIntervalMs ?? SFTP_RELAY_PING_INTERVAL_MS;
  const connectTarget =
    testing.connectTarget ??
    (({ host, port }: Readonly<SftpRelayTarget>) => connect({ host, port }));
  const observer = testing.observer ?? {};
  const unreachableReports = createFaultLatch(
    SFTP_RELAY_FAULT_REPORT_WINDOW_MS,
  );

  // `closeTimeout` is read by the pinned `ws` but missing from @types/ws, as
  // in the pairing relay.
  const serverOptions = {
    noServer: true,
    clientTracking: false,
    maxPayload: SFTP_RELAY_MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    closeTimeout: closeWaitMs,
  };
  const socketServer = new WebSocketServer(serverOptions);
  const connections = new Set<Connection>();

  function holdBrowser(connection: Connection): void {
    if (connection.browserHeld) return;
    connection.browserHeld = true;
    connection.browser.pause();
  }

  function releaseBrowser(connection: Connection): void {
    if (!connection.browserHeld) return;
    connection.browserHeld = false;
    connection.browser.resume();
  }

  function holdTarget(connection: Connection): void {
    if (connection.targetHeld) return;
    connection.targetHeld = true;
    connection.target.pause();
  }

  function releaseTarget(connection: Connection): void {
    if (!connection.targetHeld) return;
    connection.targetHeld = false;
    connection.target.resume();
  }

  function closed(connection: Connection): void {
    connection.open -= 1;
    if (connection.open === 0) connections.delete(connection);
  }

  // Queued behind every message already sent to the browser. A held socket
  // reads nothing, the answer to its close included, so it is released; what
  // it then delivers is dropped once the target has ended.
  function closeBrowser(connection: Connection, code: number): void {
    if (connection.browser.readyState !== WebSocket.OPEN) return;
    releaseBrowser(connection);
    connection.browser.close(code);
  }

  // Ends the TCP connection behind every byte already written to it, and
  // drops it if the target has not closed within the close wait. What the
  // target sends after this is read and dropped, so its close is seen.
  function endTarget(connection: Connection): void {
    const { target } = connection;
    if (target.destroyed || target.writableEnded) return;
    target.end();
    releaseTarget(connection);
    connection.targetCloseTimer = setTimeout(
      () => target.destroy(),
      closeWaitMs,
    );
    connection.targetCloseTimer.unref();
  }

  function toTarget(
    connection: Connection,
    data: Buffer,
    isBinary: boolean,
  ): void {
    const { target } = connection;
    if (target.destroyed || target.writableEnded) return;
    if (!isBinary) {
      closeBrowser(connection, SftpRelayCloseCode.textMessage);
      return endTarget(connection);
    }
    target.write(data, () => {
      if (target.writableLength <= window.lowBytes) releaseBrowser(connection);
    });
    if (target.writableLength > window.highBytes) holdBrowser(connection);
  }

  function toBrowser(connection: Connection, data: Buffer): void {
    const { browser } = connection;
    if (browser.readyState !== WebSocket.OPEN) return;
    sendWithinWindow(
      browser,
      data,
      window,
      () => holdTarget(connection),
      () => releaseTarget(connection),
    );
  }

  function onConnection(browser: WebSocket, browserSocket: Duplex): void {
    // The one connection the relay opens, always to the target fixed above.
    const tcp = connectTarget(target);
    const connection: Connection = {
      browser,
      target: tcp,
      connected: false,
      browserHeld: false,
      targetHeld: false,
      open: 2,
      targetCloseTimer: undefined,
    };
    connections.add(connection);

    tcp.setTimeout(connectTimeoutMs);
    tcp.once("connect", () => {
      connection.connected = true;
      tcp.setTimeout(0);
    });
    tcp.on("timeout", () =>
      tcp.destroy(new Error(`no answer within ${connectTimeoutMs} ms`)),
    );
    tcp.on("data", (chunk: Buffer) => toBrowser(connection, chunk));
    tcp.on("error", (error: Error) => {
      if (connection.connected || !unreachableReports.admit("")) return;
      reportFault(
        `the SFTP relay could not connect to ${target.host} port ${target.port}: ${error.message}`,
      );
    });
    tcp.on("close", (hadError: boolean) => {
      clearTimeout(connection.targetCloseTimer);
      let code: number = SftpRelayCloseCode.targetClosed;
      if (!connection.connected) code = SftpRelayCloseCode.targetUnreachable;
      else if (hadError) code = SftpRelayCloseCode.targetFailed;
      closeBrowser(connection, code);
      closed(connection);
    });

    // The server's sockets keep `ws`'s default binary type, so every message
    // arrives as one Buffer.
    browser.on("message", (data, isBinary) =>
      toTarget(connection, data as Buffer, isBinary),
    );
    // `ws` closes the socket itself after an error it raises, an oversized
    // message's 1009 among them, and the close below ends the target.
    browser.on("error", () => {});
    browser.on("close", () => {
      endTarget(connection);
      closed(connection);
    });
    observer.connection?.({ browserSocket, browser, target: tcp });
  }

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (socket.destroyed) return;
    if (requestPath(request.url) !== SFTP_RELAY_PATH) {
      return refuseUpgrade(socket, "404 Not Found");
    }
    if (!hasAllowedOrigin(request, allowedOrigins)) {
      return refuseUpgrade(socket, "403 Forbidden");
    }
    // `ws` calls `onConnection` before `handleUpgrade` returns, as the
    // pairing relay's tests hold, so the count holds every upgrade answered.
    if (connections.size >= maxConnections) {
      return refuseUpgrade(socket, "503 Service Unavailable");
    }
    socketServer.handleUpgrade(request, socket, head, (browser) =>
      onConnection(browser, socket),
    );
  };
  server.on("upgrade", onUpgrade);

  const pingTimer = setInterval(() => {
    for (const { browser } of connections) {
      if (browser.readyState === WebSocket.OPEN) browser.ping();
    }
  }, pingIntervalMs);
  pingTimer.unref();

  return {
    close() {
      server.off("upgrade", onUpgrade);
      clearInterval(pingTimer);
      for (const connection of [...connections]) {
        closeBrowser(connection, SftpRelayCloseCode.goingAway);
        connection.target.destroy();
      }
    },
  };
}
