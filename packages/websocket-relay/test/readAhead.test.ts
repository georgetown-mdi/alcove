import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { READ_CHUNK_OVERHEAD_BYTES } from "../src/forwarding.ts";
import {
  RELAY_PAUSED_READ_AHEAD_BYTES,
  RELAY_READ_HIGH_WATER_MARK_BYTES,
} from "../src/protocol.ts";
import { createWebSocketRelayServer } from "../src/relay.ts";

import type { Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";

// What a paused socket of the relay's HTTP server reads ahead, on the running
// Node: an upgraded socket is paused, as the relay pauses a held source, and
// a client then writes to it in one-byte TCP segments or in one large write.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A paused upgraded socket of `server`, and the client's end of it. */
async function pausedUpgrade(
  server: Server,
): Promise<{ upgraded: Duplex; client: Socket }> {
  const upgraded = new Promise<Duplex>((resolve) =>
    server.once("upgrade", (_request, socket: Duplex) => {
      socket.pause();
      resolve(socket);
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = connect((server.address() as AddressInfo).port, "127.0.0.1");
  client.setNoDelay(true);
  cleanups.push(() => {
    client.destroy();
    server.closeAllConnections();
    server.close();
  });
  await once(client, "connect");
  client.write(
    "GET /relay HTTP/1.1\r\nHost: relay.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  return { upgraded: await upgraded, client };
}

/** Write `count` one-byte segments, yielding between them so each arrives
 * as its own read. */
async function writeSegments(client: Socket, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    client.write(Buffer.from([0x82]));
    await new Promise((resolve) => setTimeout(resolve, index % 20 ? 0 : 1));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

describe("the paused read-ahead", () => {
  it("holds at most one read of one-byte segments on the relay's server", async () => {
    const { upgraded, client } = await pausedUpgrade(
      createWebSocketRelayServer(),
    );
    await writeSegments(client, 1000);
    // Each one-byte chunk is one byte of the buffer.
    const chunks = upgraded.readableLength;
    expect(chunks).toBeLessThanOrEqual(RELAY_READ_HIGH_WATER_MARK_BYTES + 1);
    expect(chunks * (1 + READ_CHUNK_OVERHEAD_BYTES)).toBeLessThanOrEqual(
      RELAY_PAUSED_READ_AHEAD_BYTES,
    );
  });

  it("measures something: Node's default server reads ahead every one of the segments", async () => {
    const { upgraded, client } = await pausedUpgrade(createServer());
    await writeSegments(client, 1000);
    expect(upgraded.readableLength).toBe(1000);
  });

  it("holds at most one 64 KiB read of a large write on the relay's server", async () => {
    const { upgraded, client } = await pausedUpgrade(
      createWebSocketRelayServer(),
    );
    client.write(Buffer.alloc(4 * 1024 * 1024, 0x82));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upgraded.readableLength).toBeGreaterThan(0);
    expect(upgraded.readableLength).toBeLessThanOrEqual(
      RELAY_READ_HIGH_WATER_MARK_BYTES + 64 * 1024,
    );
  });
});
