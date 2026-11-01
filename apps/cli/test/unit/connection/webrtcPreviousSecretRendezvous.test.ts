import { afterEach, expect, test } from "vitest";

import {
  ConnectionError,
  deriveRendezvousPeerId,
  failureCauseOf,
  generateSharedSecret,
} from "@alcove/core";

import {
  BROKER_MESSAGE,
  ID_TAKEN_MESSAGE,
} from "../../../src/connection/webrtc/brokerClient";
import { openWebRtcPeerSession } from "../../../src/connection/webrtc/weriftPeer";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import { waitFor } from "../../support";

import type { WebRtcPeerSession } from "../../../src/connection/webrtc/weriftPeer";
import type { RTCPeerConnection } from "werift";

/**
 * The acceptor's wait while its key file holds a previous secret
 * (docs/spec/PROTOCOL.md, "WebRTC rendezvous peer-id derivation"): which ids
 * it registers under and offers to, which rendezvous carries the session, and
 * what ends the other. A scripted broker answers every registration, and a
 * scripted peer connection opens its channel on command.
 */

/** A broker socket that records what the client sent. */
class ScriptedSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly id: string) {}

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  register(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.emit("open", {});
    this.deliver({ type: BROKER_MESSAGE.open });
  }

  refuseIdTaken(): void {
    this.readyState = ScriptedSocket.OPEN;
    this.deliver({ type: BROKER_MESSAGE.idTaken });
  }

  deliver(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  offeredTo(): Array<unknown> {
    return this.sent
      .filter((frame) => frame.type === BROKER_MESSAGE.offer)
      .map((frame) => frame.dst);
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

class FakeChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  onopen: (() => void) | undefined;
  onclose: (() => void) | undefined;
  onmessage: ((event: { data: unknown }) => void) | undefined;
  onerror: ((event: { error: unknown }) => void) | undefined;

  constructor(readonly label: string) {}

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  send(): void {}
  close(): void {}
}

/** A peer connection stand-in: no ICE, no DTLS. */
class ScriptedPeer {
  onicecandidate: ((event: { candidate?: unknown }) => void) | undefined;
  onconnectionstatechange: (() => void) | undefined;
  ondatachannel: ((event: { channel: unknown }) => void) | undefined;
  connectionState = "connected";
  readonly channels: Array<FakeChannel> = [];
  closeCalls = 0;
  readonly sctp = { sctp: { outboundQueue: [], sentQueue: [] } };

  createDataChannel(label: string): FakeChannel {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: "offer", sdp: "v=0\r\noffer\r\n" });
  }

  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: "answer", sdp: "v=0\r\nanswer\r\n" });
  }

  localDescription: { type: string; sdp: string } | undefined;

  setLocalDescription(description: {
    type: string;
    sdp: string;
  }): Promise<void> {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(): Promise<void> {
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.connectionState = "closed";
    return Promise.resolve();
  }
}

const sessions: Array<WebRtcPeerSession> = [];
const teardowns: Array<AbortController> = [];

snapshotDiagnosticSinkAndLevel();

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const teardown of teardowns.splice(0)) teardown.abort();
});

interface Leg {
  socket: ScriptedSocket;
  peer: ScriptedPeer;
}

/**
 * Start a rendezvous with scripted transports. Each registration is answered
 * with `OPEN`, except under an id `refuse` names, which is refused as
 * `ID-TAKEN`. Resolves once `expectedRegistrations` sockets are wired.
 */
async function startRendezvous(options: {
  role: "inviter" | "acceptor";
  sharedSecret: string;
  previousSharedSecret?: string;
  rendezvousTimeoutMs?: number;
  refuse?: string;
  expectedRegistrations: number;
  onRegistered?: () => void;
}): Promise<{
  session: Promise<WebRtcPeerSession>;
  sockets: Array<ScriptedSocket>;
  /** The socket and peer connection of the rendezvous registered under `id`. */
  legUnder: (id: string) => Leg;
}> {
  const sockets: Array<ScriptedSocket> = [];
  const peers: Array<ScriptedPeer> = [];
  const teardown = new AbortController();
  teardowns.push(teardown);
  const session = openWebRtcPeerSession({
    location: {
      host: "127.0.0.1",
      port: 9000,
      path: "/api",
      key: "peerjs",
      secure: false,
    },
    role: options.role,
    sharedSecret: options.sharedSecret,
    ...(options.previousSharedSecret !== undefined && {
      previousSharedSecret: options.previousSharedSecret,
    }),
    iceServers: [{ urls: "stun:127.0.0.1:3478" }],
    rendezvousTimeoutMs: options.rendezvousTimeoutMs ?? 10_000,
    channelOpenTimeoutMs: 10_000,
    signal: teardown.signal,
    onRegistered: options.onRegistered,
    peerConnectionFactory: () => {
      const peer = new ScriptedPeer();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    socketFactory: (url) => {
      const id = new URL(url).searchParams.get("id") ?? "";
      const socket = new ScriptedSocket(id);
      sockets.push(socket);
      queueMicrotask(() =>
        id === options.refuse ? socket.refuseIdTaken() : socket.register(),
      );
      return socket as unknown as WebSocket;
    },
  });
  session.then(
    (value) => sessions.push(value),
    () => {},
  );
  await waitFor(() => sockets.length === options.expectedRegistrations, {
    timeoutMs: 5_000,
    intervalMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Each rendezvous builds its peer connection before it registers, so the
  // two lists line up in creation order.
  const legUnder = (id: string): Leg => {
    const index = sockets.findIndex((socket) => socket.id === id);
    if (index < 0) throw new Error(`no registration under ${id}`);
    return { socket: sockets[index]!, peer: peers[index]! };
  };
  return { session, sockets, legUnder };
}

async function idsOf(secret: string): Promise<{
  inviter: string;
  acceptor: string;
}> {
  const [inviter, acceptor] = await Promise.all([
    deriveRendezvousPeerId(secret, "inviter"),
    deriveRendezvousPeerId(secret, "acceptor"),
  ]);
  return { inviter, acceptor };
}

const CURRENT = generateSharedSecret();
const PREVIOUS = generateSharedSecret();

test("an acceptor holding a previous secret registers under the acceptor id of each secret and offers to the inviter id beside it", async () => {
  const current = await idsOf(CURRENT);
  const previous = await idsOf(PREVIOUS);
  const { sockets, legUnder } = await startRendezvous({
    role: "acceptor",
    sharedSecret: CURRENT,
    previousSharedSecret: PREVIOUS,
    expectedRegistrations: 2,
  });

  expect(sockets.map((socket) => socket.id).sort()).toEqual(
    [current.acceptor, previous.acceptor].sort(),
  );
  expect(legUnder(current.acceptor).socket.offeredTo()).toEqual([
    current.inviter,
  ]);
  expect(legUnder(previous.acceptor).socket.offeredTo()).toEqual([
    previous.inviter,
  ]);
});

test.each([
  ["an acceptor holding none", "acceptor", undefined],
  ["an inviter given one", "inviter", PREVIOUS],
  ["an acceptor whose previous secret is its current one", "acceptor", CURRENT],
] as const)(
  "%s registers under the current secret's id alone",
  async (_case, role, previousSharedSecret) => {
    const current = await idsOf(CURRENT);
    const { sockets } = await startRendezvous({
      role,
      sharedSecret: CURRENT,
      ...(previousSharedSecret !== undefined && { previousSharedSecret }),
      expectedRegistrations: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets.map((socket) => socket.id)).toEqual([current[role]]);
  },
);

test.each([
  ["previous", PREVIOUS],
  ["current", CURRENT],
] as const)(
  "the rendezvous under the %s secret that opens first is the session, and the other's registration and peer connection are closed",
  async (_case, secret) => {
    const opening = (await idsOf(secret)).acceptor;
    const other = (await idsOf(secret === CURRENT ? PREVIOUS : CURRENT))
      .acceptor;
    let registrations = 0;
    const { session, legUnder } = await startRendezvous({
      role: "acceptor",
      sharedSecret: CURRENT,
      previousSharedSecret: PREVIOUS,
      expectedRegistrations: 2,
      onRegistered: () => {
        registrations += 1;
      },
    });

    legUnder(opening).peer.channels[0]!.open();
    const opened = await session;

    expect(opened.channel).toBe(legUnder(opening).peer.channels[0]);
    expect(legUnder(other).socket.closeCalls).toBeGreaterThan(0);
    expect(legUnder(other).peer.closeCalls).toBeGreaterThan(0);
    expect(legUnder(opening).peer.closeCalls).toBe(0);
    expect(registrations).toBe(1);
  },
);

test("a failure other than a partner who never arrived, on either rendezvous, ends both", async () => {
  const previous = await idsOf(PREVIOUS);
  const current = await idsOf(CURRENT);
  const { session, legUnder } = await startRendezvous({
    role: "acceptor",
    sharedSecret: CURRENT,
    previousSharedSecret: PREVIOUS,
    refuse: previous.acceptor,
    expectedRegistrations: 2,
  });

  await expect(session).rejects.toThrow(ID_TAKEN_MESSAGE);
  expect(legUnder(current.acceptor).socket.closeCalls).toBeGreaterThan(0);
  expect(legUnder(current.acceptor).peer.closeCalls).toBeGreaterThan(0);
});

test("a wait no partner arrives at under either secret ends as a partner who never arrived", async () => {
  const { session } = await startRendezvous({
    role: "acceptor",
    sharedSecret: CURRENT,
    previousSharedSecret: PREVIOUS,
    rendezvousTimeoutMs: 300,
    expectedRegistrations: 2,
  });

  const failure = await session.catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(ConnectionError);
  expect(failureCauseOf(failure)?.kind).toBe("partner-never-arrived");
});
