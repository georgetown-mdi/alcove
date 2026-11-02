import { once } from "node:events";
import { createServer } from "node:http";
import {
  connect as connectTcp,
  createServer as createTcpServer,
} from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { SFTP_RELAY_PATH, SftpRelayCloseCode } from "../src/protocol.ts";
import { attachSftpRelay } from "../src/relay.ts";

import type { SftpRelayOptions } from "../src/relay.ts";
import type { AddressInfo } from "node:net";

const ORIGIN = "https://app.example.org";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A relay in front of a loopback target that echoes what it reads. */
async function startRelay(
  testing: SftpRelayOptions["testing"],
): Promise<string> {
  const target = createTcpServer((socket) => socket.pipe(socket));
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const server = createServer();
  const relay = attachSftpRelay(server, {
    target: {
      host: "127.0.0.1",
      port: (target.address() as AddressInfo).port,
    },
    allowedOrigins: [ORIGIN],
    reportFault: () => {},
    testing,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    relay.close();
    server.closeAllConnections();
    server.close();
    target.close();
  });
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}${SFTP_RELAY_PATH}`;
}

async function openBrowser(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Origin: ORIGIN } });
  cleanups.push(() => socket.terminate());
  await once(socket, "open");
  return socket;
}

async function expectEcho(socket: WebSocket): Promise<void> {
  const echoed = once(socket, "message");
  socket.send(Buffer.from("still forwarding"));
  const [data] = (await echoed) as [Buffer];
  expect(data.toString()).toBe("still forwarding");
}

describe("the control frame limit", () => {
  it.each(["ping", "pong"] as const)(
    "closes a WebSocket past the limit on %s frames with 4002, while another connection forwards",
    async (frame) => {
      const url = await startRelay({ maxControlFrames: 4 });
      const other = await openBrowser(url);
      const browser = await openBrowser(url);
      const closed = once(browser, "close");
      for (let sent = 0; sent < 5; sent += 1) browser[frame]();
      const [code] = (await closed) as [number];
      expect(code).toBe(SftpRelayCloseCode.controlFrameLimit);
      await expectEcho(other);
    },
  );

  it.each([
    ["ping", Buffer.from([0x89, 0x80, 0, 0, 0, 0])],
    ["pong", Buffer.from([0x8a, 0x80, 0, 0, 0, 0])],
  ] as const)(
    "closes and drops a WebSocket once for one write of many %s frames past the limit",
    async (_frame, bytes) => {
      const url = await startRelay({ maxControlFrames: 4 });
      const { hostname, port } = new URL(url);
      const socket = connectTcp(Number(port), hostname);
      socket.on("error", () => {});
      await once(socket, "connect");
      socket.write(
        `GET ${SFTP_RELAY_PATH} HTTP/1.1\r\nHost: relay\r\nOrigin: ${ORIGIN}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      await once(socket, "data");
      const terminate = vi.spyOn(WebSocket.prototype, "terminate");
      const close = vi.spyOn(WebSocket.prototype, "close");
      socket.write(Buffer.concat(Array(10_000).fill(bytes)));
      await once(socket, "close");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(
        close.mock.calls.filter(
          ([code]) => code === SftpRelayCloseCode.controlFrameLimit,
        ),
      ).toHaveLength(1);
    },
  );
});

describe("keepalive within the control frame limit", () => {
  it("keeps open a WebSocket answering every ping, two of them at once included", async () => {
    const url = await startRelay({ maxControlFrames: 1, pingIntervalMs: 50 });
    const browser = await openBrowser(url);
    let closed = false;
    browser.on("close", () => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    browser.pause();
    await new Promise((resolve) => setTimeout(resolve, 120));
    browser.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    await expectEcho(browser);
  });
});
