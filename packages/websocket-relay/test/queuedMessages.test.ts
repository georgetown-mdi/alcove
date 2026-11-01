import { afterEach, describe, expect, it } from "vitest";

import { QUEUED_MESSAGE_OVERHEAD_BYTES } from "../src/forwarding.ts";
import {
  RELAY_QUEUED_BOUND_BYTES,
  RELAY_QUEUE_LIMIT_BYTES,
  RELAY_SEND_BUFFER_HIGH_BYTES,
  RelayCloseCode,
} from "../src/protocol.ts";

import {
  connect,
  connectInMemory,
  helloFrame,
  keyTableOf,
  receivedInOrder,
  startRelay,
} from "./harness.ts";

import type { RendezvousRole } from "@alcove/core";

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

/** The message, counted from 1, whose queueing passes the queue limit. */
function messageThatPassesLimit(size: number): number {
  return Math.floor(RELAY_QUEUE_LIMIT_BYTES / chargedBytes(size)) + 1;
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
 * Pair exchange `index` with forwarding open, over TCP. The `stalled` party
 * is opened in memory instead and its socket paused, so it reads nothing
 * more and no kernel buffer takes what the relay sends it.
 */
async function pairing(
  { relay }: Watched,
  index: number,
  stalled: RendezvousRole | undefined,
): Promise<{ inviter: Party; acceptor: Party; writesToStalled: Buffer[] }> {
  let writesToStalled: Buffer[] = [];
  const open = async (role: RendezvousRole): Promise<Party> => {
    if (role !== stalled) return connect(relay.url);
    const connection = await connectInMemory(relay.server, relay.url);
    writesToStalled = connection.serverWrites;
    return connection.party;
  };
  const inviter = await open("inviter");
  const acceptor = await open("acceptor");
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
  if (stalled !== undefined) ({ inviter, acceptor })[stalled].socket.pause();
  return { inviter, acceptor, writesToStalled };
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
      const { inviter } = await pairing(watched, 0, "acceptor");
      const expected = messageThatPassesHighMark(size);
      const sent = await sendUntilHeld(watched, inviter, 0, size, 2 * expected);
      expect(sent).toBe(expected);
    },
  );

  it("queues each message and its frame header in memory of their own size, not inside a larger read or pool block", async () => {
    const watched = await watchedRelay(1);
    const { inviter, writesToStalled } = await pairing(watched, 0, "acceptor");
    const before = writesToStalled.length;
    // Messages small enough to share one read, and one that spans reads.
    for (const size of [1, 1, 1024, 1, 16_384, 1]) {
      inviter.send(Buffer.alloc(size, 0x61));
    }
    await until(() => watched.forwarded.get(keyOf(0)) === 6);
    const queued = writesToStalled.slice(before);
    expect(queued).toHaveLength(12);
    for (const chunk of queued) {
      expect(chunk.buffer.byteLength).toBe(chunk.length);
    }
  });

  it("holds each of four stalled pairings from one address at the same point as a pairing alone", async () => {
    const watched = await watchedRelay(4);
    const pairings = [];
    for (let index = 0; index < 4; index += 1) {
      pairings.push(await pairing(watched, index, "acceptor"));
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

  it("keeps a pairing whose reader drains flowing through small messages past the high mark", async () => {
    const watched = await watchedRelay(1);
    const { inviter, acceptor } = await pairing(watched, 0, undefined);
    const messages = Array.from(
      { length: messageThatPassesHighMark(1) },
      (_, index) => Buffer.from([index % 251]),
    );
    for (const message of messages) inviter.send(message);
    const received = await acceptor.receivedCount(2 + messages.length);
    expect(receivedInOrder(received.slice(2), messages)).toBe(true);
    await until(() => !watched.held.has(keyOf(0)));
  });
});

describe("the queue limit", () => {
  it.each(["inviter", "acceptor"] as const)(
    "ends the pairing once the %s's small messages toward a stalled reader count past the limit, with 4010 to it and 4000 to the reader behind what was queued",
    async (senderRole) => {
      const watched = await watchedRelay(1);
      const readerRole = senderRole === "inviter" ? "acceptor" : "inviter";
      const parties = await pairing(watched, 0, readerRole);
      const sender = parties[senderRole];
      const reader = parties[readerRole];
      // Sent at once, so the relay reads them in reads of 64 KiB, each
      // holding thousands, and the read that crosses the high mark crosses
      // the limit too.
      const messages = Array.from(
        { length: 20 * messageThatPassesHighMark(1) },
        (_, index) => Buffer.from([index % 251]),
      );
      for (const message of messages) sender.send(message);
      expect((await sender.closed).code).toBe(RelayCloseCode.queueLimit);
      reader.socket.resume();
      expect((await reader.closed).code).toBe(RelayCloseCode.partnerEnded);
      const forwarded = reader.received.slice(2);
      expect(forwarded).toHaveLength(messageThatPassesLimit(1));
      expect(
        receivedInOrder(forwarded, messages.slice(0, forwarded.length)),
      ).toBe(true);
      expect(forwarded.length * chargedBytes(1)).toBeLessThanOrEqual(
        RELAY_QUEUED_BOUND_BYTES,
      );
    },
  );

  it("counts each small message's overhead, so a flood of them toward a reader that drains passes the limit", async () => {
    const watched = await watchedRelay(1);
    const { inviter, acceptor } = await pairing(watched, 0, undefined);
    const count = 4 * messageThatPassesHighMark(1);
    for (let index = 0; index < count; index += 1) {
      inviter.send(Buffer.from([index % 251]));
    }
    expect((await inviter.closed).code).toBe(RelayCloseCode.queueLimit);
    expect((await acceptor.closed).code).toBe(RelayCloseCode.partnerEnded);
    const forwarded = acceptor.received.length - 2;
    expect(forwarded).toBeGreaterThanOrEqual(messageThatPassesLimit(1));
    expect(forwarded).toBeLessThan(count);
    // The payloads and headers forwarded are a small part of the limit: the
    // per-message overhead is what passed it.
    expect(forwarded * chargedBytes(1)).toBeGreaterThan(
      RELAY_QUEUE_LIMIT_BYTES,
    );
    expect(forwarded * (1 + 2)).toBeLessThan(RELAY_QUEUE_LIMIT_BYTES / 100);
  });

  it("leaves an honest pairing whose readers drain open: frames both ways in chunks of the framing's size, each with a short tail, then a clean close", async () => {
    const watched = await watchedRelay(1);
    const { inviter, acceptor } = await pairing(watched, 0, undefined);
    // 16,358 bytes: the framing's 16,300-byte chunk and its 58-byte envelope.
    const frames = (fill: number): Buffer[] =>
      Array.from({ length: 8 }, (_, frame) => [
        ...Array.from({ length: 16 }, () => Buffer.alloc(16_358, fill + frame)),
        Buffer.alloc(90, fill + frame),
      ]).flat();
    const fromInviter = frames(0);
    const fromAcceptor = frames(100);
    for (const message of fromInviter) inviter.send(message);
    for (const message of fromAcceptor) acceptor.send(message);
    const atAcceptor = await acceptor.receivedCount(2 + fromInviter.length);
    const atInviter = await inviter.receivedCount(2 + fromAcceptor.length);
    expect(receivedInOrder(atAcceptor.slice(2), fromInviter)).toBe(true);
    expect(receivedInOrder(atInviter.slice(2), fromAcceptor)).toBe(true);
    acceptor.socket.close(1000);
    expect((await inviter.closed).code).toBe(RelayCloseCode.normal);
  });
});
