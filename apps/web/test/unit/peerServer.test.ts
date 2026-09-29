import { createServer } from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import { registerServer } from "@httpServer";
import { usePeerServer } from "@peerServer";

import type { Server } from "node:http";

// The peer server is what attaches the signaling WebSocket's `upgrade`
// listener to the shared HTTP server. The console profile serves no
// signaling, so it must never start there, whatever request reaches it.

const servers: Array<Server> = [];

async function listeningServer(): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registerServer(server);
  return server;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  globalThis.peerServerInstance = undefined;
  globalThis.httpServer = undefined;
  for (const server of servers.splice(0))
    await new Promise((resolve) => server.close(resolve));
});

describe("usePeerServer", () => {
  test("refuses to start on the console profile and attaches no upgrade listener", async () => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
    vi.stubEnv("JOB_DATA_ROOT", "/var/lib/alcove-jobs");
    const server = await listeningServer();

    expect(() => usePeerServer()).toThrow(
      "the console profile serves no peer-coordination server",
    );
    expect(server.listenerCount("upgrade")).toBe(0);
    expect(globalThis.peerServerInstance).toBeUndefined();
  });

  test("starts on the hosted profile and attaches the upgrade listener", async () => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "");
    const server = await listeningServer();

    expect(usePeerServer()).toBeDefined();
    expect(server.listenerCount("upgrade")).toBe(1);
  });
});
