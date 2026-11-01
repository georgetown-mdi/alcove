import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { duplexPair } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  QUEUED_MESSAGE_OVERHEAD_BYTES,
  queuedBytes,
} from "@alcove/websocket-relay/forwarding";

import {
  SFTP_RELAY_BROWSER_QUEUE_CEILING_BYTES,
  SFTP_RELAY_PATH,
  SFTP_RELAY_SEND_BUFFER_HIGH_BYTES,
} from "../src/protocol.ts";
import { attachSftpRelay } from "../src/relay.ts";

import type { SftpRelayObservedConnection } from "../src/relay.ts";
import type { AddressInfo, Socket } from "node:net";

// The forwarding toward the browser, with the browser in memory in place of
// TCP: once its socket is paused, what the relay sends it stays queued in the
// relay's socket, with no kernel buffer taking it.

const ORIGIN = "https://app.example.org";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Resolves once `condition` holds, checked every turn of the event loop. */
async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not met within ${ms} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A relay whose browser is paused in memory, and the target's end of its
 * TCP connection. */
async function stalledBrowser(): Promise<{
  observed: SftpRelayObservedConnection;
  targetEnd: Socket;
}> {
  const targetEnds: Socket[] = [];
  const target = createTcpServer((socket) => targetEnds.push(socket));
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const server = createServer();
  const observedConnections: SftpRelayObservedConnection[] = [];
  const relay = attachSftpRelay(server, {
    target: {
      host: "127.0.0.1",
      port: (target.address() as AddressInfo).port,
    },
    allowedOrigins: [ORIGIN],
    reportFault: () => {},
    testing: {
      observer: {
        connection: (observed) => observedConnections.push(observed),
      },
    },
  });
  const [relaySide, browserSide] = duplexPair({ highWaterMark: 1 });
  server.emit("connection", relaySide);
  const browser = new WebSocket(`ws://relay.invalid${SFTP_RELAY_PATH}`, {
    headers: { Origin: ORIGIN },
    createConnection: () => browserSide as Socket,
  });
  cleanups.push(() => {
    browser.terminate();
    relay.close();
    for (const socket of targetEnds) socket.destroy();
    target.close();
  });
  await once(browser, "open");
  await until(
    () => targetEnds.length === 1 && observedConnections.length === 1,
  );
  browser.pause();
  return { observed: observedConnections[0], targetEnd: targetEnds[0] };
}

describe("the queued-message bound toward the browser", () => {
  it.each([1, 1024, 16_384])(
    "holds the target once a stalled browser's queue of %i-byte messages, each charged its overhead, passes the high mark",
    async (size) => {
      const { observed, targetEnd } = await stalledBrowser();
      const charged =
        size + (size < 126 ? 2 : 4) + QUEUED_MESSAGE_OVERHEAD_BYTES;
      const expected =
        Math.floor(SFTP_RELAY_SEND_BUFFER_HIGH_BYTES / charged) + 1;
      const chunk = Buffer.alloc(size, 0x61);
      let sent = 0;
      while (sent < 2 * expected && !observed.target.isPaused()) {
        const before = queuedBytes(observed.browser);
        targetEnd.write(chunk);
        sent += 1;
        await until(() => queuedBytes(observed.browser) > before);
      }
      expect(sent).toBe(expected);
    },
  );
});

describe("the queue's ceiling toward the browser", () => {
  it("is the figure docs/spec/SFTP_RELAY.md states", () => {
    expect(SFTP_RELAY_BROWSER_QUEUE_CEILING_BYTES).toBe(1_115_146);
  });

  it.each([1000, 65_536, 1024 * 1024])(
    "never counts a stalled browser's queue above the ceiling while the target keeps sending in writes of %i bytes",
    async (size) => {
      const { observed, targetEnd } = await stalledBrowser();
      let reads = 0;
      let largest = 0;
      // After the relay's own listener, so each read is counted once queued.
      observed.target.on("data", () => {
        reads += 1;
        largest = Math.max(largest, queuedBytes(observed.browser));
      });
      const chunk = Buffer.alloc(size, 0x61);
      for (let sent = 0; sent < 4 * 1024 * 1024; sent += size) {
        targetEnd.write(chunk);
      }
      await until(() => observed.target.isPaused());
      let settled = -1;
      while (settled !== reads) {
        settled = reads;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(largest).toBeGreaterThan(SFTP_RELAY_SEND_BUFFER_HIGH_BYTES);
      expect(largest).toBeLessThanOrEqual(
        SFTP_RELAY_BROWSER_QUEUE_CEILING_BYTES,
      );
      expect(queuedBytes(observed.browser)).toBe(largest);
      expect(observed.browser.readyState).toBe(WebSocket.OPEN);
    },
  );
});
