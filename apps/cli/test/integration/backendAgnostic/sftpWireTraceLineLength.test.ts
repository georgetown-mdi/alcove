import logLibrary from "loglevel";
import ssh2 from "ssh2";
import type { Connection } from "ssh2";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  setLogLevel,
} from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { SSH2SFTPClientAdapter } from "../../../src/connection/ssh2SftpAdapter";
import {
  SSH_WIRE_TRACE_LOGGER_NAME,
  SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH,
} from "../../../src/connection/sftpWireTrace";

// The line-length cap on the SSH trace, held against what the installed stack
// renders on a completed dial: its algorithm name-lists run past the display
// default, and none reaches the cap. Driven over an in-process ssh2 server, so
// no suite backend is involved.

const USERNAME = "trace-user";
const PASSWORD = "trace-length-probe-not-a-real-secret";

async function startServer(): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  const hostKey = ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 });
  const clients = new Set<Connection>();
  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "password" &&
        ctx.username === USERNAME &&
        ctx.password === PASSWORD
      )
        return ctx.accept();
      return ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        acceptSession().on("sftp", (acceptSftp) => {
          acceptSftp();
        });
      });
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      server.on("error", () => {});
      const address = server.address();
      if (typeof address !== "object" || !address)
        return reject(new Error("server reported no listen address"));
      resolve(address.port);
    });
  });
  return {
    port,
    async stop() {
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.stop();
});

/** Every SSH stack line a completed dial traced, without the log prefix. */
async function tracedStackLines(): Promise<string[]> {
  const previousLevel = logLibrary.getLevel();
  setLogLevel(logLibrary.levels.TRACE);
  try {
    const [failure, logs] = await withCapturedLogs(
      async () => {
        const adapter = new SSH2SFTPClientAdapter();
        try {
          await adapter.connect({
            host: "127.0.0.1",
            port: server.port,
            username: USERNAME,
            password: PASSWORD,
            readyTimeout: 5_000,
            maxReconnectAttempts: 0,
          });
          return undefined;
        } catch (err) {
          return err;
        } finally {
          await adapter.end().catch(() => {});
        }
      },
      () => true,
    );
    expect(failure).toBeUndefined();
    const marker = `[${SSH_WIRE_TRACE_LOGGER_NAME}] `;
    return logs
      .map((entry) => entry.message)
      .filter((message) => message.includes(marker))
      .map((message) => message.slice(message.indexOf(marker) + marker.length));
  } finally {
    setLogLevel(previousLevel);
  }
}

test("the stack's longest name-list line runs past the display default and fits the trace cap", async () => {
  const nameListLines = (await tracedStackLines()).filter((line) =>
    /^Handshake: \((local|remote)\) /.test(line),
  );
  expect(nameListLines.length).toBeGreaterThan(0);
  const longest = Math.max(...nameListLines.map((line) => line.length));
  expect(longest).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
  expect(longest).toBeLessThanOrEqual(SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH);
  expect(nameListLines.join("\n")).not.toContain(DISPLAY_TRUNCATION_MARKER);
});
