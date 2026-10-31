import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { RELAY_QUEUED_BOUND_BYTES } from "../src/protocol.ts";

import { connect, connectInMemory, helloFrame, startRelay } from "./harness.ts";

import type { RunningRelay } from "./harness.ts";

const running: RunningRelay[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((started) => started.stop()));
});

const gc = (globalThis as { gc?: () => void }).gc;

/** Heap and buffer memory in use once collections have settled. */
async function settledMemory(): Promise<number> {
  if (gc === undefined) {
    throw new Error(
      "run with --expose-gc (packages/websocket-relay/vitest.config.ts)",
    );
  }
  for (let round = 0; round < 3; round += 1) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const { heapUsed, external } = process.memoryUsage();
  return heapUsed + external;
}

async function until(condition: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not met within ${ms} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

describe("retained memory", () => {
  it("answers a ping only once, the library's automatic reply off", async () => {
    const relay = await startRelay();
    running.push(relay);
    const socket = new WebSocket(relay.url);
    let pongs = 0;
    socket.on("pong", () => (pongs += 1));
    socket.on("error", () => {});
    await once(socket, "open");
    socket.send(await helloFrame({ role: "inviter" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.ping(Buffer.from("x"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pongs).toBe(1);
    socket.terminate();
  });

  it("keeps the queue toward a stalled reader within the bound when a held source closes", async () => {
    async function heldOnClose(): Promise<number> {
      let held = false;
      let forwarded = 0;
      const relay = await startRelay({
        testing: {
          pingIntervalMs: 100,
          observer: {
            held: (_r, reason) => reason === "backpressure" && (held = true),
            forwarded: () => (forwarded += 1),
          },
        },
      });
      running.push(relay);
      const inviter = await connect(relay.url);
      const { party: acceptor, serverSide } = await connectInMemory(
        relay.server,
        relay.url,
        { recordServerWrites: false },
      );
      inviter.send(await helloFrame({ role: "inviter" }));
      acceptor.send(await helloFrame({ role: "acceptor" }));
      await inviter.receivedCount(1);
      await acceptor.receivedCount(1);
      inviter.send('{"type":"start"}');
      acceptor.send('{"type":"start"}');
      await inviter.receivedCount(2);
      await acceptor.receivedCount(2);
      acceptor.socket.pause();

      const message = Buffer.alloc(1, 0x61);
      const before = await settledMemory();
      for (let index = 0; index < 40_000; index += 1) inviter.send(message);
      await until(() => held);
      // The source closes; the relay forwards its read-ahead to the still
      // stalled reader, and that queue is held for the close wait.
      inviter.socket.terminate();
      let last = -1;
      while (forwarded !== last) {
        last = forwarded;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const heldBytes = (await settledMemory()) - before;
      serverSide.destroy();
      await relay.stop();
      running.pop();
      return heldBytes;
    }
    const runs = [
      await heldOnClose(),
      await heldOnClose(),
      await heldOnClose(),
    ];
    expect(median(runs)).toBeLessThanOrEqual(RELAY_QUEUED_BOUND_BYTES);
  }, 30_000);

  it("bounds the memory held for replies to a socket that sends pings and never reads", async () => {
    async function retainedAfterPings(): Promise<number> {
      const relay = await startRelay();
      running.push(relay);
      const socket = new WebSocket(relay.url);
      socket.on("error", () => {});
      await once(socket, "open");
      socket.send(await helloFrame({ role: "inviter" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = await settledMemory();
      socket.pause();
      const payload = Buffer.alloc(125, 0x62);
      for (let round = 0; round < 4; round += 1) {
        for (let index = 0; index < 50_000; index += 1) socket.ping(payload);
        await until(() => socket.bufferedAmount === 0);
      }
      const retained = (await settledMemory()) - before;
      socket.terminate();
      await relay.stop();
      running.pop();
      return retained;
    }
    const runs = [
      await retainedAfterPings(),
      await retainedAfterPings(),
      await retainedAfterPings(),
    ];
    expect(median(runs)).toBeLessThanOrEqual(RELAY_QUEUED_BOUND_BYTES);
  }, 30_000);
});
