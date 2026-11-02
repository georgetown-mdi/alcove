import { once } from "node:events";
import { connect as connectTcp } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

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

// A masked pong frame with an empty payload, as a client sends it.
const PONG_FRAME = Buffer.from([0x8a, 0x80, 0, 0, 0, 0]);

describe("the control frame limit", () => {
  it("closes a socket past the limit with 4011 before its hello, while another pairing forwards", async () => {
    const { url } = await relay({ maxControlFrames: 4 });
    const other = await forwardingParties(url);
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
    socket.write(Buffer.concat(Array(10_000).fill(PONG_FRAME)));
    await once(socket, "close");
    const closeFrame = Buffer.from([0x88, 0x02, 0x0f, 0xab]);
    expect(Buffer.concat(received).includes(closeFrame)).toBe(true);
    await expectForwarding(other);
  });

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

  it("keeps open a socket answering a backlog of the relay's pings at once", async () => {
    const { url } = await relay({ maxControlFrames: 3, pingIntervalMs: 5 });
    const parties = await forwardingParties(url);
    parties.inviter.socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 200));
    parties.inviter.socket.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expectForwarding(parties);
  });
});
