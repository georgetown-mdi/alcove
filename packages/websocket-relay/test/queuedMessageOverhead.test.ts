import { describe, expect, it } from "vitest";

import { QUEUED_MESSAGE_OVERHEAD_BYTES } from "../src/forwarding.ts";

import { connect, connectInMemory, helloFrame, startRelay } from "./harness.ts";

// The memory a queued message holds beyond its payload, measured on the
// running Node and `ws`: the relay's marks and its queue limit are raised so
// every message stays queued toward a reader paused in memory, and the heap
// and buffer memory after a collection is compared before and after the
// messages.

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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const { heapUsed, external } = process.memoryUsage();
  return heapUsed + external;
}

/** Resolves once `condition` holds, checked every turn of the event loop. */
async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not met within ${ms} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The memory one queued message of `size` holds beyond its payload,
 * averaged over `count` messages. */
async function measuredOverhead(size: number, count: number): Promise<number> {
  let forwarded = 0;
  const relay = await startRelay({
    testing: {
      sendBufferHighBytes: Number.MAX_SAFE_INTEGER,
      sendBufferLowBytes: Number.MAX_SAFE_INTEGER,
      queueLimitBytes: Number.MAX_SAFE_INTEGER,
      bytesPerSecond: Number.MAX_SAFE_INTEGER,
      burstBytes: Number.MAX_SAFE_INTEGER,
      observer: { forwarded: () => (forwarded += 1) },
    },
  });
  const inviter = await connect(relay.url);
  const { party: acceptor, serverSide } = await connectInMemory(
    relay.server,
    relay.url,
    { recordServerWrites: false },
  );
  try {
    inviter.send(await helloFrame({ role: "inviter" }));
    acceptor.send(await helloFrame({ role: "acceptor" }));
    await inviter.receivedCount(1);
    await acceptor.receivedCount(1);
    inviter.send('{"type":"start"}');
    acceptor.send('{"type":"start"}');
    await inviter.receivedCount(2);
    await acceptor.receivedCount(2);
    acceptor.socket.pause();

    const message = Buffer.alloc(size, 0x61);
    const before = await settledMemory();
    for (let index = 0; index < count; index += 1) inviter.send(message);
    await until(
      () => forwarded === count && inviter.socket.bufferedAmount === 0,
    );
    const after = await settledMemory();
    return (after - before) / count - size;
  } finally {
    // The paused reader never answers the relay's close, so its queue is
    // dropped here rather than held into the next measurement.
    inviter.socket.terminate();
    acceptor.socket.terminate();
    serverSide.destroy();
    await relay.stop();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("the queued-message overhead", () => {
  it.each([
    [1, 50_000],
    [1024, 20_000],
    [16_384, 4_000],
  ])(
    "covers what a queued %i-byte message holds beyond its payload on this Node and ws",
    async (size, count) => {
      const runs = [];
      for (let run = 0; run < 3; run += 1) {
        runs.push(await measuredOverhead(size, count));
      }
      expect(median(runs)).toBeLessThanOrEqual(QUEUED_MESSAGE_OVERHEAD_BYTES);
    },
    60_000,
  );
});
