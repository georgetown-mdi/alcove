import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  PartnerNoShowError,
  waitForIncomingConnection,
} from "../../../src/psi/transport/waitForConnection.js";
import { recordRendezvousIds } from "../../../src/psi/transport/peerLogging.js";

import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

class FakePeer extends EventEmitter {}

function makePeer(): { fake: FakePeer; peer: Peer } {
  const fake = new FakePeer();
  return { fake, peer: fake as unknown as Peer };
}

describe("waitForIncomingConnection", () => {
  test("resolves with the first incoming connection", async () => {
    const { fake, peer } = makePeer();
    const promise = waitForIncomingConnection(peer, { timeoutMs: 1000 });

    const conn = { id: "c1" } as unknown as DataConnection;
    fake.emit("connection", conn);

    expect(await promise).toBe(conn);
  });

  test("rejects if no connection arrives within the timeout", async () => {
    const { peer } = makePeer();

    await expect(
      waitForIncomingConnection(peer, { timeoutMs: 10 }),
    ).rejects.toThrow("timed out waiting for the other party to connect");
  });

  test("a spent wait rejects as the no-show condition, not a generic error", async () => {
    // The inviter's half of the no-show: the whole wait ran with nobody arriving.
    // The distinct type is what lets a managed re-run record the benign "missed"
    // outcome instead of filing an absent partner as a transport fault.
    await expect(
      waitForIncomingConnection(makePeer().peer, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(PartnerNoShowError);
  });

  describe("with a deadline", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test("ends at that deadline and states it as the time the wait ended", async () => {
      vi.useFakeTimers();
      const until = new Date(Date.now() + 5000);
      const rejection = waitForIncomingConnection(makePeer().peer, {
        until,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(4999);
      let settled = false;
      void rejection.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const error = await rejection;
      expect(error).toBeInstanceOf(PartnerNoShowError);
      expect((error as PartnerNoShowError).waitedUntil).toBe(until);
      expect(Date.now()).toBe(until.getTime());
    });

    test("a deadline already passed ends the wait at once", async () => {
      await expect(
        waitForIncomingConnection(makePeer().peer, {
          until: new Date(Date.now() - 1000),
        }),
      ).rejects.toBeInstanceOf(PartnerNoShowError);
    });
  });

  test("an aborted wait is not the no-show condition", async () => {
    // The operator (or, later, a runner closing its window) stopped the wait; the
    // partner's absence was never established, so this must not be treated as a no-show.
    const controller = new AbortController();
    const promise = waitForIncomingConnection(makePeer().peer, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    const rejection = await promise.catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(PartnerNoShowError);
  });

  test("detaches the connection listener on timeout", async () => {
    const { fake, peer } = makePeer();

    await waitForIncomingConnection(peer, { timeoutMs: 10 }).catch(
      () => undefined,
    );

    expect(fake.listenerCount("connection")).toBe(0);
  });

  test("rejects and tears down when the signal aborts", async () => {
    const { fake, peer } = makePeer();
    const controller = new AbortController();

    const promise = waitForIncomingConnection(peer, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    expect(fake.listenerCount("connection")).toBe(0);
  });

  test("rejects immediately if the signal is already aborted", async () => {
    const { fake, peer } = makePeer();
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForIncomingConnection(peer, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(fake.listenerCount("connection")).toBe(0);
  });

  test("settles exactly once when a connection arrives after an abort", async () => {
    const { fake, peer } = makePeer();
    const controller = new AbortController();

    const promise = waitForIncomingConnection(peer, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    // A connection arriving after the abort must not overturn the settled
    // rejection: the settle-once guard already removed the listener.
    fake.emit("connection", { id: "late" });

    await expect(promise).rejects.toThrow("aborted");
  });

  /** An error as PeerJS emits one: an `Error` with its `type`. */
  function peerError(type: string, message: string): Error {
    return Object.assign(new Error(message), { type });
  }

  /** PeerJS leaving the coordination server: `error`, then `disconnected`. */
  function leaveCoordinationServer(fake: FakePeer, error: Error): Error {
    fake.emit("error", error);
    fake.emit("disconnected", "inviter-id");
    return error;
  }

  /** What PeerJS emits as its socket to the coordination server drops. */
  function dropCoordinationServer(fake: FakePeer): Error {
    return leaveCoordinationServer(
      fake,
      peerError("network", "Lost connection to server."),
    );
  }

  test("losing the coordination server reports a path failure and ends the wait with the peer's error", async () => {
    const { fake, peer } = makePeer();
    const failures: Array<string> = [];
    const promise = waitForIncomingConnection(peer, {
      timeoutMs: 10_000,
      onPathFailed: (failure) => failures.push(failure),
    });

    const lost = dropCoordinationServer(fake);
    expect(failures).toEqual(["signaling-unreachable"]);

    const rejection = await promise.catch((error: unknown) => error);
    expect(rejection).toBe(lost);
    expect(rejection).not.toBeInstanceOf(PartnerNoShowError);
    expect(fake.listenerCount("connection")).toBe(0);
    expect(fake.listenerCount("error")).toBe(0);
    expect(fake.listenerCount("disconnected")).toBe(0);
  });

  test("losing the coordination server ends a wait that takes no path failure", async () => {
    const { fake, peer } = makePeer();
    const promise = waitForIncomingConnection(peer, { timeoutMs: 10_000 });

    const lost = dropCoordinationServer(fake);

    await expect(promise).rejects.toBe(lost);
  });

  test.each(["network", "socket-error", "socket-closed"])(
    "a %s error before the disconnect is a path failure",
    async (type) => {
      const { fake, peer } = makePeer();
      const failures: Array<string> = [];
      const promise = waitForIncomingConnection(peer, {
        timeoutMs: 10_000,
        onPathFailed: (failure) => failures.push(failure),
      });

      const lost = leaveCoordinationServer(fake, peerError(type, "socket"));

      await expect(promise).rejects.toBe(lost);
      expect(failures).toEqual(["signaling-unreachable"]);
    },
  );

  // The PeerJS error type each refusal from the coordination server emits
  // before its disconnect: test/browser/relayFallback.test.ts drives the real
  // client through each.
  test.each([
    ["an ERROR message", "server-error", "the server refused the client"],
    ["ID-TAKEN", "unavailable-id", 'ID "inviter-id" is taken'],
    ["INVALID-KEY", "invalid-key", 'API KEY "peerjs" is invalid'],
    [
      "a frame over the signaling bound",
      "server-error",
      "the coordination server sent a frame larger than the limit",
    ],
  ])(
    "a refusal from the coordination server (%s) ends the wait with no path failure",
    async (_refusal, type, message) => {
      const { fake, peer } = makePeer();
      const failures: Array<string> = [];
      const promise = waitForIncomingConnection(peer, {
        timeoutMs: 10_000,
        onPathFailed: (failure) => failures.push(failure),
      });

      const refusal = leaveCoordinationServer(fake, peerError(type, message));

      const rejection = await promise.catch((error: unknown) => error);
      expect(rejection).toBe(refusal);
      expect(rejection).not.toBeInstanceOf(PartnerNoShowError);
      expect(failures).toEqual([]);
      expect(fake.listenerCount("error")).toBe(0);
      expect(fake.listenerCount("disconnected")).toBe(0);
    },
  );

  test("a disconnect with no error before it ends the wait with no path failure", async () => {
    const { fake, peer } = makePeer();
    const failures: Array<string> = [];
    const promise = waitForIncomingConnection(peer, {
      timeoutMs: 10_000,
      onPathFailed: (failure) => failures.push(failure),
    });

    fake.emit("disconnected", "inviter-id");

    const rejection = await promise.catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(PartnerNoShowError);
    expect((rejection as Error).message).toBe(
      "the connection to the coordination server closed while waiting for " +
        "the other party to connect",
    );
    expect(failures).toEqual([]);
  });

  test("the error the wait ends with has the peer's rendezvous ids redacted", async () => {
    const { fake, peer } = makePeer();
    recordRendezvousIds(fake, ["inviter-derived-id", "acceptor-derived-id"]);
    const promise = waitForIncomingConnection(peer, { timeoutMs: 10_000 });

    leaveCoordinationServer(
      fake,
      peerError(
        "unavailable-id",
        'ID "inviter-derived-id" is taken, for acceptor-derived-id',
      ),
    );

    const rejection = (await promise.catch((error: unknown) => error)) as Error;
    expect(rejection.message).toBe(
      'ID "[redacted-peer-id]" is taken, for [redacted-peer-id]',
    );
    expect(rejection.stack).not.toContain("derived-id");
    expect(rejection).toMatchObject({ type: "unavailable-id" });
  });

  test("a peer error before the partner's connection arrives does not end the wait", async () => {
    const { fake, peer } = makePeer();
    const promise = waitForIncomingConnection(peer, { timeoutMs: 10_000 });

    fake.emit(
      "error",
      Object.assign(new Error("negotiation"), { type: "webrtc" }),
    );
    const conn = { id: "c1" } as unknown as DataConnection;
    fake.emit("connection", conn);

    expect(await promise).toBe(conn);
  });
});
