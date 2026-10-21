import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import { openPeerMessageConnection } from "../../../src/psi/transport/peerMessageConnection.js";
import { openPeerRunConnection } from "../../../src/psi/transport/runConnection.js";

import type { PeerRunConnectionOptions } from "../../../src/psi/transport/runConnection.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type { MessageConnection } from "@alcove/core";

// The open itself is exercised in peerMessageConnection.test.ts; mocked here
// so the test holds it pending and settles it around the abort and the first
// frame.
vi.mock("../../../src/psi/transport/peerMessageConnection.js", () => ({
  openPeerMessageConnection: vi.fn(),
}));

const mockedOpen = vi.mocked(openPeerMessageConnection);

/** A PeerJS data channel whose `close` emits `close`, as a channel that has
 * not opened does, so a pending open can reject on it. */
class FakeConn extends EventEmitter {
  close = vi.fn(() => {
    this.emit("close");
  });
}

class FakePeer extends EventEmitter {
  disconnect = vi.fn();
  destroy = vi.fn();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const STUB_CONNECTION = { close: vi.fn() } as unknown as MessageConnection;

/** Open over a fresh fake peer and channel with the open held pending. */
function openPending(
  options: Omit<PeerRunConnectionOptions, "signal" | "onCloseOutcome"> & {
    signal?: AbortSignal;
  },
) {
  const peer = new FakePeer();
  const conn = new FakeConn();
  const opened = deferred<MessageConnection>();
  mockedOpen.mockReturnValue(opened.promise);
  const onCloseOutcome = vi.fn();
  const signal = options.signal ?? new AbortController().signal;
  const run = openPeerRunConnection(
    peer as unknown as Peer,
    conn as unknown as DataConnection,
    { ...options, signal, onCloseOutcome },
  );
  return { peer, conn, opened, run, signal, onCloseOutcome };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("openPeerRunConnection", () => {
  test("returns the opened connection and a release that only disconnects the peer", async () => {
    const { peer, conn, opened, run, signal, onCloseOutcome } = openPending({});

    expect(mockedOpen).toHaveBeenCalledWith(conn, { onCloseOutcome, signal });
    opened.resolve(STUB_CONNECTION);
    const { connection, release } = await run;

    expect(connection).toBe(STUB_CONNECTION);
    expect(peer.disconnect).not.toHaveBeenCalled();
    release();
    expect(peer.disconnect).toHaveBeenCalledTimes(1);
    expect(peer.destroy).not.toHaveBeenCalled();
    expect(conn.close).not.toHaveBeenCalled();
  });

  test("a failed open closes the channel and disconnects the peer before rejecting", async () => {
    const { peer, conn, opened, run } = openPending({});
    const failure = new Error("connection closed before open");

    opened.reject(failure);

    await expect(run).rejects.toBe(failure);
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(peer.disconnect).toHaveBeenCalledTimes(1);
  });

  describe("dropBrokerOnFirstFrame", () => {
    test("on: the first inbound frame disconnects the peer once, with the open still pending", async () => {
      const { peer, conn, opened, run } = openPending({
        dropBrokerOnFirstFrame: true,
      });

      expect(peer.disconnect).not.toHaveBeenCalled();
      conn.emit("data", "first frame");
      expect(peer.disconnect).toHaveBeenCalledTimes(1);
      conn.emit("data", "second frame");
      expect(peer.disconnect).toHaveBeenCalledTimes(1);
      expect(conn.close).not.toHaveBeenCalled();

      opened.resolve(STUB_CONNECTION);
      await run;
    });

    test("on: release detaches the first-frame listener before disconnecting", async () => {
      const { peer, conn, opened, run } = openPending({
        dropBrokerOnFirstFrame: true,
      });
      opened.resolve(STUB_CONNECTION);
      const { release } = await run;

      release();
      expect(peer.disconnect).toHaveBeenCalledTimes(1);
      expect(conn.listenerCount("data")).toBe(0);
      conn.emit("data", "late frame");
      expect(peer.disconnect).toHaveBeenCalledTimes(1);
    });

    test("off: an inbound frame leaves the peer connected", async () => {
      const { peer, conn, opened, run } = openPending({
        dropBrokerOnFirstFrame: false,
      });

      expect(conn.listenerCount("data")).toBe(0);
      conn.emit("data", "first frame");
      expect(peer.disconnect).not.toHaveBeenCalled();

      opened.resolve(STUB_CONNECTION);
      await run;
      expect(peer.disconnect).not.toHaveBeenCalled();
    });
  });

  describe("closeChannelOnAbort", () => {
    test("on: an abort while the open is pending closes the channel, disconnects the peer, and rejects", async () => {
      const controller = new AbortController();
      const { peer, conn, opened, run } = openPending({
        signal: controller.signal,
        dropBrokerOnFirstFrame: true,
        closeChannelOnAbort: true,
      });
      const closedBeforeOpen = new Error("connection closed before open");
      conn.once("close", () => opened.reject(closedBeforeOpen));

      await tick();
      expect(conn.close).not.toHaveBeenCalled();
      controller.abort();

      expect(conn.close).toHaveBeenCalledTimes(1);
      expect(peer.disconnect).toHaveBeenCalledTimes(1);
      expect(conn.listenerCount("data")).toBe(0);
      await expect(run).rejects.toBe(closedBeforeOpen);
      expect(conn.close).toHaveBeenCalledTimes(1);
      expect(peer.disconnect).toHaveBeenCalledTimes(1);
    });

    test("on: a signal already aborted refuses to open and frees the channel and the peer", async () => {
      const controller = new AbortController();
      controller.abort();
      const { peer, conn, run } = openPending({
        signal: controller.signal,
        closeChannelOnAbort: true,
      });

      await expect(run).rejects.toThrow(
        "opening the connection to the other party was aborted",
      );
      expect(mockedOpen).not.toHaveBeenCalled();
      expect(conn.close).toHaveBeenCalledTimes(1);
      expect(peer.disconnect).toHaveBeenCalledTimes(1);
    });

    test("on: an abort after the open settles leaves the channel to its owner", async () => {
      const controller = new AbortController();
      const { peer, conn, opened, run } = openPending({
        signal: controller.signal,
        closeChannelOnAbort: true,
      });
      opened.resolve(STUB_CONNECTION);
      await run;

      controller.abort();
      expect(conn.close).not.toHaveBeenCalled();
      expect(peer.disconnect).not.toHaveBeenCalled();
    });

    test("off: an abort while the open is pending waits for the open to settle", async () => {
      const controller = new AbortController();
      const { peer, conn, opened, run } = openPending({
        signal: controller.signal,
        closeChannelOnAbort: false,
      });

      await tick();
      controller.abort();
      expect(conn.close).not.toHaveBeenCalled();
      expect(peer.disconnect).not.toHaveBeenCalled();

      opened.resolve(STUB_CONNECTION);
      const { connection } = await run;
      expect(connection).toBe(STUB_CONNECTION);
      expect(conn.close).not.toHaveBeenCalled();
    });

    test("off: a signal already aborted still opens", async () => {
      const controller = new AbortController();
      controller.abort();
      const { conn, opened, run } = openPending({
        signal: controller.signal,
      });

      expect(mockedOpen).toHaveBeenCalledTimes(1);
      opened.resolve(STUB_CONNECTION);
      await expect(run).resolves.toMatchObject({
        connection: STUB_CONNECTION,
      });
      expect(conn.close).not.toHaveBeenCalled();
    });
  });
});
