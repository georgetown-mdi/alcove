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
  installClient,
} from "./ssh2SftpAdapterFixtures";

describe("the connection beneath a failed dial", () => {
  // The bound each wait takes, as ssh2SftpAdapter.ts holds it.
  const FORCED_CLOSE_BOUND_MS = 1_000;
  // A stand-in for the tick or two a real socket takes to reach the ssh2
  // Client's 'close', well inside that bound.
  const CLOSE_DELAY_MS = 200;

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
  // destroy. `opensSocket` false is a dial refused before it replaced the socket
  // it found, as a connect() over a live session is; `alreadyClosed` is a dial
  // whose connection had delivered its 'close' by the time it rejected.
  function refusingClient(
    options: {
      closesOnItsOwn?: boolean;
      opensSocket?: boolean;
      alreadyClosed?: boolean;
      destroyThrows?: boolean;
    } = {},
  ) {
    const rawClient = new EventEmitter() as EventEmitter &
      Record<string, unknown>;
    const deliverClose = (socket: DialSocket): void => {
      setTimeout(() => {
        socket.closed = true;
        rawClient.emit("close");
      }, CLOSE_DELAY_MS);
    };
    const makeSocket = (closed: boolean): DialSocket => {
      const socket: DialSocket = {
        setKeepAlive: () => {},
        closed,
        destroyed: closed,
        destroy: vi.fn(() => {
          if (options.destroyThrows === true)
            throw new Error("destroy unavailable");
          socket.destroyed = true;
          deliverClose(socket);
        }),
      };
      return socket;
    };
    const foundSocket = makeSocket(false);
    const sockets: DialSocket[] = [];
    Object.assign(rawClient, { setNoDelay: vi.fn(), _sock: foundSocket });
    const connect = vi.fn(() => {
      if (options.opensSocket !== false) {
        const socket = makeSocket(options.alreadyClosed === true);
        sockets.push(socket);
        rawClient._sock = socket;
        if (options.closesOnItsOwn === true) deliverClose(socket);
      }
      return Promise.reject(refusal);
    });
    return {
      client: { connect, client: rawClient, sftp: null },
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
      expect(sockets[0]?.closed).toBe(true);
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

  test("leaves alone a connection whose close was already delivered", async () => {
    const { client, sockets } = refusingClient({ alreadyClosed: true });
    const { adapter } = loggedAdapter();
    installClient(adapter, client);

    await expect(adapter.connect(dialOptions)).rejects.toBe(refusal);
    expect(sockets[0]?.destroy).not.toHaveBeenCalled();
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
});
