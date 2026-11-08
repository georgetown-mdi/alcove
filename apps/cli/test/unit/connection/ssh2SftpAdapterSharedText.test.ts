// The exact text, deadline and retry budget at every adapter call site that
// shares one builder or helper with another: the debug line naming a missing
// ssh2 member, the two teardown warnings the terminal and abandoned closes
// share, the keepalive deadline, the single-round-trip operations, and the
// data-operation retry budget. Each case pins the whole rendered string, so a
// site drifting from its siblings fails here.

import { describe, expect, test, vi } from "vitest";
import {
  TransportOperationStalledError,
  UsageError,
  sanitizeErrorForDisplay,
} from "@alcove/core";

import { REPORT_LIBRARY_INCOMPATIBILITY } from "../../../src/connection/libraryIncompatibility";
import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import { deadSessionOperationError } from "../../../src/connection/sftpAdapterWarnings";
import {
  SFTP_SLOW_OPERATION_WARNING_MS,
  SFTP_STALL_DEADLINE_MS,
  transportOperationStalledError,
} from "../../../src/connection/sftpLivenessGuard";
import {
  adapterLog,
  captureAdapterLog,
  ephemeralClient,
  installClient,
  protocolTempPath,
  wrapperMethods,
} from "./ssh2SftpAdapterFixtures";

const missingMemberDebug = (subject: string, member: string): string =>
  `${subject} drives ssh2's ${member}, which is not available after ` +
  `connect(); the installed ssh2 / ssh2-sftp-client version may have ` +
  `renamed, relocated, or removed it`;

const FORCED_CLOSE_FAILED =
  "Closing the SFTP connection from this side failed at teardown: socket " +
  "already destroyed. The connection is left to the operating system, may " +
  "stay half-open, and a half-open connection can keep this process from " +
  "exiting.";

const DESTROYED_NOT_CLOSED =
  "The SFTP connection's transport did not close after this side destroyed " +
  "it at teardown, so the connection may stay half-open, and a half-open " +
  "connection can keep this process from exiting. This build of Alcove may " +
  "not be compatible with the installed SFTP library; " +
  `${REPORT_LIBRARY_INCOMPATIBILITY}.`;

const SOCKET_NOT_EXPOSED_DEBUG =
  "the installed ssh2 may no longer expose the socket beneath its client";

const debugLines = (adapter: SSH2SFTPClientAdapter): string[] =>
  adapterLog(adapter).debug.mock.calls.map((call: unknown[]) => call[0]);

const warnLines = (adapter: SSH2SFTPClientAdapter): string[] =>
  adapterLog(adapter).warn.mock.calls.map((call: unknown[]) => call[0]);

function connectedAdapter(options: { ephemeralSessions?: boolean } = {}) {
  const built = ephemeralClient(wrapperMethods());
  const adapter = new SSH2SFTPClientAdapter(options);
  captureAdapterLog(adapter);
  installClient(adapter, built.client);
  return { ...built, adapter };
}

describe("the debug line naming an ssh2 member this build cannot reach", () => {
  test("a connect that cannot close a later abandoned dial", async () => {
    const { adapter, rawClient } = connectedAdapter();
    delete (rawClient._sock as Record<string, unknown>).destroy;
    await expect(
      adapter.connect({ host: "h", maxReconnectAttempts: 0 }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(debugLines(adapter)).toContain(
      missingMemberDebug(
        "closing an abandoned dial from this side",
        "client._sock.destroy()",
      ),
    );
  });

  test("a connection-per-poll connect that cannot close its connection", async () => {
    const { adapter, rawClient } = connectedAdapter({
      ephemeralSessions: true,
    });
    delete rawClient.end;
    await expect(
      adapter.connect({ host: "h", maxReconnectAttempts: 0 }),
    ).rejects.toBeInstanceOf(UsageError);
    expect(debugLines(adapter)).toContain(
      missingMemberDebug(
        "closing an SFTP connection from this side",
        "client.end()",
      ),
    );
  });

  test("an idle release that cannot close its connection", async () => {
    const { adapter, rawClient } = connectedAdapter({
      ephemeralSessions: true,
    });
    await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
    delete rawClient.end;
    await expect(adapter.releaseForIdle()).rejects.toBeInstanceOf(UsageError);
    expect(debugLines(adapter)).toContain(
      missingMemberDebug(
        "closing an SFTP connection from this side",
        "client.end()",
      ),
    );
  });

  test("a dial the server left unanswered at the subsystem request", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, client, rawClient } = connectedAdapter();
      delete (rawClient._sock as Record<string, unknown>).destroy;
      client.connect.mockImplementation(
        () =>
          new Promise<void>(() => {
            rawClient.emit("ready");
          }),
      );
      const dial = adapter
        .connect({ host: "h", readyTimeout: 5_000, maxReconnectAttempts: 0 })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_001);
      await dial;
      expect(debugLines(adapter)).toContain(
        missingMemberDebug(
          "closing an abandoned dial from this side",
          "client._sock.destroy()",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("a recovery re-dial that cannot close the dropped session's transport", async () => {
    // A session still held over a transport the partner ended, which the
    // re-dial must close before it dials.
    const { adapter, client, socket } = connectedAdapter();
    await adapter.connect({ host: "h", maxReconnectAttempts: 2 });
    delete (socket as { destroy?: unknown }).destroy;
    socket.writableEnded = true;
    client.delete.mockRejectedValueOnce(
      new TransportOperationStalledError("SFTP file delete stalled"),
    );
    await expect(adapter.delete("/remote/x.json")).rejects.toBeInstanceOf(
      TransportOperationStalledError,
    );
    expect(warnLines(adapter)).toHaveLength(1);
    expect(debugLines(adapter)).toContain(
      missingMemberDebug("re-dialing", "client._sock.destroy()"),
    );
  });
});

describe("the teardown warnings the terminal and the abandoned close share", () => {
  type Socket = { destroy?: () => void; destroyed: boolean };

  const degraded = [
    {
      branch: "no destroy()",
      degrade: (socket: Socket) => {
        delete socket.destroy;
      },
      debug: missingMemberDebug(
        "closing from this side",
        "client._sock.destroy()",
      ),
    },
    {
      branch: "a destroy() that throws",
      degrade: (socket: Socket) => {
        socket.destroy = () => {
          throw new Error("socket already destroyed");
        };
      },
      warn: FORCED_CLOSE_FAILED,
    },
    {
      branch: "a destroy() that closes nothing",
      degrade: (socket: Socket) => {
        socket.destroy = () => {};
      },
      warn: DESTROYED_NOT_CLOSED,
      debug: SOCKET_NOT_EXPOSED_DEBUG,
    },
  ];

  test.each(degraded)(
    "the terminal close over $branch",
    async ({ degrade, warn, debug }) => {
      vi.useFakeTimers();
      try {
        const { adapter, client, rawClient } = connectedAdapter();
        await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
        client.end.mockRejectedValue(new Error("end failed"));
        degrade(rawClient._sock as Socket);
        const closing = adapter.end().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(10_000);
        await closing;
        expect(warnLines(adapter)).toHaveLength(1);
        if (warn !== undefined) expect(warnLines(adapter)).toEqual([warn]);
        if (debug !== undefined) expect(debugLines(adapter)).toContain(debug);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each(degraded)(
    "the abandoned teardown's close over $branch",
    async ({ degrade, warn, debug }) => {
      const { adapter, rawClient } = connectedAdapter();
      await adapter.connect({ host: "h", maxReconnectAttempts: 0 });
      degrade(rawClient._sock as Socket);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internals = adapter as any;
      internals.session.beginClose();
      internals.forceCloseAbandonedTeardown();
      expect(warnLines(adapter)).toHaveLength(1);
      if (warn !== undefined) expect(warnLines(adapter)).toEqual([warn]);
      if (debug !== undefined) expect(debugLines(adapter)).toContain(debug);
    },
  );
});

// The minimal adapter the single-round-trip cases drive: no dial, a client
// holding only what the operation calls.
function bareAdapter(client: Record<string, unknown>) {
  const adapter = new SSH2SFTPClientAdapter();
  captureAdapterLog(adapter);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).options = {};
  installClient(adapter, client);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const heartbeat = (adapter as any).heartbeat;
  const opStarted = vi.spyOn(heartbeat, "opStarted");
  return { adapter, opStarted };
}

const withheld = () => vi.fn(() => new Promise<never>(() => {}));

const stallText = (operation: string, path: string, response: string) =>
  sanitizeErrorForDisplay(
    transportOperationStalledError(
      operation,
      path,
      `did not complete within ${SFTP_STALL_DEADLINE_MS} ms (the server ` +
        `withheld the ${response} response)`,
    ),
  );

describe("the keepalive", () => {
  test("is bounded by the operation deadline and is not tracked", async () => {
    vi.useFakeTimers();
    try {
      const realPath = withheld();
      const { adapter, opStarted } = bareAdapter({ realPath });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pinging = (adapter as any).sendKeepalive().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS + 1);
      const error = await pinging;
      expect(error).toBeInstanceOf(TransportOperationStalledError);
      expect(sanitizeErrorForDisplay(error)).toBe(
        stallText("keepalive", ".", "realPath"),
      );
      expect(realPath).toHaveBeenCalledWith(".");
      expect(opStarted).not.toHaveBeenCalled();
      expect(warnLines(adapter)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("is refused on a killed session without reaching the server", async () => {
    const realPath = withheld();
    const { adapter } = bareAdapter({ realPath });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).fatalSftpError = new Error("bad packet");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await (adapter as any)
      .sendKeepalive()
      .catch((e: unknown) => e);
    expect(sanitizeErrorForDisplay(error)).toBe(
      sanitizeErrorForDisplay(
        deadSessionOperationError("keepalive", ".", "bad packet"),
      ),
    );
    expect(realPath).not.toHaveBeenCalled();
  });
});

const roundTrips = [
  {
    operation: "file delete",
    response: "delete",
    path: "/remote/x.json",
    client: (call: ReturnType<typeof withheld>) => ({ delete: call }),
    run: (adapter: SSH2SFTPClientAdapter) => adapter.delete("/remote/x.json"),
  },
  {
    operation: "existence check",
    response: "stat",
    path: "/remote/lock.json",
    client: (call: ReturnType<typeof withheld>) => ({ exists: call }),
    run: (adapter: SSH2SFTPClientAdapter) =>
      adapter.exists("/remote/lock.json"),
  },
  {
    operation: "size check",
    response: "stat",
    path: "/remote/out.json",
    client: (call: ReturnType<typeof withheld>) => ({ stat: call }),
    run: (adapter: SSH2SFTPClientAdapter): Promise<unknown> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).statSizeOnce("/remote/out.json"),
  },
  {
    operation: "exclusive create",
    response: "open, existence-check, or close",
    path: "/remote/lock",
    client: (call: ReturnType<typeof withheld>) => ({
      sftp: wrapperMethods({ open: call }),
    }),
    run: (adapter: SSH2SFTPClientAdapter) =>
      adapter.createExclusive("/remote/lock"),
  },
];

describe("a single-round-trip operation", () => {
  test.each(roundTrips)(
    "$operation is tracked, warned on when slow, and bounded by the deadline",
    async ({ operation, response, path, client, run }) => {
      vi.useFakeTimers();
      try {
        const call = withheld();
        const { adapter, opStarted } = bareAdapter(client(call));
        const pending = run(adapter).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(0);
        expect(call).toHaveBeenCalledOnce();
        expect(opStarted).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
        expect(warnLines(adapter)).toHaveLength(1);
        expect(warnLines(adapter)[0]).toContain(operation);
        expect(warnLines(adapter)[0]).toContain(path);
        await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS);
        const error = await pending;
        expect(error).toBeInstanceOf(TransportOperationStalledError);
        expect(sanitizeErrorForDisplay(error)).toBe(
          stallText(operation, path, response),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test.each(roundTrips)(
    "$operation is refused on a killed session before it is issued",
    async ({ operation, path, client, run }) => {
      const call = withheld();
      const { adapter, opStarted } = bareAdapter(client(call));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).fatalSftpError = new Error("bad packet");
      const error = await run(adapter).catch((e: unknown) => e);
      expect(sanitizeErrorForDisplay(error)).toBe(
        sanitizeErrorForDisplay(
          deadSessionOperationError(operation, path, "bad packet"),
        ),
      );
      expect(call).not.toHaveBeenCalled();
      expect(opStarted).not.toHaveBeenCalled();
    },
  );
});

describe("the data-operation retry budget", () => {
  const failure = () =>
    Object.assign(new Error("_op: Failure"), { code: 4 }) as Error;

  test.each([
    {
      operation: "put",
      client: (call: ReturnType<typeof vi.fn>) => ({ put: call }),
      run: (adapter: SSH2SFTPClientAdapter) =>
        adapter.put(Buffer.from("payload"), protocolTempPath(), {
          flags: "w",
        }),
    },
    {
      operation: "rename",
      client: (call: ReturnType<typeof vi.fn>) => ({ rename: call }),
      run: (adapter: SSH2SFTPClientAdapter) =>
        adapter.rename("/remote/a.json", "/remote/b.json"),
    },
  ])(
    "$operation re-issues a status-4 failure five times, 100 ms apart, by default",
    async ({ client, run }) => {
      vi.useFakeTimers();
      try {
        const call = vi.fn(async () => {
          throw failure();
        });
        const { adapter } = bareAdapter(client(call));
        const pending = run(adapter).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(0);
        expect(call).toHaveBeenCalledTimes(1);
        for (let attempt = 2; attempt <= 6; attempt++) {
          await vi.advanceTimersByTimeAsync(99);
          expect(call).toHaveBeenCalledTimes(attempt - 1);
          await vi.advanceTimersByTimeAsync(1);
          expect(call).toHaveBeenCalledTimes(attempt);
        }
        const error = await pending;
        expect((error as { code?: unknown }).code).toBe(4);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(call).toHaveBeenCalledTimes(6);
        expect(adapter.transportRetryCount).toBe(5);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("a slow chunk-list put reports the whole payload's byte count", async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = bareAdapter({ put: withheld() });
      const pending = adapter
        .put([Buffer.alloc(3), Buffer.alloc(4)], protocolTempPath(), {
          flags: "w",
        })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SFTP_SLOW_OPERATION_WARNING_MS + 1);
      expect(warnLines(adapter)).toHaveLength(1);
      expect(warnLines(adapter)[0]).toContain("(7 byte payload)");
      await vi.advanceTimersByTimeAsync(SFTP_STALL_DEADLINE_MS * 10);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
