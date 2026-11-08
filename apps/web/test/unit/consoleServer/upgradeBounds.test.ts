import net from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import {
  SIGNALING_HEADERS_TIMEOUT_MS,
  SIGNALING_PREHANDSHAKE_IDLE_MS,
  SIGNALING_REQUEST_TIMEOUT_MS,
} from "@alcove/peerjs-broker/standaloneUpgradeBounds";

import {
  createConsoleHandler,
  createConsoleServer,
  listenConsoleServer,
} from "../../../server/console/app";

import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Server } from "node:http";

// The bounds the console server itself is built with, read off the server
// `createConsoleServer` returns rather than off a server hardened by hand:
// the shared reap's own behavior is pinned in signalingUpgradeTimeout.test.ts.

const servers: Array<Server> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function consoleServer(options: { requestTimeoutMs?: number } = {}) {
  const server = createConsoleServer(
    createConsoleHandler({ routes: [] }),
    options,
  );
  servers.push(server);
  return server;
}

/** What a `clientError` on `server` wrote to a writable socket, and whether
 * the socket was destroyed afterwards. */
function answerToClientError(
  server: Server,
  code: string,
): { written: Array<string>; destroyed: boolean } {
  const written: Array<string> = [];
  let destroyed = false;
  const socket = {
    writable: true,
    end: (chunk?: string, flushed?: () => void) => {
      if (typeof chunk === "string") written.push(chunk);
      flushed?.();
    },
    destroy: () => {
      destroyed = true;
    },
  } as unknown as Duplex;
  const error = Object.assign(new Error(code), { code });
  server.emit("clientError", error, socket);
  return { written, destroyed };
}

describe("the console server's pre-request bounds", () => {
  test("takes the signaling header and request timeouts by default", () => {
    const server = consoleServer();
    expect(server.headersTimeout).toBe(SIGNALING_HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(SIGNALING_REQUEST_TIMEOUT_MS);
  });

  test("takes the whole-request bound it is given", () => {
    const server = consoleServer({ requestTimeoutMs: 424_000 });
    expect(server.headersTimeout).toBe(SIGNALING_HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(424_000);
  });

  test("answers a client error itself, with a 408 or a 400, then destroys the socket", () => {
    const server = consoleServer();
    expect(server.listenerCount("clientError")).toBe(1);
    const timedOut = answerToClientError(server, "ERR_HTTP_REQUEST_TIMEOUT");
    expect(timedOut.written).toHaveLength(1);
    expect(timedOut.written[0]).toContain("408 Request Timeout");
    expect(timedOut.destroyed).toBe(true);
    const malformed = answerToClientError(server, "HPE_INVALID_METHOD");
    expect(malformed.written[0]).toContain("400 Bad Request");
    expect(malformed.destroyed).toBe(true);
  });

  test("arms the idle bound on an accepted socket and reaps it when no request arrives", async () => {
    const server = consoleServer();
    const accepted = new Promise<net.Socket>((resolve) =>
      server.once("connection", resolve),
    );
    await listenConsoleServer(server, { port: 0, host: "127.0.0.1" });
    const client = net.connect(
      (server.address() as AddressInfo).port,
      "127.0.0.1",
    );
    client.on("error", () => {});
    try {
      const socket = await accepted;
      expect(socket.timeout).toBe(SIGNALING_PREHANDSHAKE_IDLE_MS);
      socket.emit("timeout");
      expect(socket.destroyed).toBe(true);
    } finally {
      client.destroy();
    }
  });

  test("adds no upgrade listener", () => {
    expect(consoleServer().listenerCount("upgrade")).toBe(0);
  });
});
