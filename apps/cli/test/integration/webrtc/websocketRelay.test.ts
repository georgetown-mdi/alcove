import { createHash } from "node:crypto";

import { afterAll, beforeAll, expect, test } from "vitest";

import {
  EncryptedMessageConnection,
  authenticateConnection,
  deriveRelayExchangeId,
  deriveRelayKey,
  generateSharedSecret,
  handshakeRoleForRendezvousRole,
} from "@alcove/core";

import { SEND_WINDOW_BYTES } from "../../../src/connection/webrtc/webrtcMessageConnection";
import { openWebSocketRelayMessageConnection } from "../../../src/connection/webrtc/websocketRelayConnection";
import { webSocketRelayDialFor } from "../../../src/connection/webrtc/websocketRelayDial";
import { startWebSocketRelayProcess } from "../../signaling/websocketRelayProcess";

import type {
  WebSocketRelayConnectionOptions,
  WebSocketRelayDial,
} from "../../../src/connection/webrtc/websocketRelayConnection";
import type { WebSocketRelayProcess } from "../../signaling/websocketRelayProcess";
import type { MessageConnection, RendezvousRole } from "@alcove/core";

/**
 * The CLI's relay transport end to end: two parties dialing the repository's
 * real WebSocket relay, run as a process over a key table of its own, with the
 * key exchange requesting the wrap and every later frame inside it.
 */

const SECRET = generateSharedSecret();
const UNENROLLED_SECRET = generateSharedSecret();

/** The relay's own per-message cap (packages/websocket-relay/src/protocol.ts). */
const RELAY_MAX_MESSAGE_BYTES = 16_384;

let relay: WebSocketRelayProcess;

function digest(value: unknown): string {
  if (!(value instanceof Uint8Array)) throw new Error("not a byte frame");
  return createHash("sha256").update(value).digest("hex");
}

beforeAll(async () => {
  relay = await startWebSocketRelayProcess({
    [await deriveRelayExchangeId(SECRET)]: await deriveRelayKey(SECRET),
  });
});

afterAll(async () => {
  await relay?.stop();
});

async function dialFor(
  role: RendezvousRole,
  secret = SECRET,
): Promise<WebSocketRelayDial> {
  const dial = await webSocketRelayDialFor(
    { websocketRelay: relay.url },
    secret,
    role,
  );
  if (dial === undefined) throw new Error("no relay dial");
  return dial;
}

/** Pair both parties through the relay and run the key exchange with the wrap requested. */
async function authenticatedPair(
  options: WebSocketRelayConnectionOptions = {},
): Promise<{ inviter: MessageConnection; acceptor: MessageConnection }> {
  const [inviterRaw, acceptorRaw] = await Promise.all([
    openWebSocketRelayMessageConnection(await dialFor("inviter"), options),
    openWebSocketRelayMessageConnection(await dialFor("acceptor"), options),
  ]);
  const authenticate = async (
    connection: MessageConnection,
    role: RendezvousRole,
  ): Promise<MessageConnection> => {
    const handshakeRole = handshakeRoleForRendezvousRole(role);
    const { sessionKey, applyEncryption } = await authenticateConnection(
      connection,
      { sharedSecret: SECRET },
      handshakeRole,
      true,
    );
    expect(applyEncryption).toBe(true);
    return EncryptedMessageConnection.create(
      connection,
      sessionKey,
      handshakeRole,
    );
  };
  const [inviter, acceptor] = await Promise.all([
    authenticate(inviterRaw, "inviter"),
    authenticate(acceptorRaw, "acceptor"),
  ]);
  return { inviter, acceptor };
}

test("two parties pair through the relay, exchange wrapped frames, and the close confirms delivery", async () => {
  const { inviter, acceptor } = await authenticatedPair();
  const large = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 7) % 256);

  await acceptor.send({ step: 1 });
  expect(await inviter.receive()).toEqual({ step: 1 });
  await inviter.send(large);
  expect(digest(await acceptor.receive())).toBe(digest(large));

  const final = new Uint8Array(4 * 1024 * 1024).map((_, i) => i % 253);
  await acceptor.send(final);
  const closing = acceptor.close();
  expect(digest(await inviter.receive())).toBe(digest(final));
  await expect(inviter.receive()).rejects.toThrow("peer connection closed");
  await inviter.close().catch(() => {});
  await expect(closing).resolves.toBeUndefined();
}, 60_000);

test("a sender the relay paces keeps its socket's buffer within the send window", async () => {
  let largestBuffered = 0;
  const socketFactory = (url: string): WebSocket => {
    const socket = new WebSocket(url);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (ArrayBuffer.isView(data))
        expect(data.byteLength).toBeLessThanOrEqual(RELAY_MAX_MESSAGE_BYTES);
      send(data);
      largestBuffered = Math.max(largestBuffered, socket.bufferedAmount);
    };
    return socket;
  };
  const { inviter, acceptor } = await authenticatedPair({ socketFactory });
  // Past the relay's 2,000,000-byte burst, so its byte rate holds the sender.
  const frames = 6;
  const frame = new Uint8Array(2 * 1024 * 1024);
  const started = Date.now();
  const receiving = (async () => {
    for (let i = 0; i < frames; i++) await acceptor.receive();
  })();
  for (let i = 0; i < frames; i++) await inviter.send(frame);
  await receiving;
  expect(Date.now() - started).toBeGreaterThan(3_000);
  expect(largestBuffered).toBeGreaterThanOrEqual(SEND_WINDOW_BYTES);
  expect(largestBuffered).toBeLessThanOrEqual(
    SEND_WINDOW_BYTES + RELAY_MAX_MESSAGE_BYTES,
  );
  const closing = inviter.close();
  await expect(acceptor.receive()).rejects.toThrow("peer connection closed");
  await acceptor.close().catch(() => {});
  await closing;
}, 60_000);

test("a relay that holds no key for the exchange refuses the hello with the enrollment step", async () => {
  await expect(
    openWebSocketRelayMessageConnection(
      await dialFor("inviter", UNENROLLED_SECRET),
    ),
  ).rejects.toThrow(
    `the WebSocket relay at ${relay.url} holds no key for this exchange`,
  );
});

test("a second socket in a role the relay already holds is refused as role taken", async () => {
  const controller = new AbortController();
  const first = openWebSocketRelayMessageConnection(await dialFor("inviter"), {
    signal: controller.signal,
  });
  const firstSettled = first.catch((err: unknown) => err);
  // The relay checks hellos in arrival order, so let the first one land.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await expect(
    openWebSocketRelayMessageConnection(await dialFor("inviter")),
  ).rejects.toThrow("already holds a connection in this side's role");
  controller.abort();
  await firstSettled;
});
