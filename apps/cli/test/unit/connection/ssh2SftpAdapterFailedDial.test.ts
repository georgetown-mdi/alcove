// What a failed dial waits for, and closes, before its failure is reported, and
// what it leaves alone. The library behavior this rests on, and the adapter's
// re-dial after a refused one, are driven against a real server in
// test/integration/sftpStackPremises.test.ts and
// test/integration/sftpKexRedialPolicyFlip.test.ts.

import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import {
  adapterLog,
  captureAdapterLog,
  ephemeralClient,
  installClient,
  wrapperMethods,
} from "./ssh2SftpAdapterFixtures";

describe("the connection beneath a failed dial", () => {
  // The bound each wait takes, as ssh2SftpAdapter.ts holds it.
  const FORCED_CLOSE_BOUND_MS = 1_000;
  // A stand-in for the tick or two a real socket takes to reach the ssh2
  // Client's 'close', well inside that bound.
  const CLOSE_DELAY_MS = 200;

  // Node's flags as a real net.Socket sets them: destroy() reads `closed` and
  // `destroyed` true at once, and the Client's 'close' follows later.
  interface DialSocket {
    setKeepAlive: () => void;
    closed: boolean;
    destroyed: boolean;
    destroy: ReturnType<typeof vi.fn>;
  }

  const refusal = new Error(
    "getConnection: Handshake failed: no matching key exchange algorithm",
  );

  // An ssh2-sftp-client stand-in whose every dial is refused. `closesOnItsOwn`
  // is a connection that delivers its 'close' CLOSE_DELAY_MS after the refusal,
  // as a server that closes does; without it the close comes only after a
  // destroy. `destroyedAtRefusal` is a dial refused over a socket already
  // destroyed whose 'close' is still to come, as a handshake timeout or a reset
  // leaves it. `closedBeforeRefusal` is a dial whose 'close' was delivered
  // before its rejection reached the adapter. `opensSocket` false is a dial
  // refused before it replaced the socket it found, as a connect() over a live
  // session is.
  function refusingClient(
    options: {
      closesOnItsOwn?: boolean;
      destroyedAtRefusal?: boolean;
      closedBeforeRefusal?: boolean;
      opensSocket?: boolean;
      destroyThrows?: boolean;
    } = {},
  ) {
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const deliverClose = (): void => {
      setTimeout(() => rawClient.emit("close"), CLOSE_DELAY_MS);
    };
    const makeSocket = (): DialSocket => {
      const socket: DialSocket = {
        setKeepAlive: () => {},
        closed: false,
        destroyed: false,
        destroy: vi.fn(() => {
          if (options.destroyThrows === true)
            throw new Error("destroy unavailable");
          socket.closed = true;
          socket.destroyed = true;
          deliverClose();
        }),
      };
      return socket;
    };
    const foundSocket = makeSocket();
    const sockets: DialSocket[] = [];
    Object.assign(rawClient, { setNoDelay: vi.fn(), _sock: foundSocket });
    const connect = vi.fn(() => {
      if (options.opensSocket !== false) {
        const socket = makeSocket();
        sockets.push(socket);
        rawClient._sock = socket;
        if (
          options.destroyedAtRefusal === true ||
          options.closedBeforeRefusal === true
        ) {
          socket.closed = true;
          socket.destroyed = true;
        }
        if (options.closedBeforeRefusal === true) rawClient.emit("close");
        if (
          options.closesOnItsOwn === true ||
          options.destroyedAtRefusal === true
        )
          deliverClose();
      }
      return Promise.reject(refusal);
    });
    return {
      client: { connect, client: rawClient, sftp: null },
      rawClient,
      foundSocket,
      sockets,
    };
  }

  function loggedAdapter() {
    const adapter = new SSH2SFTPClientAdapter();
    captureAdapterLog(adapter);
    return { adapter, log: adapterLog(adapter) };
  }

  const dialOptions = {
    host: "h",
    readyTimeout: 5_000,
    maxReconnectAttempts: 0,
  };

  function trackedDial(adapter: SSH2SFTPClientAdapter): { outcome: unknown } {
    const dial: { outcome: unknown } = { outcome: "pending" };
    void adapter.connect(dialOptions).then(
      () => {
        dial.outcome = "connected";
      },
      (error: unknown) => {
        dial.outcome = error;
      },
    );
    return dial;
  }

  test("waits out a close the connection delivers on its own, destroying nothing", async () => {
    vi.useFakeTimers();
    try {
      const { client, sockets } = refusingClient({ closesOnItsOwn: true });
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      const dial = trackedDial(adapter);
      await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS - 1);
      expect(dial.outcome).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      expect(dial.outcome).toBe(refusal);
      expect(sockets[0]?.destroy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits for the close still to come on a socket already destroyed at the refusal", async () => {
    vi.useFakeTimers();
    try {
      const { client, sockets } = refusingClient({ destroyedAtRefusal: true });
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      const dial = trackedDial(adapter);
      await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS - 1);
      expect({
        outcome: dial.outcome,
        closed: sockets[0]?.closed,
      }).toEqual({ outcome: "pending", closed: true });

      await vi.advanceTimersByTimeAsync(1);
      expect(dial.outcome).toBe(refusal);
      expect(sockets[0]?.destroy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not wait when the dial's close was delivered before its refusal", async () => {
    vi.useFakeTimers();
    try {
      const { client, sockets } = refusingClient({ closedBeforeRefusal: true });
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      const dial = trackedDial(adapter);
      await vi.advanceTimersByTimeAsync(0);
      expect(dial.outcome).toBe(refusal);
      expect(sockets[0]?.destroy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("destroys a connection whose close does not come, and waits that close out", async () => {
    vi.useFakeTimers();
    try {
      const { client, foundSocket, sockets } = refusingClient();
      const { adapter } = loggedAdapter();
      installClient(adapter, client);

      const dial = trackedDial(adapter);
      await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS - 1);
      expect({
        outcome: dial.outcome,
        destroys: sockets[0]?.destroy.mock.calls.length,
      }).toEqual({ outcome: "pending", destroys: 0 });

      await vi.advanceTimersByTimeAsync(1);
      expect(sockets[0]?.destroy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS - 1);
      expect(dial.outcome).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      expect(dial.outcome).toBe(refusal);
      expect(foundSocket.destroy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("leaves alone a socket the dial did not open", async () => {
    const { client, foundSocket } = refusingClient({ opensSocket: false });
    const { adapter } = loggedAdapter();
    installClient(adapter, client);

    await expect(adapter.connect(dialOptions)).rejects.toBe(refusal);
    expect(foundSocket.destroy).not.toHaveBeenCalled();
  });

  test("warns when the destroy fails, and reports the dial's own failure", async () => {
    vi.useFakeTimers();
    try {
      const { client } = refusingClient({ destroyThrows: true });
      const { adapter, log } = loggedAdapter();
      installClient(adapter, client);

      const dial = trackedDial(adapter);
      await vi.advanceTimersByTimeAsync(FORCED_CLOSE_BOUND_MS);
      expect(dial.outcome).toBe(refusal);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0]?.[0]).toContain(
        "Closing the connection beneath a failed SFTP dial failed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // The adapter's persistent transport-lifecycle watch holds one 'end' and one
  // 'close' listener, so any 'close' listener beyond its 'end' count is one a
  // dial left behind.
  test("leaves no 'close' listener behind, refused or connected", async () => {
    vi.useFakeTimers();
    try {
      const refused = refusingClient({ closesOnItsOwn: true });
      const { adapter: refusedAdapter } = loggedAdapter();
      installClient(refusedAdapter, refused.client);
      const dial = trackedDial(refusedAdapter);
      await vi.advanceTimersByTimeAsync(CLOSE_DELAY_MS);
      expect(dial.outcome).toBe(refusal);

      const connected = ephemeralClient(wrapperMethods());
      const { adapter: connectedAdapter } = loggedAdapter();
      installClient(connectedAdapter, connected.client);
      await connectedAdapter.connect(dialOptions);

      expect({
        refused: refused.rawClient.listenerCount("close"),
        connected: connected.rawClient.listenerCount("close"),
      }).toEqual({
        refused: refused.rawClient.listenerCount("end"),
        connected: connected.rawClient.listenerCount("end"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
