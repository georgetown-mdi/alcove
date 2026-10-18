import { afterEach, describe, expect, it } from "vitest";

import WebSocket from "ws";

import {
  PAIRED_FRAME,
  RELAY_MAX_PAIRINGS,
  RelayCloseCode,
} from "../src/protocol.ts";

import {
  connect,
  eventually,
  forwardingParties,
  helloFrame,
  keyTableOf,
  receivedInOrder,
  startRelay,
} from "./harness.ts";

import type { Party, RunningRelay } from "./harness.ts";

const running: RunningRelay[] = [];

async function relay(
  options: Parameters<typeof startRelay>[0] = {},
): Promise<RunningRelay> {
  const started = await startRelay(options);
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((started) => started.stop()));
});

/** The relay key of exchange `index` in {@link manyExchanges}. */
function keyOf(index: number): string {
  return index.toString(16).padStart(2, "0").repeat(32);
}

/** A key table enrolling `count` exchanges, `exchange-0` onward. */
function manyExchanges(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `exchange-${index}`,
      keyOf(index),
    ]),
  );
}

async function pairUnder(
  url: string,
  index: number,
): Promise<{ inviter: Party; acceptor: Party }> {
  const inviter = await connect(url);
  const acceptor = await connect(url);
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
  return { inviter, acceptor };
}

describe("one pairing per key", () => {
  it("refuses any socket under a key whose pairing holds both roles", async () => {
    const { url } = await relay({ keyTable: keyTableOf(manyExchanges(1)) });
    await pairUnder(url, 0);
    for (const role of ["inviter", "acceptor"] as const) {
      const extra = await connect(url);
      extra.send(
        await helloFrame({
          role,
          exchangeId: "exchange-0",
          relayKey: keyOf(0),
        }),
      );
      expect((await extra.closed).code).toBe(RelayCloseCode.roleTaken);
    }
  });
});

describe("the concurrent-pairing cap", () => {
  it(`admits ${RELAY_MAX_PAIRINGS} pairings and refuses a hello that would start another`, async () => {
    const { url } = await relay({
      keyTable: keyTableOf(manyExchanges(RELAY_MAX_PAIRINGS + 1)),
    });
    for (let index = 0; index < RELAY_MAX_PAIRINGS; index += 1) {
      await pairUnder(url, index);
    }
    const over = await connect(url);
    over.send(
      await helloFrame({
        role: "inviter",
        exchangeId: `exchange-${RELAY_MAX_PAIRINGS}`,
        relayKey: keyOf(RELAY_MAX_PAIRINGS),
      }),
    );
    expect(await over.closed).toEqual({
      code: RelayCloseCode.relayFull,
      reason: "",
    });
  });

  it("counts a pairing from its first hello, admits its partner at the cap, and frees its place when it ends", async () => {
    const { url, connections } = await relay({
      keyTable: keyTableOf(manyExchanges(3)),
      testing: { maxPairings: 2 },
    });
    const waiting = await connect(url);
    waiting.send(
      await helloFrame({
        role: "inviter",
        exchangeId: "exchange-0",
        relayKey: keyOf(0),
      }),
    );
    const { inviter, acceptor } = await pairUnder(url, 1);

    const refused = await connect(url);
    refused.send(
      await helloFrame({
        role: "inviter",
        exchangeId: "exchange-2",
        relayKey: keyOf(2),
      }),
    );
    expect((await refused.closed).code).toBe(RelayCloseCode.relayFull);

    const partner = await connect(url);
    partner.send(
      await helloFrame({
        role: "acceptor",
        exchangeId: "exchange-0",
        relayKey: keyOf(0),
      }),
    );
    expect(await partner.receivedCount(1)).toEqual([{ text: PAIRED_FRAME }]);

    inviter.socket.close(1000);
    await acceptor.closed;
    await eventually(async () => (await connections()) === 2);
    const { inviter: admitted } = await pairUnder(url, 2);
    expect(admitted.received).toEqual([{ text: PAIRED_FRAME }]);
  });
});

describe("the per-pairing byte rate", () => {
  it("paces a party sending above the rate and does not disconnect it", async () => {
    const events: string[] = [];
    const bytesPerSecond = 400_000;
    const burstBytes = 32_768;
    const { url } = await relay({
      testing: {
        bytesPerSecond,
        burstBytes,
        observer: { held: (role, reason) => events.push(`${role} ${reason}`) },
      },
    });
    const { inviter, acceptor } = await forwardingParties(url);
    const messages = Array.from({ length: 40 }, (_, index) =>
      Buffer.alloc(16_000, index),
    );
    const total = messages.length * 16_000;
    const startedAt = performance.now();
    for (const message of messages) inviter.send(message);
    const received = await acceptor.receivedCount(2 + messages.length);
    const elapsedMs = performance.now() - startedAt;

    expect(receivedInOrder(received.slice(2), messages)).toBe(true);
    expect(events).toContain("inviter rate");
    // Up to three messages already read when a hold lands are still
    // forwarded, so the floor leaves room for them.
    const floorMs = ((total - burstBytes - 3 * 16_000) * 1000) / bytesPerSecond;
    expect(elapsedMs).toBeGreaterThanOrEqual(floorMs);
    expect(inviter.socket.readyState).toBe(WebSocket.OPEN);
    expect(acceptor.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("paces each direction on its own", async () => {
    const events: string[] = [];
    const { url } = await relay({
      testing: {
        bytesPerSecond: 100_000,
        burstBytes: 16_384,
        observer: { held: (role, reason) => events.push(`${role} ${reason}`) },
      },
    });
    const { inviter, acceptor } = await forwardingParties(url);
    for (let index = 0; index < 4; index += 1) {
      inviter.send(Buffer.alloc(16_000, index));
    }
    await eventually(() => events.includes("inviter rate"));
    acceptor.send(Buffer.alloc(16_000, 9));
    expect((await inviter.receivedCount(3))[2].binary?.length).toBe(16_000);
    expect(events).not.toContain("acceptor rate");
  });
});

describe("the idle bound", () => {
  it("closes both sockets of a pairing no message has crossed within the bound", async () => {
    const { url } = await relay({
      testing: { idleTimeoutMs: 300, pingIntervalMs: 50 },
    });
    const { inviter, acceptor } = await forwardingParties(url);
    const startedAt = performance.now();
    expect(await inviter.closed).toEqual({
      code: RelayCloseCode.idle,
      reason: "",
    });
    expect((await acceptor.closed).code).toBe(RelayCloseCode.idle);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
  });

  it("keeps a pairing that a message crosses within each bound", async () => {
    const { url } = await relay({
      testing: { idleTimeoutMs: 400, pingIntervalMs: 50 },
    });
    const { inviter, acceptor } = await forwardingParties(url);
    for (let round = 0; round < 8; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      (round % 2 === 0 ? inviter : acceptor).send(Buffer.from([round]));
    }
    expect(inviter.socket.readyState).toBe(WebSocket.OPEN);
    expect(acceptor.socket.readyState).toBe(WebSocket.OPEN);
    expect((await inviter.closed).code).toBe(RelayCloseCode.idle);
  });

  it("closes a party still waiting for its partner at the bound", async () => {
    const { url } = await relay({
      testing: { idleTimeoutMs: 200, pingIntervalMs: 50 },
    });
    const waiting = await connect(url);
    waiting.send(await helloFrame({ role: "inviter" }));
    expect((await waiting.closed).code).toBe(RelayCloseCode.idle);
  });
});
