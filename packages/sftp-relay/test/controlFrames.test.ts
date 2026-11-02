import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { SFTP_RELAY_PATH, SftpRelayCloseCode } from "../src/protocol.ts";
import { attachSftpRelay } from "../src/relay.ts";

import type { SftpRelayOptions } from "../src/relay.ts";
import type { AddressInfo } from "node:net";

const ORIGIN = "https://app.example.org";

const cleanups: Array<() => void> = [];
afterEach(() => {
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
});

describe("keepalive within the control frame limit", () => {
  it("keeps open a WebSocket answering every ping, a backlog of them at once included", async () => {
    const url = await startRelay({ maxControlFrames: 3, pingIntervalMs: 5 });
    const browser = await openBrowser(url);
    let closed = false;
    browser.on("close", () => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    browser.pause();
    await new Promise((resolve) => setTimeout(resolve, 200));
    browser.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    await expectEcho(browser);
  });
});
