import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";
import { createServer } from "node:net";
import type { Server } from "node:net";

import { afterEach, expect, test } from "vitest";

import { NO_RELAY_CANDIDATE_GATHERED } from "../../../src/connection/webrtc/iceDiagnostics";
import { gatherRelayCandidate } from "../../../src/connection/webrtc/weriftPeer";
import { relayCheckTargets, runRelayChecks } from "../../../src/doctor/relay";

/**
 * `alcove doctor relay` against real werift peers: loopback sockets on
 * ephemeral ports stand in for a TURN server, so what the check reports, how
 * long it takes, and which transports werift tries are measured rather than
 * read from its source. Nothing here reaches the network.
 */

/** RFC 5389 section 6: the fixed header every STUN message opens with. */
const STUN_HEADER_BYTES = 20;
const STUN_MAGIC_COOKIE = 0x2112a442;
const ALLOCATE_REQUEST = 0x0003;
const ALLOCATE_ERROR_RESPONSE = 0x0113;
const ERROR_CODE_ATTRIBUTE = 0x0009;
const UNAUTHORIZED = 401;
const ERROR_REASON = Buffer.from("Unauthorized");

const CREDENTIAL = {
  username: "alcove",
  credential: "placeholder-not-a-secret",
};

/**
 * An allocate error response (401) to `request`, echoing its transaction id.
 * It names no realm or nonce, so werift does not retry with credentials.
 */
function allocateErrorResponse(request: Buffer): Buffer {
  const valueBytes = 4 + ERROR_REASON.length;
  const paddedValueBytes = Math.ceil(valueBytes / 4) * 4;
  const response = Buffer.alloc(STUN_HEADER_BYTES + 4 + paddedValueBytes);
  response.writeUInt16BE(ALLOCATE_ERROR_RESPONSE, 0);
  response.writeUInt16BE(4 + paddedValueBytes, 2);
  request.copy(response, 4, 4, STUN_HEADER_BYTES);
  response.writeUInt16BE(ERROR_CODE_ATTRIBUTE, STUN_HEADER_BYTES);
  response.writeUInt16BE(valueBytes, STUN_HEADER_BYTES + 2);
  response.writeUInt8(Math.floor(UNAUTHORIZED / 100), STUN_HEADER_BYTES + 6);
  response.writeUInt8(UNAUTHORIZED % 100, STUN_HEADER_BYTES + 7);
  ERROR_REASON.copy(response, STUN_HEADER_BYTES + 8);
  return response;
}

/** A loopback UDP socket standing in for a TURN server, counting what it is sent. */
interface LoopbackTurnSocket {
  port: number;
  allocateRequests: () => number;
}

const openSockets: Array<Socket> = [];
const openServers: Array<Server> = [];

afterEach(async () => {
  await Promise.all([
    ...openSockets
      .splice(0)
      .map((socket) => new Promise<void>((done) => socket.close(() => done()))),
    ...openServers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  ]);
});

/**
 * Bind a UDP socket on an ephemeral loopback port. With `refuse`, it answers
 * every allocate request with a 401; without it, it answers nothing.
 */
async function startTurnSocket(refuse: boolean): Promise<LoopbackTurnSocket> {
  const socket = createSocket("udp4");
  openSockets.push(socket);
  let allocateRequests = 0;
  socket.on("message", (message, from) => {
    if (
      message.length < STUN_HEADER_BYTES ||
      message.readUInt16BE(0) !== ALLOCATE_REQUEST ||
      message.readUInt32BE(4) !== STUN_MAGIC_COOKIE
    )
      return;
    allocateRequests += 1;
    if (refuse)
      socket.send(
        allocateErrorResponse(message),
        from.port,
        from.address,
        () => {
          // A peer closed before its answer landed has no request left to end.
        },
      );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return {
    port: socket.address().port,
    allocateRequests: () => allocateRequests,
  };
}

/**
 * Listen for TCP on `port`, closing each connection at once, and resolve
 * `connected` on the first one.
 */
async function listenTcp(
  port: number,
): Promise<{ connected: Promise<void>; connections: () => number }> {
  let connections = 0;
  let onConnection = (): void => undefined;
  const connected = new Promise<void>((resolve) => {
    onConnection = resolve;
  });
  const server = createServer((connection) => {
    connections += 1;
    connection.on("error", () => undefined);
    connection.destroy();
    onConnection();
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { connected, connections: () => connections };
}

function ownTarget(url: string) {
  return relayCheckTargets([{ source: "own", url, ...CREDENTIAL }], undefined);
}

test("a relay that answers each allocate request with a 401 is reported not reached", async () => {
  const relay = await startTurnSocket(true);
  const url = `turn:127.0.0.1:${relay.port}`;
  const started = Date.now();

  const report = await runRelayChecks(
    ownTarget(url),
    gatherRelayCandidate,
    10_000,
  );

  expect(Date.now() - started).toBeLessThan(5_000);
  expect(relay.allocateRequests()).toBeGreaterThanOrEqual(1);
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]).toMatchObject({ id: "turn_1", status: "fail", url });
  expect(report.checks[0]?.summary).toContain(NO_RELAY_CANDIDATE_GATHERED);
}, 15_000);

test("a relay that never answers is reported not reached when the bound expires, not after werift's own gathering", async () => {
  const relay = await startTurnSocket(false);
  const url = `turn:127.0.0.1:${relay.port}`;
  const started = Date.now();

  const report = await runRelayChecks(
    ownTarget(url),
    gatherRelayCandidate,
    2_000,
  );

  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(1_900);
  expect(elapsed).toBeLessThan(4_000);
  expect(relay.allocateRequests()).toBeGreaterThanOrEqual(1);
  expect(report.checks[0]).toMatchObject({ id: "turn_1", status: "fail", url });
  expect(report.checks[0]?.summary).toContain(NO_RELAY_CANDIDATE_GATHERED);
}, 15_000);

test.each(["", "?transport=udp"])(
  "a turn: url naming %j retries a refused UDP allocation over TCP to the same port",
  async (query) => {
    const relay = await startTurnSocket(true);
    const tcp = await listenTcp(relay.port);
    const bound = new AbortController();
    const ceiling = setTimeout(() => bound.abort(), 10_000);
    void tcp.connected.then(() => bound.abort());

    try {
      const gathered = await gatherRelayCandidate(
        { urls: `turn:127.0.0.1:${relay.port}${query}`, ...CREDENTIAL },
        bound.signal,
      );
      expect(gathered).toBe(false);
    } finally {
      clearTimeout(ceiling);
    }

    expect(relay.allocateRequests()).toBeGreaterThanOrEqual(1);
    expect(tcp.connections()).toBeGreaterThanOrEqual(1);
  },
  15_000,
);

test("a turn: url naming transport=tcp asks over TCP alone", async () => {
  const relay = await startTurnSocket(true);
  const tcp = await listenTcp(relay.port);
  const bound = new AbortController();
  const ceiling = setTimeout(() => bound.abort(), 10_000);
  void tcp.connected.then(() => bound.abort());

  try {
    await gatherRelayCandidate(
      { urls: `turn:127.0.0.1:${relay.port}?transport=tcp`, ...CREDENTIAL },
      bound.signal,
    );
  } finally {
    clearTimeout(ceiling);
  }

  expect(tcp.connections()).toBeGreaterThanOrEqual(1);
  expect(relay.allocateRequests()).toBe(0);
}, 15_000);
