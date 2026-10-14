import net from "node:net";

import ssh2 from "ssh2";
import { expect, test } from "vitest";

import { waitFor } from "../../support";
import {
  createKexinitRecordingRelay,
  SSH_MSG_DISCONNECT,
} from "../kexOfferWire";

// The key-exchange offer relay against a dial that offers nothing. ssh2's client
// sends its SSH_MSG_KEXINIT only once the server's identification has arrived,
// so a dial it ends before then sends SSH_MSG_DISCONNECT as its first binary
// packet. The upstream here is a listener that never identifies itself, which
// holds the dial in that window until the client ends it.

/**
 * A listener that answers nothing, resolving once a connection's
 * identification line has arrived through the relay.
 */
async function startSilentListener(): Promise<{
  port: number;
  identified: Promise<void>;
  close: () => Promise<void>;
}> {
  let resolveIdentified!: () => void;
  const identified = new Promise<void>((resolve) => {
    resolveIdentified = resolve;
  });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.includes("\n")) resolveIdentified();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
  return {
    port,
    identified,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test("a dial ended before the server identifies itself is recorded as a DISCONNECT, not an offer", async () => {
  const upstream = await startSilentListener();
  const relay = createKexinitRecordingRelay({
    host: "127.0.0.1",
    port: upstream.port,
  });
  const client = new ssh2.Client();
  // ssh2 reports the dial it was told to end as a lost connection; that is
  // the point, and it must not reach the process as an unhandled error.
  client.on("error", () => {});
  const closed = new Promise<void>((resolve) => client.once("close", resolve));
  try {
    client.connect({
      host: "127.0.0.1",
      port: await relay.port,
      username: "unused",
      password: "unused",
      readyTimeout: 10_000,
    });
    await upstream.identified;
    client.end();
    await waitFor(() => relay.dials[0]?.firstMessage !== undefined, {
      what: "the dial's first binary packet through the relay",
      timeoutMs: 10_000,
    });
    await closed;

    expect(relay.accepted()).toBe(1);
    expect(relay.dials).toEqual([
      { upstreamPort: upstream.port, firstMessage: SSH_MSG_DISCONNECT },
    ]);
    expect(relay.offers).toEqual([]);
  } finally {
    client.destroy();
    await relay.close({ destroyLiveSessions: true });
    await upstream.close();
  }
});
