import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BrowserSshClientClosedError,
  BrowserSshRelayClosedError,
} from "@psi/transport/browserSsh/browserSshErrors";
import {
  SSH_RELAY_MAX_MESSAGE_BYTES,
  SSH_RELAY_SEND_WINDOW_BYTES,
  SSH_RELAY_SEND_WINDOW_LOW_BYTES,
  SshRelayStream,
} from "@psi/transport/browserSsh/sshRelayStream";
import { Buffer } from "@psi/transport/browserSsh/sshLibrary";

import { FakeRelaySocket } from "./fakeRelaySocket";

async function openStream(): Promise<{
  socket: FakeRelaySocket;
  stream: SshRelayStream;
}> {
  const socket = new FakeRelaySocket();
  const opening = SshRelayStream.open("ws://relay.test/sftp", () => socket);
  socket.open();
  return { socket, stream: await opening };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SshRelayStream", () => {
  test("asks for binary messages as ArrayBuffers", async () => {
    const { socket } = await openStream();
    expect(socket.binaryType).toBe("arraybuffer");
  });

  test("splits a write at the relay's message cap", async () => {
    const { socket, stream } = await openStream();
    await stream.write(Buffer.alloc(2 * SSH_RELAY_MAX_MESSAGE_BYTES + 10, 7));
    expect(socket.sent.map((message) => message.length)).toEqual([
      SSH_RELAY_MAX_MESSAGE_BYTES,
      SSH_RELAY_MAX_MESSAGE_BYTES,
      10,
    ]);
  });

  test("holds a write while the send buffer is above the window, until it drains to the low mark", async () => {
    vi.useFakeTimers();
    const { socket, stream } = await openStream();
    socket.bufferedAmount = SSH_RELAY_SEND_WINDOW_BYTES + 1;
    let written = false;
    const writing = stream.write(Buffer.from([1])).then(() => {
      written = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(written).toBe(false);
    socket.bufferedAmount = SSH_RELAY_SEND_WINDOW_LOW_BYTES + 1;
    await vi.advanceTimersByTimeAsync(200);
    expect(written).toBe(false);
    socket.bufferedAmount = SSH_RELAY_SEND_WINDOW_LOW_BYTES;
    await vi.advanceTimersByTimeAsync(200);
    await writing;
    expect(socket.sent).toHaveLength(1);
  });

  test("delivers received bytes to reads", async () => {
    const { socket, stream } = await openStream();
    socket.receive(new Uint8Array([1, 2, 3, 4]));
    expect([...(await stream.read(2))!]).toEqual([1, 2]);
    expect([...(await stream.read(10))!]).toEqual([3, 4]);
  });

  test("ends reads on the relay's normal close", async () => {
    const { socket, stream } = await openStream();
    const reading = stream.read(4);
    socket.remoteClose(1000);
    await expect(reading).resolves.toBeNull();
    expect(stream.closeError).toBeNull();
  });

  test("fails reads and writes with the relay's close code", async () => {
    const { socket, stream } = await openStream();
    const reading = stream.read(4);
    socket.remoteClose(4001, "target unreachable");
    await expect(reading).rejects.toMatchObject({
      name: "BrowserSshRelayClosedError",
      code: 4001,
      reason: "target unreachable",
    });
    await expect(stream.write(Buffer.from([1]))).rejects.toBeInstanceOf(
      BrowserSshRelayClosedError,
    );
  });

  test("refuses a text message", async () => {
    const { socket, stream } = await openStream();
    const reading = stream.read(4);
    socket.receive("hello");
    await expect(reading).rejects.toThrow(/text message/);
  });

  test("ends the stream at a text message: closes the socket and never reads the bytes after it", async () => {
    const { socket, stream } = await openStream();
    socket.receive("hello");
    socket.receive(new Uint8Array([1, 2, 3]));
    socket.remoteClose(1000);
    expect(socket.closedWith).toBe(1000);
    await expect(stream.read(4)).rejects.toThrow(/text message/);
    await expect(stream.read(4)).rejects.toThrow(/text message/);
    await expect(stream.write(Buffer.from([1]))).rejects.toThrow(
      /text message/,
    );
  });

  test("rejects the open with the close code when the socket closes first", async () => {
    const socket = new FakeRelaySocket();
    const opening = SshRelayStream.open("ws://relay.test/sftp", () => socket);
    socket.remoteClose(1006);
    await expect(opening).rejects.toMatchObject({
      name: "BrowserSshRelayClosedError",
      code: 1006,
    });
  });

  test("closes the socket normally when the session closes the stream", async () => {
    const { socket, stream } = await openStream();
    await stream.close();
    expect(socket.closedWith).toBe(1000);
    await expect(stream.read(1)).rejects.toThrow();
  });

  test.each(["close", "dispose"] as const)(
    "fails a write after a local %s with this client's close",
    async (method) => {
      const { stream } = await openStream();
      await stream[method]();
      await expect(stream.write(Buffer.from([1]))).rejects.toBeInstanceOf(
        BrowserSshClientClosedError,
      );
    },
  );

  test("keeps the relay's close for a write after the relay closed and the client disposed", async () => {
    const { socket, stream } = await openStream();
    socket.remoteClose(4002, "idle");
    stream.dispose();
    await expect(stream.write(Buffer.from([1]))).rejects.toMatchObject({
      name: "BrowserSshRelayClosedError",
      code: 4002,
      reason: "idle",
    });
  });
});
