import http from "node:http";
import net from "node:net";

import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, test } from "vitest";

import {
  SIGNALING_HEADERS_TIMEOUT_MS,
  SIGNALING_REQUEST_TIMEOUT_MS,
  applyStandaloneUpgradeBounds,
} from "@alcove/peerjs-broker/standaloneUpgradeBounds";

import type { AddressInfo } from "node:net";

// The standalone broker runner's pre-101 bounds, and the Node and `ws` timer
// behaviors their shape depends on, driven against the real libraries. The
// console server's own bounds (`hardenUpgradeSurface`) are covered in
// signalingUpgradeTimeout.test.ts; the runner's process-level wiring in the
// CLI's broker suite.

const IDLE_MS = 300;

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/** The body of a GET, or the error that ended it. */
function fetchBody(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve(text));
        res.on("aborted", () => reject(new Error("response cut")));
      },
    );
    req.on("error", reject);
  });
}

describe("the Node behaviors the bounds are shaped around", () => {
  test("Node refuses a request timeout below the header timeout, and the constants keep the order", () => {
    expect(() =>
      http.createServer({
        headersTimeout: SIGNALING_REQUEST_TIMEOUT_MS + 1,
        requestTimeout: SIGNALING_REQUEST_TIMEOUT_MS,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(SIGNALING_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      SIGNALING_HEADERS_TIMEOUT_MS,
    );
    expect(() =>
      http.createServer({
        headersTimeout: SIGNALING_HEADERS_TIMEOUT_MS,
        requestTimeout: SIGNALING_REQUEST_TIMEOUT_MS,
      }),
    ).not.toThrow();
  });

  test("a callback passed to a socket's setTimeout runs for one firing only", () => {
    const socket = new net.Socket();
    let fired = 0;
    socket.setTimeout(60_000, () => (fired += 1));
    socket.emit("timeout");
    socket.emit("timeout");
    socket.destroy();
    expect(fired).toBe(1);
  });

  test("Node destroys a timed-out server socket when nothing listens for the timeout", async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => res.end("late"), IDLE_MS * 4);
    });
    server.on("connection", (socket: net.Socket) => socket.setTimeout(IDLE_MS));
    const port = await listen(server);
    await expect(fetchBody(port)).rejects.toThrow();
  });
});

describe("applyStandaloneUpgradeBounds", () => {
  test("keeps its reap subscribed after the socket's timeout fires", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    applyStandaloneUpgradeBounds(server, { preHandshakeIdleMs: 30_000 });
    const accepted = new Promise<net.Socket>((resolve) =>
      server.once("connection", resolve),
    );
    const port = await listen(server);
    const client = net.connect(port, "127.0.0.1");
    client.on("error", () => {});
    cleanups.push(() => client.destroy());
    const socket = await accepted;
    const subscribed = socket.listenerCount("timeout");
    expect(subscribed).toBeGreaterThan(0);
    socket.emit("timeout");
    // The socket owed a request, so the firing reaped it; the subscription is
    // still in place for a socket that outlives one.
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("timeout")).toBe(subscribed);
  });

  test("lets a response slower than the idle bound finish", async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => res.end("late"), IDLE_MS * 4);
    });
    applyStandaloneUpgradeBounds(server, { preHandshakeIdleMs: IDLE_MS });
    const port = await listen(server);
    await expect(fetchBody(port)).resolves.toBe("late");
  });

  test("reaps a socket whose headers arrived but whose announced body did not", async () => {
    const server = http.createServer((req, res) => {
      req.on("end", () => res.end("ok"));
      req.resume();
    });
    applyStandaloneUpgradeBounds(server, { preHandshakeIdleMs: IDLE_MS });
    const port = await listen(server);
    const closedMs = await new Promise<number | null>((resolve) => {
      const start = Date.now();
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 1000\r\n\r\n",
        );
      });
      socket.on("close", () => resolve(Date.now() - start));
      socket.on("error", () => {});
      setTimeout(() => resolve(null), 3_000);
    });
    expect(closedMs).not.toBeNull();
    expect(closedMs).toBeLessThan(2_500);
  });

  test("an established WebSocket outlives the idle bound, ws having cleared the socket timeout", async () => {
    const server = http.createServer();
    applyStandaloneUpgradeBounds(server, { preHandshakeIdleMs: IDLE_MS });
    const wss = new WebSocketServer({ server });
    cleanups.push(() => wss.close());
    const upgraded = new Promise<net.Socket>((resolve) =>
      wss.once("connection", (_ws, req) => resolve(req.socket)),
    );
    const port = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    cleanups.push(() => client.terminate());
    let closed = false;
    client.on("close", () => (closed = true));
    client.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });

    const socket = await upgraded;
    expect(socket.timeout).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 4));
    expect(closed).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  test("adds no upgrade listener", () => {
    const server = http.createServer();
    applyStandaloneUpgradeBounds(server);
    expect(server.listenerCount("upgrade")).toBe(0);
    expect(server.headersTimeout).toBe(SIGNALING_HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(SIGNALING_REQUEST_TIMEOUT_MS);
  });
});
