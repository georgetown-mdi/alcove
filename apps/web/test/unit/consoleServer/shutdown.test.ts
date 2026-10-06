import http from "node:http";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createCloseHooks,
  installGracefulShutdown,
  shutdownTimeoutMs,
} from "../../../server/console/shutdown";

import { waitFor } from "../../utils/waitFor";

import type { AddressInfo } from "node:net";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
let runnerListeners: Map<string, Array<NodeJS.SignalsListener>>;
const servers: Array<http.Server> = [];

// The test runner's own signal listeners are set aside, so an emitted signal
// reaches only the handlers under test.
beforeEach(() => {
  runnerListeners = new Map(
    SIGNALS.map((signal) => [
      signal,
      process.listeners(signal) as Array<NodeJS.SignalsListener>,
    ]),
  );
  for (const signal of SIGNALS) process.removeAllListeners(signal);
});

afterEach(() => {
  for (const signal of SIGNALS) {
    process.removeAllListeners(signal);
    for (const listener of runnerListeners.get(signal)!)
      process.on(signal, listener);
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** A loopback server whose every response stays open until the client goes. */
async function heldServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.flushHeaders();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

describe("shutdownTimeoutMs", () => {
  test.each([
    [undefined, DEFAULT_SHUTDOWN_TIMEOUT_MS],
    ["", DEFAULT_SHUTDOWN_TIMEOUT_MS],
    ["5000", 5000],
    [" 250 ", 250],
    ["0", DEFAULT_SHUTDOWN_TIMEOUT_MS],
    ["-1", DEFAULT_SHUTDOWN_TIMEOUT_MS],
    ["1e3", DEFAULT_SHUTDOWN_TIMEOUT_MS],
    ["30s", DEFAULT_SHUTDOWN_TIMEOUT_MS],
    ["99999999999999999999", DEFAULT_SHUTDOWN_TIMEOUT_MS],
  ])("SHUTDOWN_TIMEOUT_MS=%j is %d", (value, expected) => {
    expect(
      shutdownTimeoutMs(
        value === undefined ? {} : { SHUTDOWN_TIMEOUT_MS: value },
      ),
    ).toBe(expected);
  });
});

describe("installGracefulShutdown", () => {
  test("stops accepting, awaits the close hooks, then exits 0", async () => {
    const { server } = await heldServer();
    const order: Array<string> = [];
    const hooks = createCloseHooks();
    hooks.hook("close", () => {
      order.push(server.listening ? "hook-while-listening" : "hook");
      return Promise.resolve();
    });
    const exit = vi.fn((code: number) => order.push(`exit ${code}`));
    installGracefulShutdown(server, hooks, { timeoutMs: 5000, exit });
    process.emit("SIGTERM", "SIGTERM");
    await waitFor(() => exit.mock.calls.length > 0);
    expect(order).toEqual(["hook", "exit 0"]);
  });

  test("past the timeout, an open response and a stuck hook do not hold the exit", async () => {
    const { server, port } = await heldServer();
    const request = http.get({ host: "127.0.0.1", port, agent: false });
    const clientClosed = new Promise<void>((resolve) => {
      request.on("error", () => resolve());
      request.on("response", (response) => {
        response.on("close", () => resolve());
        response.resume();
      });
    });
    await new Promise<void>((resolve) =>
      request.on("response", () => resolve()),
    );
    const hooks = createCloseHooks();
    hooks.hook("close", () => new Promise<void>(() => undefined));
    const exit = vi.fn();
    installGracefulShutdown(server, hooks, { timeoutMs: 200, exit });
    const started = Date.now();
    process.emit("SIGINT", "SIGINT");
    await waitFor(() => exit.mock.calls.length > 0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(exit).toHaveBeenCalledWith(0);
    await clientClosed;
  });

  test("a hook that rejects is logged and the shutdown continues", async () => {
    const { server } = await heldServer();
    const hooks = createCloseHooks();
    const ran: Array<string> = [];
    hooks.hook("close", () => Promise.reject(new Error("hook failure")));
    hooks.hook("close", () => {
      ran.push("second");
      return Promise.resolve();
    });
    const exit = vi.fn();
    installGracefulShutdown(server, hooks, { timeoutMs: 5000, exit });
    process.emit("SIGTERM", "SIGTERM");
    await waitFor(() => exit.mock.calls.length > 0);
    expect(ran).toEqual(["second"]);
  });

  test("a repeated signal does not start a second shutdown", async () => {
    const { server } = await heldServer();
    const hooks = createCloseHooks();
    let hookRuns = 0;
    hooks.hook("close", async () => {
      hookRuns += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const exit = vi.fn();
    installGracefulShutdown(server, hooks, { timeoutMs: 5000, exit });
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGTERM", "SIGTERM");
    await waitFor(() => exit.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hookRuns).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
