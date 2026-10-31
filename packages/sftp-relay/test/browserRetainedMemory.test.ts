import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { duplexPair } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { queuedBytes } from "@alcove/websocket-relay/forwarding";

import {
  SFTP_RELAY_BROWSER_BOUND_BYTES,
  SFTP_RELAY_PATH,
} from "../src/protocol.ts";
import { attachSftpRelay } from "../src/relay.ts";

import type { SftpRelayObservedConnection } from "../src/relay.ts";
import type { AddressInfo, Socket } from "node:net";

// The forwarding toward the browser, measured as retained memory: a target
// floods 1-byte writes with Nagle off while the browser, connected in memory,
// is paused, so the relay's queue and the paused target's read-ahead are all
// the relay holds for that direction.

const ORIGIN = "https://app.example.org";
const gc = (globalThis as { gc?: () => void }).gc;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function settledMemory(): Promise<number> {
  if (gc === undefined) {
    throw new Error(
      "run with --expose-gc (packages/sftp-relay/vitest.config.ts)",
    );
  }
  for (let round = 0; round < 3; round += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const { heapUsed, external } = process.memoryUsage();
  return heapUsed + external;
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

async function retainedTowardStalledBrowser(): Promise<number> {
  const targetSockets: Socket[] = [];
  const pumps: Array<() => void> = [];
  const target = createTcpServer((socket) => {
    socket.setNoDelay(true);
    const one = Buffer.from([0x61]);
    const pump = (): void => {
      while (socket.write(one));
    };
    socket.on("drain", pump);
    targetSockets.push(socket);
    pumps.push(pump);
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const server = createHttpServer();
  const observed: SftpRelayObservedConnection[] = [];
  const relay = attachSftpRelay(server, {
    target: { host: "127.0.0.1", port: (target.address() as AddressInfo).port },
    allowedOrigins: [ORIGIN],
    reportFault: () => {},
    testing: { observer: { connection: (o) => observed.push(o) } },
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
    for (const socket of targetSockets) socket.destroy();
    target.close();
  });
  await once(browser, "open");
  while (observed.length === 0) await new Promise((r) => setImmediate(r));
  browser.pause();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = await settledMemory();

  for (const pump of pumps) pump();
  const connection = observed[0];
  let last = -1;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const queued = queuedBytes(connection.browser);
    if (queued === last && connection.target.isPaused()) break;
    last = queued;
  }
  return (await settledMemory()) - before;
}

describe("retained memory toward the browser", () => {
  it("stays within the browser-ward bound while the browser stalls and the target floods one-byte writes", async () => {
    const runs = [
      await retainedTowardStalledBrowser(),
      await retainedTowardStalledBrowser(),
      await retainedTowardStalledBrowser(),
    ];
    expect(median(runs)).toBeLessThanOrEqual(SFTP_RELAY_BROWSER_BOUND_BYTES);
  }, 30_000);
});
