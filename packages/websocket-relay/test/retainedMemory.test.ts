import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { QUEUED_MESSAGE_OVERHEAD_BYTES } from "../src/forwarding.ts";
import { RELAY_QUEUED_BOUND_BYTES } from "../src/protocol.ts";

import { connect, connectInMemory, helloFrame, startRelay } from "./harness.ts";

import type { Duplex } from "node:stream";

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

/** Resolves once `read` has held one value for `quietMs`, or rejects at `ms`. */
async function unchangedFor(
  read: () => number,
  quietMs = 300,
  ms = 8000,
): Promise<void> {
  const deadline = Date.now() + ms;
  let last = read();
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    if (Date.now() > deadline) throw new Error(`not settled within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (read() !== last) {
      last = read();
      since = Date.now();
    }
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
    async function heldOnClose(): Promise<{
      heldBytes: number;
      forwardedOnClose: number;
    }> {
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
      await unchangedFor(() => forwarded);
      const base = forwarded;
      // The source closes; the relay forwards its read-ahead to the still
      // stalled reader, and that queue is held for the close wait.
      inviter.socket.terminate();
      await until(() => forwarded > base);
      await unchangedFor(() => forwarded);
      const heldBytes = (await settledMemory()) - before;
      serverSide.destroy();
      await relay.stop();
      running.pop();
      return { heldBytes, forwardedOnClose: forwarded - base };
    }
    const runs = [
      await heldOnClose(),
      await heldOnClose(),
      await heldOnClose(),
    ];
    for (const run of runs) expect(run.forwardedOnClose).toBeGreaterThan(0);
    expect(median(runs.map((run) => run.heldBytes))).toBeLessThanOrEqual(
      RELAY_QUEUED_BOUND_BYTES,
    );
  }, 30_000);

  it("holds no more memory for a queued ping answer than its counted size, not the read its ping arrived in", async () => {
    const payloadBytes = 125;
    const answerFrameBytes = 2 + payloadBytes;
    // A masked frame with an all-zero mask key.
    const frame = (opcode: number, payload: Buffer): Buffer =>
      Buffer.concat([
        Buffer.from([0x80 | opcode, 0x80 | payload.length, 0, 0, 0, 0]),
        payload,
      ]);
    const body = Buffer.alloc(payloadBytes, 0x63);
    // One ping followed by pong frames the relay does not answer, 32 KiB in
    // all: each read holds one answer's ping and a large remainder.
    const read = Buffer.concat([
      frame(0x9, body),
      ...Array.from({ length: 250 }, () => frame(0xa, body)),
    ]);
    async function retainedPerAnswer(): Promise<number> {
      const relay = await startRelay();
      running.push(relay);
      const { party, serverSide } = await connectInMemory(
        relay.server,
        relay.url,
        { recordServerWrites: false },
      );
      party.send(await helloFrame({ role: "inviter" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      party.socket.pause();
      const clientSide = (party.socket as unknown as { _socket: Duplex })
        ._socket;
      const before = await settledMemory();
      // More reads than answers fit under the high mark, each written on its
      // own after a pause.
      for (let index = 0; index < 1200; index += 1) {
        clientSide.write(Buffer.from(read));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const answers = Math.floor(serverSide.writableLength / answerFrameBytes);
      const retained = (await settledMemory()) - before;
      party.socket.terminate();
      await relay.stop();
      running.pop();
      expect(answers).toBeGreaterThan(500);
      return retained / answers;
    }
    const runs = [
      await retainedPerAnswer(),
      await retainedPerAnswer(),
      await retainedPerAnswer(),
    ];
    // An answer's counted size, with half the per-message allowance as margin
    // for the memory measurement's noise.
    const allowed = QUEUED_MESSAGE_OVERHEAD_BYTES * 1.5 + answerFrameBytes;
    expect(median(runs)).toBeLessThanOrEqual(allowed);
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
