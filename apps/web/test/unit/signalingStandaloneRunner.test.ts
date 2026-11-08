import { afterEach, describe, expect, test, vi } from "vitest";

import {
  UNAVAILABLE_EXIT_CODE,
  USAGE_EXIT_CODE,
  exitOnSignal,
  refuseToStart,
  writeDisplayableLine,
  writeLine,
} from "@alcove/peerjs-broker/standaloneRunner";
import { sanitizeForDisplay } from "@alcove/core/untrusted-text";

import type { Server } from "node:http";

// The runner code the broker and the two relays share, driven in process: the
// line each writes to stderr, the refusal to start, and the shutdown on a
// signal. The runners' own wiring of it is exercised against the real
// processes (apps/cli/test/integration/webrtc/brokerStandaloneSurface.test.ts
// for the broker, each relay's test/standalone.test.ts for the relays).

const LINE = /^\[([^\]]+)\] \[(INFO|WARN|ERROR)\] \[([^\]]+)\] (.*)\n$/s;

/** What `run` writes to stderr, one entry per write. */
function stderrOf(run: () => void): Array<string> {
  const writes: Array<string> = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return writes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the exit codes", () => {
  test("are the CLI's usage exit and the unavailable exit", () => {
    expect(USAGE_EXIT_CODE).toBe(64);
    expect(UNAVAILABLE_EXIT_CODE).toBe(69);
  });
});

describe("writeLine", () => {
  test("writes one timestamped line under the context and level", () => {
    const [line, ...rest] = stderrOf(() =>
      writeLine("websocket-relay", "WARN", "the key table is missing"),
    );
    expect(rest).toEqual([]);
    const match = LINE.exec(line);
    expect(match?.slice(2)).toEqual([
      "WARN",
      "websocket-relay",
      "the key table is missing",
    ]);
    const timestamp = match?.[1] ?? "";
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  test("escapes the raw text once", () => {
    const [line] = stderrOf(() =>
      writeLine("sftp-relay", "INFO", "a \\ b \u001b[31m\nc"),
    );
    expect(LINE.exec(line)?.[4]).toBe(String.raw`a \\ b \x1b[31m\x0ac`);
  });
});

describe("writeDisplayableLine", () => {
  test("writes text already escaped for display as it stands", () => {
    const escaped = sanitizeForDisplay("a \\ b \u001b[31m");
    const [line] = stderrOf(() =>
      writeDisplayableLine("peerjs-broker", "WARN", escaped),
    );
    expect(LINE.exec(line)?.slice(2)).toEqual([
      "WARN",
      "peerjs-broker",
      String.raw`a \\ b \x1b[31m`,
    ]);
  });
});

describe("refuseToStart", () => {
  test("writes the escaped message as an error line and exits with the code", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exited");
    });
    const [line] = stderrOf(() => {
      expect(() =>
        refuseToStart("peerjs-broker", "--port \u001b got", USAGE_EXIT_CODE),
      ).toThrow("exited");
    });
    expect(exit).toHaveBeenCalledWith(64);
    expect(LINE.exec(line)?.slice(2)).toEqual([
      "ERROR",
      "peerjs-broker",
      String.raw`--port \x1b got`,
    ]);
  });
});

describe("exitOnSignal", () => {
  /** The handlers `exitOnSignal` registered, by signal. */
  function registeredHandlers(
    server: Server,
    relay?: { close: () => void },
  ): Map<string, () => void> {
    const handlers = new Map<string, () => void>();
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: () => void,
    ) => {
      handlers.set(event, handler);
      return process;
    }) as never);
    exitOnSignal(server, relay);
    return handlers;
  }

  /** A server whose `close` records the call and completes when told to. */
  function fakeServer(order: Array<string> = []): {
    server: Server;
    finishClose: () => void;
  } {
    let onClosed: (() => void) | undefined;
    const server = {
      close: vi.fn((callback: () => void) => {
        order.push("server");
        onClosed = callback;
      }),
    } as unknown as Server;
    return { server, finishClose: () => onClosed?.() };
  }

  test.each(["SIGTERM", "SIGINT"])(
    "on %s closes the relay, then the server, and exits 0 once it has closed",
    (signal) => {
      vi.useFakeTimers();
      try {
        const exit = vi
          .spyOn(process, "exit")
          .mockImplementation((() => undefined) as never);
        const order: Array<string> = [];
        const { server, finishClose } = fakeServer(order);
        const relay = { close: vi.fn(() => order.push("relay")) };
        const handlers = registeredHandlers(server, relay);
        expect([...handlers.keys()]).toEqual(["SIGTERM", "SIGINT"]);

        handlers.get(signal)?.();
        expect(order).toEqual(["relay", "server"]);
        expect(exit).not.toHaveBeenCalled();
        finishClose();
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("closes the server alone when no relay is given", () => {
    // Fake timers, so the grace window cannot reach the real `process.exit`
    // once the mock below is restored.
    vi.useFakeTimers();
    try {
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const { server } = fakeServer();
      const handlers = registeredHandlers(server);
      expect(() => handlers.get("SIGTERM")?.()).not.toThrow();
      expect(server.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("exits 0 after the grace window when the server has not closed", () => {
    vi.useFakeTimers();
    try {
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const { server } = fakeServer();
      registeredHandlers(server).get("SIGTERM")?.();
      vi.advanceTimersByTime(499);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
