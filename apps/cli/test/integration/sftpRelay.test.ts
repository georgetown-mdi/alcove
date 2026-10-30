import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Server as TcpServer, Socket } from "node:net";

import { Client } from "ssh2";
import type { SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, createWebSocketStream } from "ws";

import { attachSftpRelay } from "@alcove/sftp-relay";
import type {
  SftpRelayConnectionSockets,
  SftpRelayOptions,
  SftpRelayTarget,
} from "@alcove/sftp-relay";
import {
  SFTP_RELAY_BUFFERED_BOUND_BYTES,
  SFTP_RELAY_MAX_MESSAGE_BYTES,
  SFTP_RELAY_PATH,
  SFTP_RELAY_SEND_BUFFER_HIGH_BYTES,
  SftpRelayCloseCode,
} from "@alcove/sftp-relay/protocol";

import {
  ensureNamespace,
  remotePath,
  serverAuth,
  sftpServer,
} from "../sftpServer/testContext";
import { waitFor } from "../support";

// The SFTP relay (packages/sftp-relay) against the suite's SFTP server, and
// against a loopback target the case controls where a check needs a target
// that stops reading, counts its connections, or closes on cue: S7's checks
// (docs/notes/web-websocket-transport.md, The spikes), each failing when its
// behavior breaks. The wire: docs/spec/SFTP_RELAY.md.

const APP_ORIGIN = "http://app.test:8080";
const CASE_TIMEOUT_MS = 30_000;
const SETTLE_MS = 200;
const MESSAGE_BYTES = 64 * 1024;
const BROWSER_WINDOW_BYTES = 4 * 1024 * 1024;
const PRESSURE_MS = 2_000;
// Far above what the loopback socket buffers and the relay's bound hold
// between them, and far below what an unbounded relay takes in PRESSURE_MS.
const TAKEN_CEILING_BYTES = 64 * 1024 * 1024;
// A client frame of one MESSAGE_BYTES message (RFC 6455, 5.2): two bytes, an
// 8-byte length and a 4-byte mask ahead of the payload.
const MESSAGE_FRAME_BYTES = MESSAGE_BYTES + 14;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Target {
  target: SftpRelayTarget;
  sockets: Socket[];
}

async function startTarget(onSocket?: (socket: Socket) => void) {
  const sockets: Socket[] = [];
  const server: TcpServer = createTcpServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    onSocket?.(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, "close");
  });
  const { port } = server.address() as AddressInfo;
  const started: Target = { target: { host: "127.0.0.1", port }, sockets };
  return started;
}

/**
 * One connection as the relay holds it, and the most bytes it has held for
 * each direction: read from the source's socket and not yet written into the
 * destination's. Toward the target the count assumes the browser sends only
 * MESSAGE_BYTES binary messages.
 */
interface RelayConnection extends SftpRelayConnectionSockets {
  forwardedToTarget: number;
  peaks: { toTarget: number; toBrowser: number };
  /** Read the held bytes now, as well as after each read. */
  sample(): void;
}

function trackConnection(sockets: SftpRelayConnectionSockets): RelayConnection {
  const { browserSocket, browser, target } = sockets;
  let readFromBrowser = 0;
  const connection: RelayConnection = {
    ...sockets,
    forwardedToTarget: 0,
    peaks: { toTarget: 0, toBrowser: 0 },
    sample() {
      const unparsed =
        readFromBrowser - connection.forwardedToTarget * MESSAGE_FRAME_BYTES;
      connection.peaks.toTarget = Math.max(
        connection.peaks.toTarget,
        browserSocket.readableLength + unparsed + target.writableLength,
      );
      connection.peaks.toBrowser = Math.max(
        connection.peaks.toBrowser,
        target.readableLength + browser.bufferedAmount,
      );
    },
  };
  // Registered after the relay's own listeners, so each runs once the relay
  // has forwarded what it read.
  browser.on("message", () => {
    connection.forwardedToTarget += 1;
  });
  browserSocket.on("data", (chunk: Buffer) => {
    readFromBrowser += chunk.length;
    connection.sample();
  });
  target.on("data", () => connection.sample());
  return connection;
}

interface Relay {
  url: string;
  faults: string[];
  connections: RelayConnection[];
  stop(): void;
}

async function startRelay(
  target: SftpRelayTarget,
  testing: Omit<NonNullable<SftpRelayOptions["testing"]>, "observer"> = {},
): Promise<Relay> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const faults: string[] = [];
  const connections: RelayConnection[] = [];
  const relay = attachSftpRelay(server, {
    target,
    allowedOrigins: [APP_ORIGIN],
    reportFault: (message) => faults.push(message),
    testing: {
      ...testing,
      observer: {
        connection: (sockets) => connections.push(trackConnection(sockets)),
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    relay.close();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${SFTP_RELAY_PATH}`,
    faults,
    connections,
    stop: () => relay.close(),
  };
}

function browser(
  url: string,
  headers: Record<string, string | string[]> = { Origin: APP_ORIGIN },
  protocols: string[] = [],
): WebSocket {
  const socket = new WebSocket(url, protocols, { headers });
  socket.on("error", () => {});
  cleanups.push(() => socket.terminate());
  return socket;
}

/** The status an upgrade was answered with: 101 when it opened. */
function upgradeStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) =>
    socket.once("close", (code) => resolve(code)),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

describe("SFTP and SSH through the relay", () => {
  it(
    "writes a file over SFTP to the suite's server and reads it back unchanged",
    async () => {
      const server = sftpServer();
      const relay = await startRelay({ host: server.host, port: server.port });
      const namespace = `sftp-relay-${randomBytes(4).toString("hex")}`;
      await ensureNamespace(server, namespace);
      const filePath = `${remotePath(server, namespace)}/through-relay.bin`;
      const content = randomBytes(1024 * 1024);

      const socket = browser(relay.url);
      expect(await upgradeStatus(socket)).toBe(101);
      const auth = serverAuth(server.usera);
      const client = new Client();
      cleanups.push(() => {
        client.end();
      });
      const ready = once(client, "ready");
      client.on("error", () => {});
      client.connect({
        sock: createWebSocketStream(socket),
        username: auth.username,
        password: auth.password,
        privateKey: auth.privateKey,
        hostVerifier: (key: Buffer) =>
          fingerprint(key) === auth.hostKeyFingerprint,
      });
      await ready;
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
        client.sftp((error, wrapper) =>
          error ? reject(error) : resolve(wrapper),
        ),
      );
      await new Promise<void>((resolve, reject) =>
        sftp.writeFile(filePath, content, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      const read = await new Promise<Buffer>((resolve, reject) =>
        sftp.readFile(filePath, (error, data) =>
          error ? reject(error) : resolve(data),
        ),
      );
      expect(read.equals(content)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("the Origin check", () => {
  it(
    "upgrades the allowed origin alone, refusing every other before a TCP connection opens",
    async () => {
      const { target, sockets } = await startTarget();
      const relay = await startRelay(target);
      const refused: Array<Record<string, string | string[]>> = [
        {},
        { Origin: "https://other.example" },
        { Origin: "null" },
        { Origin: `${APP_ORIGIN}.evil.example` },
        { Origin: `${APP_ORIGIN}/path` },
        { Origin: "http://APP.test:8080" },
        { Origin: [APP_ORIGIN, APP_ORIGIN] },
      ];
      for (const headers of refused) {
        expect(await upgradeStatus(browser(relay.url, headers))).toBe(403);
      }
      await settle();
      expect(sockets).toHaveLength(0);

      expect(await upgradeStatus(browser(relay.url))).toBe(101);
      await waitFor(() => sockets.length === 1, {
        timeoutMs: 5_000,
        what: "the allowed upgrade's TCP connection",
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "connects to the fixed target whatever the upgrade names",
    async () => {
      const fixed = await startTarget();
      const decoy = await startTarget();
      const relay = await startRelay(fixed.target);
      const decoyAddress = `${decoy.target.host}:${decoy.target.port}`;
      const socket = browser(
        `${relay.url}?target=${decoyAddress}&host=${decoy.target.host}&port=${decoy.target.port}`,
        { Origin: APP_ORIGIN, Host: decoyAddress },
        [decoyAddress.replace(/[:.]/g, "-")],
      );
      expect(await upgradeStatus(socket)).toBe(101);
      await waitFor(() => fixed.sockets.length === 1, {
        timeoutMs: 5_000,
        what: "the fixed target's connection",
      });
      await settle();
      expect(decoy.sockets).toHaveLength(0);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "refuses another path with 404 and opens no TCP connection",
    async () => {
      const { target, sockets } = await startTarget();
      const relay = await startRelay(target);
      const otherPath = relay.url.replace(SFTP_RELAY_PATH, "/relay");
      expect(await upgradeStatus(browser(otherPath))).toBe(404);
      await settle();
      expect(sockets).toHaveLength(0);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("backpressure", () => {
  it(
    "stops reading the browser while the target reads nothing, and delivers every byte once it reads",
    async () => {
      let received = 0;
      const { target, sockets } = await startTarget((socket) => {
        socket.pause();
        socket.on("data", (chunk: Buffer) => {
          received += chunk.length;
        });
      });
      const relay = await startRelay(target);
      const socket = browser(relay.url);
      expect(await upgradeStatus(socket)).toBe(101);
      const [connection] = relay.connections;
      const message = randomBytes(MESSAGE_BYTES);
      let queued = 0;
      const deadline = performance.now() + PRESSURE_MS;
      while (performance.now() < deadline) {
        while (socket.bufferedAmount < BROWSER_WINDOW_BYTES) {
          socket.send(message);
          queued += message.length;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        connection.sample();
      }
      const taken = queued - socket.bufferedAmount;

      expect(connection.peaks.toTarget).toBeGreaterThan(
        SFTP_RELAY_SEND_BUFFER_HIGH_BYTES,
      );
      expect(connection.peaks.toTarget).toBeLessThanOrEqual(
        SFTP_RELAY_BUFFERED_BOUND_BYTES,
      );
      expect(taken).toBeLessThan(TAKEN_CEILING_BYTES);

      sockets[0].resume();
      await waitFor(() => received === queued, {
        timeoutMs: 15_000,
        what: `every one of ${queued} bytes at the target`,
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "stops reading the target while the browser reads nothing, and delivers every byte once it reads",
    async () => {
      let written = 0;
      let writing = true;
      const chunk = randomBytes(1024 * 1024);
      const { target } = await startTarget((socket) => {
        const write = (): void => {
          while (writing && socket.write(chunk)) written += chunk.length;
          if (writing) {
            written += chunk.length;
            socket.once("drain", write);
          }
        };
        write();
      });
      const relay = await startRelay(target);
      const socket = browser(relay.url);
      let received = 0;
      socket.on("message", (data: Buffer) => {
        received += data.length;
      });
      expect(await upgradeStatus(socket)).toBe(101);
      socket.pause();
      const [connection] = relay.connections;
      const deadline = performance.now() + PRESSURE_MS;
      while (performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        connection.sample();
      }
      writing = false;

      expect(connection.peaks.toBrowser).toBeGreaterThan(
        SFTP_RELAY_SEND_BUFFER_HIGH_BYTES,
      );
      expect(connection.peaks.toBrowser).toBeLessThanOrEqual(
        SFTP_RELAY_BUFFERED_BOUND_BYTES,
      );
      expect(written).toBeLessThan(TAKEN_CEILING_BYTES);

      socket.resume();
      await waitFor(() => received === written, {
        timeoutMs: 15_000,
        what: `every one of ${written} bytes at the browser`,
      });
    },
    CASE_TIMEOUT_MS,
  );
});

describe("close mapping", () => {
  async function connected(
    onSocket?: (socket: Socket) => void,
    testing: Parameters<typeof startRelay>[1] = {},
  ) {
    const started = await startTarget(onSocket);
    const relay = await startRelay(started.target, testing);
    const socket = browser(relay.url);
    expect(await upgradeStatus(socket)).toBe(101);
    await waitFor(() => started.sockets.length === 1, {
      timeoutMs: 5_000,
      what: "the target's connection",
    });
    return { socket, relay, tcp: started.sockets[0] };
  }

  it(
    "ends the TCP connection on the browser's close",
    async () => {
      const { socket, tcp } = await connected();
      tcp.resume();
      const ended = once(tcp, "end");
      socket.close(1000);
      await ended;
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "ends the TCP connection when the browser's socket drops with no close frame",
    async () => {
      const { socket, tcp } = await connected();
      tcp.resume();
      const ended = once(tcp, "end");
      socket.terminate();
      await ended;
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "closes the WebSocket with 1000 behind the target's last bytes when the target ends",
    async () => {
      const { socket, tcp } = await connected();
      const last = randomBytes(1024);
      const messages: Buffer[] = [];
      socket.on("message", (data: Buffer) => messages.push(data));
      const code = closeCode(socket);
      tcp.end(last);
      expect(await code).toBe(SftpRelayCloseCode.targetClosed);
      expect(Buffer.concat(messages).equals(last)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "closes the WebSocket with 4000 when the target resets",
    async () => {
      const { socket, tcp } = await connected();
      const code = closeCode(socket);
      tcp.resetAndDestroy();
      expect(await code).toBe(SftpRelayCloseCode.targetFailed);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "closes the WebSocket with 4001 and reports once when the target refuses",
    async () => {
      const { target } = await startTarget();
      const unreachable = { host: target.host, port: target.port };
      // Released before the relay dials it, so the port refuses.
      await cleanups.pop()?.();
      const relay = await startRelay(unreachable);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const socket = browser(relay.url);
        const code = closeCode(socket);
        expect(await code).toBe(SftpRelayCloseCode.targetUnreachable);
      }
      expect(relay.faults).toHaveLength(1);
      expect(relay.faults[0]).toContain(`port ${unreachable.port}`);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "closes the WebSocket with 1003 on a text message and ends the TCP connection",
    async () => {
      const { socket, tcp } = await connected();
      tcp.resume();
      const ended = once(tcp, "end");
      const code = closeCode(socket);
      socket.send("SSH-2.0-text");
      expect(await code).toBe(SftpRelayCloseCode.textMessage);
      await ended;
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "closes the WebSocket with 1009 on a message above the cap and ends the TCP connection",
    async () => {
      const { socket, tcp } = await connected();
      tcp.resume();
      const ended = once(tcp, "end");
      const code = closeCode(socket);
      socket.send(Buffer.alloc(SFTP_RELAY_MAX_MESSAGE_BYTES + 1));
      expect(await code).toBe(SftpRelayCloseCode.messageTooBig);
      await ended;
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "closes every WebSocket with 1001 and drops every TCP connection when the relay stops",
    async () => {
      const { socket, relay, tcp } = await connected();
      tcp.resume();
      const code = closeCode(socket);
      const dropped = once(tcp, "close");
      relay.stop();
      expect(await code).toBe(SftpRelayCloseCode.goingAway);
      await dropped;
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "drops the TCP connection once its end has waited the close wait behind bytes the target does not read",
    async () => {
      const closeWaitMs = 300;
      const { socket, relay } = await connected((tcp) => tcp.pause(), {
        closeWaitMs,
      });
      const [connection] = relay.connections;
      const message = randomBytes(MESSAGE_BYTES);
      // One message at a time, so the relay is never held and reads the
      // close below.
      for (let sent = 0; connection.target.writableLength === 0; sent += 1) {
        if (sent * MESSAGE_BYTES > TAKEN_CEILING_BYTES) {
          throw new Error("the target's socket never queued a byte");
        }
        const forwarded = once(connection.browser, "message");
        socket.send(message);
        await forwarded;
      }
      expect(connection.target.writableLength).toBeLessThanOrEqual(
        SFTP_RELAY_SEND_BUFFER_HIGH_BYTES,
      );

      const relayClosed = once(connection.browser, "close");
      const targetDropped = once(connection.target, "close");
      socket.close(1000);
      await relayClosed;
      expect(connection.target.writableEnded).toBe(true);
      expect(connection.target.destroyed).toBe(false);
      const endedAt = performance.now();
      await targetDropped;
      expect(performance.now() - endedAt).toBeGreaterThan(closeWaitMs / 2);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("quotas and keepalive", () => {
  it(
    "refuses an upgrade above the connection cap with 503, opening no TCP connection, until one has closed",
    async () => {
      const { target, sockets } = await startTarget((tcp) => tcp.resume());
      const relay = await startRelay(target, { maxConnections: 2 });
      const first = browser(relay.url);
      expect(await upgradeStatus(first)).toBe(101);
      expect(await upgradeStatus(browser(relay.url))).toBe(101);
      expect(await upgradeStatus(browser(relay.url))).toBe(503);
      await settle();
      expect(sockets).toHaveLength(2);

      first.close(1000);
      await waitFor(
        async () => (await upgradeStatus(browser(relay.url))) === 101,
        {
          timeoutMs: 5_000,
          intervalMs: 50,
          what: "an upgrade once one closed",
        },
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "pings each WebSocket at the ping interval",
    async () => {
      const { target } = await startTarget();
      const relay = await startRelay(target, { pingIntervalMs: 50 });
      const socket = browser(relay.url);
      let pings = 0;
      socket.on("ping", () => {
        pings += 1;
      });
      expect(await upgradeStatus(socket)).toBe(101);
      await waitFor(() => pings >= 3, {
        timeoutMs: 5_000,
        what: "three pings",
      });
    },
    CASE_TIMEOUT_MS,
  );
});
