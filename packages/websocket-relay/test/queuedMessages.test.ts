import { afterEach, describe, expect, it } from "vitest";

import { QUEUED_MESSAGE_OVERHEAD_BYTES } from "../src/forwarding.ts";
import {
  RELAY_QUEUED_BOUND_BYTES,
  RELAY_SEND_BUFFER_HIGH_BYTES,
} from "../src/protocol.ts";

import {
  connect,
  connectInMemory,
  helloFrame,
  keyTableOf,
  receivedInOrder,
  startRelay,
} from "./harness.ts";

import type { Party, RunningRelay } from "./harness.ts";

const running: RunningRelay[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((started) => started.stop()));
});

/** The relay key of exchange `index`. */
function keyOf(index: number): string {
  return index.toString(16).padStart(2, "0").repeat(32);
}

/** The bytes the relay charges for one queued binary message of `size`:
 * the payload, the 2- or 4-byte header it writes, and the overhead. */
function chargedBytes(size: number): number {
  return size + (size < 126 ? 2 : 4) + QUEUED_MESSAGE_OVERHEAD_BYTES;
}

/** The message, counted from 1, whose queueing passes the high mark. */
function messageThatPassesHighMark(size: number): number {
  return Math.floor(RELAY_SEND_BUFFER_HIGH_BYTES / chargedBytes(size)) + 1;
}

/** Resolves once `condition` holds, checked every turn of the event loop. */
async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not met within ${ms} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Watched {
  relay: RunningRelay;
  /** Messages forwarded from each pairing's inviter, by pairing key. */
  forwarded: Map<string, number>;
  /** The pairing keys whose inviter is held for backpressure. */
  held: Set<string>;
}

async function watchedRelay(exchanges: number): Promise<Watched> {
  const forwarded = new Map<string, number>();
  const held = new Set<string>();
  const relay = await startRelay({
    keyTable: keyTableOf(
      Object.fromEntries(
        Array.from({ length: exchanges }, (_, index) => [
          `exchange-${index}`,
          keyOf(index),
        ]),
      ),
    ),
    testing: {
      observer: {
        forwarded: (key, from) => {
          if (from === "inviter") {
            forwarded.set(key, (forwarded.get(key) ?? 0) + 1);
          }
        },
        held: (role, reason, key) => {
          if (role === "inviter" && reason === "backpressure" && key) {
            held.add(key);
          }
        },
        released: (role, reason, key) => {
          if (role === "inviter" && reason === "backpressure" && key) {
            held.delete(key);
          }
        },
      },
    },
  });
  running.push(relay);
  return { relay, forwarded, held };
}

/**
 * Pair exchange `index` with forwarding open, the inviter over TCP. A
 * stalled acceptor is opened in memory and its socket paused, so it reads
 * nothing more and no kernel buffer takes what the relay sends it.
 */
async function pairing(
  { relay }: Watched,
  index: number,
  acceptorStalls: boolean,
): Promise<{ inviter: Party; acceptor: Party; writesToAcceptor: Buffer[] }> {
  const inviter = await connect(relay.url);
  let writesToAcceptor: Buffer[] = [];
  let acceptor: Party;
  if (acceptorStalls) {
    const connection = await connectInMemory(relay.server, relay.url);
    acceptor = connection.party;
    writesToAcceptor = connection.serverWrites;
  } else {
    acceptor = await connect(relay.url);
  }
  for (const [party, role] of [
    [inviter, "inviter"],
    [acceptor, "acceptor"],
  ] as const) {
    party.send(
      await helloFrame({
        role,
        exchangeId: `exchange-${index}`,
        relayKey: keyOf(index),
      }),
    );
  }
  await inviter.receivedCount(1);
  await acceptor.receivedCount(1);
  inviter.send('{"type":"start"}');
  acceptor.send('{"type":"start"}');
  await inviter.receivedCount(2);
  await acceptor.receivedCount(2);
  if (acceptorStalls) acceptor.socket.pause();
  return { inviter, acceptor, writesToAcceptor };
}

/**
 * Send messages of `size` one at a time, each once the one before has been
 * forwarded, until the relay holds the sender or `limit` have gone; resolves
 * to the count sent.
 */
async function sendUntilHeld(
  watched: Watched,
  inviter: Party,
  index: number,
  size: number,
  limit: number,
): Promise<number> {
  const key = keyOf(index);
  const message = Buffer.alloc(size, 0x61);
  let sent = 0;
  while (sent < limit && !watched.held.has(key)) {
    inviter.send(message);
    sent += 1;
    await until(() => watched.forwarded.get(key) === sent);
  }
  return sent;
}

describe("the queued-message bound", () => {
  it.each([1, 1024, 16_384])(
    "holds the sender of %i-byte messages once its stalled reader's queue, each message charged its overhead, passes the high mark",
    async (size) => {
      const watched = await watchedRelay(1);
      const { inviter } = await pairing(watched, 0, true);
      const expected = messageThatPassesHighMark(size);
      const sent = await sendUntilHeld(watched, inviter, 0, size, 2 * expected);
      expect(sent).toBe(expected);
    },
  );

  it("queues each message and its frame header in memory of their own size, not inside a larger read or pool block", async () => {
    const watched = await watchedRelay(1);
    const { inviter, writesToAcceptor } = await pairing(watched, 0, true);
    const before = writesToAcceptor.length;
    // Messages small enough to share one read, and one that spans reads.
    for (const size of [1, 1, 1024, 1, 16_384, 1]) {
      inviter.send(Buffer.alloc(size, 0x61));
    }
    await until(() => watched.forwarded.get(keyOf(0)) === 6);
    const queued = writesToAcceptor.slice(before);
    expect(queued).toHaveLength(12);
    for (const chunk of queued) {
      expect(chunk.buffer.byteLength).toBe(chunk.length);
    }
  });

  it("keeps a stalled reader's queue within the stated bound when its partner sends many small messages at once", async () => {
    const watched = await watchedRelay(1);
    const { inviter } = await pairing(watched, 0, true);
    const key = keyOf(0);
    const message = Buffer.alloc(1, 0x61);
    const count = 20 * messageThatPassesHighMark(1);
    for (let index = 0; index < count; index += 1) inviter.send(message);
    await until(() => watched.held.has(key));
    // The rest of the read that crossed the high mark is still forwarded.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const forwarded = watched.forwarded.get(key) ?? 0;
    expect(forwarded).toBeLessThan(count);
    expect(forwarded * chargedBytes(1)).toBeLessThanOrEqual(
      RELAY_QUEUED_BOUND_BYTES,
    );
  });

  it("holds each of four stalled pairings from one address at the same point as a pairing alone", async () => {
    const watched = await watchedRelay(4);
    const pairings = [];
    for (let index = 0; index < 4; index += 1) {
      pairings.push(await pairing(watched, index, true));
    }
    const expected = messageThatPassesHighMark(1024);
    const sent = [];
    for (const [index, { inviter }] of pairings.entries()) {
      sent.push(
        await sendUntilHeld(watched, inviter, index, 1024, 2 * expected),
      );
    }
    expect(sent).toEqual([expected, expected, expected, expected]);
    expect(watched.held.size).toBe(4);
  });

  it("keeps a pairing whose reader drains flowing through many small messages", async () => {
    const watched = await watchedRelay(1);
    const { inviter, acceptor } = await pairing(watched, 0, false);
    const messages = Array.from(
      { length: 4 * messageThatPassesHighMark(1) },
      (_, index) => Buffer.from([index % 251]),
    );
    for (const message of messages) inviter.send(message);
    const received = await acceptor.receivedCount(2 + messages.length);
    expect(receivedInOrder(received.slice(2), messages)).toBe(true);
    await until(() => !watched.held.has(keyOf(0)));
  });
});
