import { spawn } from "node:child_process";
import { once } from "node:events";
import { Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { connect as connectTcp, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  SIGNALING_HEADERS_TIMEOUT_MS,
  SIGNALING_PREHANDSHAKE_IDLE_MS,
  SIGNALING_REQUEST_TIMEOUT_MS,
} from "@alcove/peerjs-broker/standaloneUpgradeBounds";

import { SFTP_RELAY_PATH, SftpRelayCloseCode } from "../src/protocol.ts";

import type { ChildProcess } from "node:child_process";
import type { AddressInfo, Socket } from "node:net";

// The standalone runner as a process, between a real `ws` client and a
// loopback TCP target: what a deployment runs. The relay's behavior against
// the SFTP test server is apps/cli/test/integration/sftpRelay.test.ts.

const require = createRequire(import.meta.url);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const READY_LINE = /^alcove-sftp-relay (\d+)\n$/;
const START_TIMEOUT_MS = 20_000;
const ORIGIN = "https://app.example.org";

const cleanups: Array<() => void> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
});

// Reports the bounds on the runner's own HTTP server (`probeLine` below).
const SERVER_BOUNDS_PROBE = join(packageRoot, "test", "serverBoundsProbe.mjs");

function spawnRunner(
  argv: string[],
  { probeServerBounds = false } = {},
): ChildProcess {
  const env = probeServerBounds
    ? {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(SERVER_BOUNDS_PROBE).href}`,
      }
    : process.env;
  const child = spawn(
    process.execPath,
    [require.resolve("tsx/cli"), "src/standalone.ts", ...argv],
    { cwd: packageRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return child;
}

async function startRunner(argv: string[], { probeServerBounds = false } = {}) {
  const child = spawnRunner(argv, { probeServerBounds });
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ready line within ${START_TIMEOUT_MS} ms`)),
      START_TIMEOUT_MS,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = READY_LINE.exec(stdout);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`the runner exited ${code} before listening: ${stderr}`),
      );
    });
  });
  return {
    url: `ws://127.0.0.1:${port}${SFTP_RELAY_PATH}`,
    stderr: () => stderr,
    child,
  };
}

async function startTarget() {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.pipe(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, sockets };
}

/** Resolves once `condition` holds, polled every 10 ms, or rejects at `ms`. */
async function eventually(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** What the server bounds probe wrote about `subject`, once it has. */
async function probeLine(
  stderr: () => string,
  subject: "server" | "connection",
): Promise<unknown> {
  const prefix = `probe ${subject} `;
  const line = () =>
    stderr()
      .split("\n")
      .find((candidate) => candidate.startsWith(prefix));
  await eventually(() => line() !== undefined);
  return JSON.parse((line() ?? "").slice(prefix.length));
}

describe("the standalone runner", () => {
  it(
    "forwards an allowed origin's messages to its target and back, and refuses another origin",
    { timeout: 60_000 },
    async () => {
      const target = await startTarget();
      const runner = await startRunner([
        "--target",
        `127.0.0.1:${target.port}`,
        "--allowed-origin",
        ORIGIN,
      ]);

      const refused = new WebSocket(runner.url, {
        origin: "https://other.example",
      });
      const [, response] = await once(refused, "unexpected-response");
      expect(response.statusCode).toBe(403);

      const browser = new WebSocket(runner.url, { origin: ORIGIN });
      await once(browser, "open");
      const echoed = once(browser, "message");
      browser.send(Buffer.from("SSH-2.0-relay-test\r\n"));
      expect((await echoed)[0]).toEqual(Buffer.from("SSH-2.0-relay-test\r\n"));
      expect(target.sockets).toHaveLength(1);

      const closed = once(browser, "close");
      target.sockets[0].end();
      expect((await closed)[0]).toBe(SftpRelayCloseCode.targetClosed);
      expect(runner.stderr()).toMatch(
        new RegExp(
          `\\[INFO\\] \\[sftp-relay\\] forwarding to 127\\.0\\.0\\.1 port ${target.port} for ${ORIGIN.replace(/\./g, "\\.")}`,
        ),
      );

      runner.child.kill("SIGTERM");
      const [code] = await once(runner.child, "exit");
      expect(code).toBe(0);
    },
  );

  it(
    "answers a plain request with 404 and closes its connection",
    { timeout: 60_000 },
    async () => {
      const runner = await startRunner([
        "--target",
        "127.0.0.1:22",
        "--allowed-origin",
        ORIGIN,
      ]);
      const socket = connectTcp(Number(new URL(runner.url).port), "127.0.0.1");
      cleanups.push(() => socket.destroy());
      await once(socket, "connect");
      let answer = "";
      socket.on("data", (chunk: Buffer) => (answer += chunk.toString()));
      const sentAt = performance.now();
      socket.write("GET / HTTP/1.1\r\nHost: relay\r\n\r\n");
      await once(socket, "close");

      expect(answer).toMatch(/^HTTP\/1\.1 404 /);
      expect(answer).toMatch(/\r\nConnection: close\r\n/i);
      // Node's own keep-alive bound, which closes a kept connection.
      expect(performance.now() - sentAt).toBeLessThan(
        new HttpServer().keepAliveTimeout,
      );
    },
  );

  it(
    "applies the signaling broker's pre-upgrade bounds to its server",
    { timeout: 60_000 },
    async () => {
      const runner = await startRunner(
        ["--target", "127.0.0.1:22", "--allowed-origin", ORIGIN],
        { probeServerBounds: true },
      );
      expect(await probeLine(runner.stderr, "server")).toEqual({
        headersTimeout: SIGNALING_HEADERS_TIMEOUT_MS,
        requestTimeout: SIGNALING_REQUEST_TIMEOUT_MS,
        clientErrorListeners: 0,
      });
      const socket = connectTcp(Number(new URL(runner.url).port), "127.0.0.1");
      cleanups.push(() => socket.destroy());
      await once(socket, "connect");
      expect(await probeLine(runner.stderr, "connection")).toEqual({
        timeout: SIGNALING_PREHANDSHAKE_IDLE_MS,
      });
    },
  );

  it(
    "exits 64 naming the missing flag when it has no target",
    { timeout: 60_000 },
    async () => {
      const child = spawnRunner(["--allowed-origin", ORIGIN]);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const [code] = await once(child, "exit");
      expect(code).toBe(64);
      expect(stderr).toMatch(/\[ERROR\] \[sftp-relay\] --target is required/);
    },
  );
});
