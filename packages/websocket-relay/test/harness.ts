import { once } from "node:events";
import { createServer } from "node:http";
import { duplexPair } from "node:stream";

import WebSocket from "ws";

import { buildWebSocketRelayProof } from "@alcove/core";

import { RELAY_PATH } from "../src/protocol.ts";
import { attachWebSocketRelay } from "../src/relay.ts";

import type { RendezvousRole } from "@alcove/core";
import type { Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { ClientOptions } from "ws";

import type { RelayKeyTable } from "../src/keyTable.ts";
import type { WebSocketRelay, WebSocketRelayOptions } from "../src/relay.ts";

/** The relay key of the secret of bytes 0x00..0x1f (docs/spec/PROTOCOL.md). */
export const RELAY_KEY =
  "1d970dcfd9f445a4c83c4ee3b03845209f891b2931e8b7bb2b41a17dd2249a9e";

/** A key no exchange in {@link keyTableOf} is enrolled under by default. */
export const OTHER_RELAY_KEY = "fedcba9876543210".repeat(4);

export const EXCHANGE_ID = "exchange-1";

/** A key table holding `rows`, exchange id to relay key. */
export function keyTableOf(
  rows: Record<string, string> = { [EXCHANGE_ID]: RELAY_KEY },
): RelayKeyTable {
  return { lookup: (exchangeId) => rows[exchangeId] };
}

export interface RunningRelay {
  url: string;
  server: Server;
  relay: WebSocketRelay;
  faults: string[];
  /** Open TCP connections on the relay's server, upgraded sockets included. */
  connections(): Promise<number>;
  stop(): Promise<void>;
}

/** Start a relay on a loopback ephemeral port. */
export async function startRelay(
  options: Partial<WebSocketRelayOptions> = {},
): Promise<RunningRelay> {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const faults: string[] = [];
  const relay = attachWebSocketRelay(server, {
    keyTable: keyTableOf(),
    reportFault: (message) => faults.push(message),
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${RELAY_PATH}`,
    server,
    relay,
    faults,
    connections: () =>
      new Promise((resolve, reject) =>
        server.getConnections((error, count) =>
          error ? reject(error) : resolve(count),
        ),
      ),
    async stop() {
      relay.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export interface HelloOptions {
  role: RendezvousRole;
  exchangeId?: string;
  relayKey?: string;
  /** The role the hello claims, when it differs from the proof's. */
  claimedRole?: string;
  ttlSeconds?: number;
  now?: Date;
}

/** A hello frame as a party sends it. */
export async function helloFrame({
  role,
  exchangeId = EXCHANGE_ID,
  relayKey = RELAY_KEY,
  claimedRole = role,
  ttlSeconds = 60,
  now = new Date(),
}: HelloOptions): Promise<string> {
  const proof = await buildWebSocketRelayProof({
    relayKey,
    role,
    ttlSeconds,
    now,
  });
  return JSON.stringify({
    type: "hello",
    exchangeId,
    role: claimedRole,
    proof: new TextDecoder().decode(proof.message),
    tag: Buffer.from(proof.tag).toString("hex"),
  });
}

export interface Received {
  text?: string;
  binary?: Buffer;
}

export interface Closed {
  code: number;
  reason: string;
}

/** A party's socket, keeping every message and its close in order. */
export class Party {
  readonly received: Received[] = [];
  readonly closed: Promise<Closed>;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      const bytes = data as Buffer;
      this.received.push(
        isBinary ? { binary: bytes } : { text: bytes.toString() },
      );
      this.wake();
    });
    socket.on("error", () => {});
    this.closed = new Promise((resolve) =>
      socket.on("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
        this.wake();
      }),
    );
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  /** Resolves once `count` messages have arrived. */
  async receivedCount(count: number): Promise<Received[]> {
    while (this.received.length < count) {
      if (this.socket.readyState === WebSocket.CLOSED) {
        throw new Error(
          `the socket closed after ${this.received.length} of ${count} messages`,
        );
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.received.slice(0, count);
  }

  send(data: string | Buffer): void {
    this.socket.send(data);
  }
}

/** Open a socket to the relay. */
export async function connect(url: string): Promise<Party> {
  const socket = new WebSocket(url);
  const party = new Party(socket);
  await once(socket, "open");
  return party;
}

/** A party connected in memory, and every chunk the server wrote to it. */
export interface InMemoryConnection {
  party: Party;
  serverWrites: Buffer[];
}

/**
 * Open a socket to `server` over an in-memory stream in place of TCP, so
 * once the party's socket is paused the server's writes to it stay queued in
 * the server's socket, with no kernel buffer taking them.
 */
export async function connectInMemory(
  server: Server,
  url: string,
  options: ClientOptions = {},
): Promise<InMemoryConnection> {
  const [serverSide, clientSide] = duplexPair({ highWaterMark: 1 });
  const serverWrites: Buffer[] = [];
  const write = serverSide.write.bind(serverSide) as (
    ...args: unknown[]
  ) => boolean;
  serverSide.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (Buffer.isBuffer(chunk)) serverWrites.push(chunk);
    return write(chunk, ...rest);
  }) as typeof serverSide.write;
  server.emit("connection", serverSide);
  const socket = new WebSocket(url, {
    ...options,
    createConnection: () => clientSide as Socket,
  });
  const party = new Party(socket);
  await once(socket, "open");
  return { party, serverWrites };
}

/** Two parties whose hellos verified and who both received `paired`. */
export async function pairedParties(
  url: string,
): Promise<{ inviter: Party; acceptor: Party }> {
  const inviter = await connect(url);
  const acceptor = await connect(url);
  inviter.send(await helloFrame({ role: "inviter" }));
  acceptor.send(await helloFrame({ role: "acceptor" }));
  await inviter.receivedCount(1);
  await acceptor.receivedCount(1);
  return { inviter, acceptor };
}

/** Two parties with forwarding open between them. */
export async function forwardingParties(
  url: string,
): Promise<{ inviter: Party; acceptor: Party }> {
  const parties = await pairedParties(url);
  parties.inviter.send('{"type":"start"}');
  await parties.acceptor.receivedCount(2);
  parties.acceptor.send('{"type":"start"}');
  await parties.inviter.receivedCount(2);
  return parties;
}

/**
 * Whether `received` is exactly `messages`, each a binary message, in order.
 * Compared as bytes rather than by deep equality, which walks every byte as
 * an object property.
 */
export function receivedInOrder(
  received: ReadonlyArray<Received>,
  messages: ReadonlyArray<Buffer>,
): boolean {
  return (
    received.length === messages.length &&
    received.every(
      (message, index) => message.binary?.equals(messages[index]) === true,
    )
  );
}

/** Resolves once `condition` holds, polled every 10 ms, or rejects at `ms`. */
export async function eventually(
  condition: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
