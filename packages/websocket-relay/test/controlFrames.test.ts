import { once } from "node:events";
import { connect as connectTcp } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createControlFrameLimit } from "../src/controlFrames.ts";
import { RelayCloseCode, START_FRAME } from "../src/protocol.ts";

import {
  EXCHANGE_ID,
  OTHER_RELAY_KEY,
  RELAY_KEY,
  connect,
  forwardingParties,
  helloFrame,
  keyTableOf,
  startRelay,
} from "./harness.ts";

import type { Party, RunningRelay } from "./harness.ts";

const OTHER_EXCHANGE_ID = "exchange-2";

const running: RunningRelay[] = [];

async function relay(
  testing: NonNullable<Parameters<typeof startRelay>[0]>["testing"],
): Promise<RunningRelay> {
  const started = await startRelay({
    keyTable: keyTableOf({
      [EXCHANGE_ID]: RELAY_KEY,
      [OTHER_EXCHANGE_ID]: OTHER_RELAY_KEY,
    }),
    testing,
  });
  running.push(started);
  return started;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((started) => started.stop()));
});

async function pairedUnderOtherKey(
  url: string,
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
        exchangeId: OTHER_EXCHANGE_ID,
        relayKey: OTHER_RELAY_KEY,
      }),
    );
  }
  await inviter.receivedCount(1);
  await acceptor.receivedCount(1);
  return { inviter, acceptor };
}

async function expectForwarding(parties: {
  inviter: Party;
  acceptor: Party;
}): Promise<void> {
  const before = parties.acceptor.received.length;
  parties.inviter.send(Buffer.from("still forwarding"));
  expect((await parties.acceptor.receivedCount(before + 1))[before]).toEqual({
    binary: Buffer.from("still forwarding"),
  });
}

// Masked control frames with an empty payload, as a client sends them.
const PING_FRAME = Buffer.from([0x89, 0x80, 0, 0, 0, 0]);
const PONG_FRAME = Buffer.from([0x8a, 0x80, 0, 0, 0, 0]);

const CONTROL_FRAME_CLOSE = Buffer.from([0x88, 0x02, 0x0f, 0xab]);

/** A raw TCP client that has upgraded and sent no hello. */
async function upgradedRawSocket(url: string): Promise<{
  socket: ReturnType<typeof connectTcp>;
  received: Buffer[];
}> {
  const { hostname, port } = new URL(url);
  const socket = connectTcp(Number(port), hostname);
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(
    "GET /relay HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  const received: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => received.push(chunk));
  await once(socket, "data");
  return { socket, received };
}

describe("the control frame limit", () => {
  it("closes a socket past the limit with 4011 before its hello, while another pairing forwards", async () => {
    const { url } = await relay({ maxControlFrames: 4 });
    const other = await forwardingParties(url);
    const { socket, received } = await upgradedRawSocket(url);
    socket.write(Buffer.concat(Array(10_000).fill(PONG_FRAME)));
    await once(socket, "close");
    expect(Buffer.concat(received).includes(CONTROL_FRAME_CLOSE)).toBe(true);
    await expectForwarding(other);
  });

  it.each([
    ["ping", PING_FRAME],
    ["pong", PONG_FRAME],
  ] as const)(
    "closes and drops a socket once for one write of many %s frames past the limit",
    async (_frame, bytes) => {
      const { url } = await relay({ maxControlFrames: 4 });
      const { socket } = await upgradedRawSocket(url);
      const terminate = vi.spyOn(WebSocket.prototype, "terminate");
      const close = vi.spyOn(WebSocket.prototype, "close");
      socket.write(Buffer.concat(Array(10_000).fill(bytes)));
      await once(socket, "close");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(
        close.mock.calls.filter(
          ([code]) => code === RelayCloseCode.controlFrameLimit,
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["ping", "pong"] as const)(
    "closes an admitted socket past the limit on %s frames with 4011 and its partner with 4000, while another pairing forwards",
    async (frame) => {
      const { url } = await relay({ maxControlFrames: 4 });
      const other = await forwardingParties(url);
      const { inviter, acceptor } = await pairedUnderOtherKey(url);
      for (let sent = 0; sent < 5; sent += 1) inviter.socket[frame]();
      expect((await inviter.closed).code).toBe(
        RelayCloseCode.controlFrameLimit,
      );
      expect((await acceptor.closed).code).toBe(RelayCloseCode.partnerEnded);
      await expectForwarding(other);
    },
  );
});

describe("keepalive within the control frame limit", () => {
  it("keeps open a pairing of the command-line client's sockets, which answer every ping", async () => {
    const { url } = await relay({ maxControlFrames: 0, pingIntervalMs: 5 });
    const sockets = await Promise.all(
      (["inviter", "acceptor"] as const).map(async (role) => {
        const socket = new globalThis.WebSocket(url);
        socket.binaryType = "arraybuffer";
        await once(socket, "open");
        socket.send(await helloFrame({ role }));
        socket.send(START_FRAME);
        return socket;
      }),
    );
    const closes = sockets.map(
      (socket) =>
        new Promise<number>((resolve) =>
          socket.addEventListener("close", (event) => resolve(event.code)),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const delivered = new Promise<ArrayBuffer>((resolve) =>
      sockets[1].addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) resolve(event.data);
      }),
    );
    sockets[0].send(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await delivered)).toEqual(new Uint8Array([1, 2, 3]));
    for (const socket of sockets) socket.close(1000);
    expect(await Promise.all(closes)).toEqual([1000, 1000]);
  });

  it("keeps open a socket answering two of the relay's pings at once", async () => {
    const { url } = await relay({ maxControlFrames: 1, pingIntervalMs: 50 });
    const parties = await forwardingParties(url);
    parties.inviter.socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 120));
    parties.inviter.socket.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expectForwarding(parties);
  });
});

describe("a control frame limit", () => {
  function limitOf(max: number, closable = true) {
    const actions = {
      closable: vi.fn(() => closable),
      close: vi.fn(),
      terminate: vi.fn(),
    };
    return { limit: createControlFrameLimit(max, actions), actions };
  }

  it("closes at the first frame past the bound, drops at the next, and ignores every later one", () => {
    const { limit, actions } = limitOf(3);
    const admitted = Array.from({ length: 10_000 }, () => limit.admit("ping"));
    expect(admitted.filter(Boolean)).toHaveLength(3);
    expect(actions.close).toHaveBeenCalledTimes(1);
    expect(actions.terminate).toHaveBeenCalledTimes(1);
    expect(actions.closable).toHaveBeenCalledTimes(1);
  });

  it("drops once a socket that cannot be closed goes past the bound", () => {
    const { limit, actions } = limitOf(1, false);
    for (let sent = 0; sent < 100; sent += 1) limit.admit("pong");
    expect(actions.close).not.toHaveBeenCalled();
    expect(actions.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not count a pong answering a ping, up to two pings behind", () => {
    const { limit, actions } = limitOf(0);
    limit.pinged();
    limit.pinged();
    expect(limit.admit("pong")).toBe(true);
    expect(limit.admit("pong")).toBe(true);
    expect(actions.close).not.toHaveBeenCalled();
    expect(limit.admit("pong")).toBe(false);
    expect(actions.close).toHaveBeenCalledTimes(1);
  });

  it("closes a socket that ignored many pings after two more than the bound of pongs", () => {
    const max = 5;
    const { limit, actions } = limitOf(max);
    for (let pings = 0; pings < 1_000; pings += 1) limit.pinged();
    for (let pongs = 0; pongs < 2 + max; pongs += 1) {
      expect(limit.admit("pong")).toBe(true);
    }
    expect(actions.close).not.toHaveBeenCalled();
    expect(limit.admit("pong")).toBe(false);
    expect(actions.close).toHaveBeenCalledTimes(1);
  });

  it("counts a new interval from the relay's next ping", () => {
    const { limit, actions } = limitOf(2);
    limit.admit("ping");
    limit.admit("ping");
    limit.pinged();
    limit.admit("ping");
    limit.admit("ping");
    expect(actions.close).not.toHaveBeenCalled();
  });
});
