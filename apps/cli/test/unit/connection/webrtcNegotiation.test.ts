import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import {
  ConnectionError,
  deriveRendezvousPeerId,
  failureCauseOf,
  generateSharedSecret,
  sanitizeErrorForDisplay,
  setDiagnosticSink,
  setLogLevel,
} from "@alcove/core";

import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import {
  BROKER_MESSAGE,
  BROKER_OPEN_TIMEOUT_MS,
  ID_TAKEN_MESSAGE,
} from "../../../src/connection/webrtc/brokerClient";
import { ICE_STATS_TIMEOUT_MS } from "../../../src/connection/webrtc/iceDiagnostics";
import { webRtcDialFrom } from "../../../src/run/prepare";
import { renderFailureForOperator } from "../../../src/util/exit";
import {
  DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
  DEFAULT_UNREPORTED_OFFER_RESEND_MS,
  MAX_CONNECTION_ID_LENGTH,
  MAX_APPLIED_REMOTE_CANDIDATES,
  MAX_PENDING_REMOTE_CANDIDATES,
  ID_TAKEN_RETRY_FIRST_DELAY_MS,
  ID_TAKEN_RETRY_MAX_DELAY_MS,
  MIN_OFFER_RESEND_INTERVAL_MS,
  NO_ICE_SERVERS_WARNING,
  idTakenAfterRetryMessage,
  openWebRtcPeerSession,
  relayCredentialAttemptNotice,
} from "../../../src/connection/webrtc/weriftPeer";

import type {
  AttemptIceServers,
  AttemptStartReason,
  WebRtcPeerSession,
  WeriftPeerConfiguration,
} from "../../../src/connection/webrtc/weriftPeer";
import type { RTCPeerConnection } from "werift";
import { waitFor } from "../../support";

/**
 * The negotiation state machine against a scripted broker and a scripted peer
 * connection: which signaling frame goes out, in what order, and in response
 * to what. werift inlines its ICE candidates in the SDP, so a peer whose
 * trickled candidates are all dropped still connects on loopback -- the
 * candidate-queue rule is invisible to an end-to-end test and only fails in
 * the field. The live path is test/integration/webrtc/transport.test.ts.
 */

const CANDIDATE_A = {
  candidate: "candidate:1 1 udp 2130706431 10.0.0.1 5000 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};
const CANDIDATE_B = {
  candidate: "candidate:2 1 udp 2130706430 10.0.0.2 5001 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};

/**
 * werift hands the negotiation an `RTCIceCandidate` instance whose `toJSON`
 * produces the browser-shaped payload; the transport converts through that
 * method, so a scripted candidate has to include it too.
 */
function asIceCandidate(fields: Record<string, unknown>): unknown {
  return { ...fields, toJSON: () => fields };
}

/** A broker socket that records what the client sent and replays what a test says. */
class ScriptedSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  /** How many times the client closed this socket; the registered id's release. */
  closeCalls = 0;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

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

  deliver(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** End the socket from the far side with no refusal, as a network drop does. */
  drop(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  /** Fail the socket after it opened, as a network error does. */
  fail(): void {
    this.readyState = 3;
    this.emit("error", {});
  }

  /** The frames of one type the client sent, in order. */
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.type === type);
  }

  /** Index of the first frame of `type`, or -1. */
  firstIndexOf(type: string): number {
    return this.sent.findIndex((frame) => frame.type === type);
  }

  /** Has the client attached its listeners yet? */
  wired(): boolean {
    return (this.listeners.get("message")?.size ?? 0) > 0;
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

/** A peer connection stand-in: no ICE, no DTLS, candidates fired on command. */
class ScriptedPeer {
  onicecandidate: ((event: { candidate?: unknown }) => void) | undefined;
  onconnectionstatechange: (() => void) | undefined;
  ondatachannel: ((event: { channel: unknown }) => void) | undefined;
  connectionState = "connected";
  localDescription: { type: string; sdp: string } | undefined;
  readonly remoteDescriptions: Array<{ type: string; sdp: string }> = [];
  readonly remoteCandidates: Array<unknown> = [];
  readonly channels: Array<FakeChannel> = [];
  /** How many times the session closed this connection. */
  closeCalls = 0;
  // The SCTP queues the session's drain assumption asserts on.
  readonly sctp = { sctp: { outboundQueue: [], sentQueue: [] } };
  /** ICE statistics `getStats()` answers with; a test scripts what it holds. */
  stats = new Map<string, unknown>();
  /**
   * How `getStats()` answers at all: a peer connection already torn down
   * throws, and a collection that overruns {@link ICE_STATS_TIMEOUT_MS} never
   * settles. Both leave a failure with no candidate report to attach.
   */
  statsAnswer: "resolves" | "throws" | "never-settles" = "resolves";
  /** How many times the session collected them. */
  statsCalls = 0;
  /** Fired during setLocalDescription, as werift does. */
  candidatesDuringSetLocal: Array<Record<string, unknown>> = [];

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

  setLocalDescription(description: {
    type: string;
    sdp: string;
  }): Promise<void> {
    this.localDescription = description;
    // werift begins firing candidates here, before the description can have
    // reached the broker: the whole reason the transport queues them.
    for (const candidate of this.candidatesDuringSetLocal) {
      this.onicecandidate?.({ candidate: asIceCandidate(candidate) });
    }
    return Promise.resolve();
  }

  setRemoteDescription(description: {
    type: string;
    sdp: string;
  }): Promise<void> {
    this.remoteDescriptions.push(description);
    return Promise.resolve();
  }

  rejectCandidates = false;

  addIceCandidate(candidate: unknown): Promise<void> {
    if (this.rejectCandidates)
      return Promise.reject(new Error("unparseable candidate"));
    this.remoteCandidates.push(candidate);
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, unknown>> {
    this.statsCalls += 1;
    if (this.statsAnswer === "throws")
      throw new Error("the peer connection is closed");
    if (this.statsAnswer === "never-settles")
      return new Promise<Map<string, unknown>>(() => {});
    return Promise.resolve(this.stats);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.connectionState = "closed";
    return Promise.resolve();
  }

  /** Report the state werift reports when no candidate pair ever worked. */
  failConnection(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
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

const sessions: Array<WebRtcPeerSession> = [];
/**
 * One per rendezvous a test started. A test that fails before its rendezvous
 * settles leaves it running -- starting attempts, and logging into the next test's
 * capture -- so each is ended once its test is over.
 */
const teardowns: Array<AbortController> = [];

snapshotDiagnosticSinkAndLevel();

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const teardown of teardowns.splice(0)) teardown.abort();
  vi.useRealTimers();
});

/** Start a rendezvous with scripted transports; resolve once both are wired. */
async function startRendezvous(options: {
  role: "inviter" | "acceptor";
  candidatesDuringSetLocal?: Array<Record<string, unknown>>;
  rendezvousTimeoutMs?: number;
  channelOpenTimeoutMs?: number;
  /**
   * The budgets a run's dial passes, taken verbatim: an absent one falls to
   * the transport's own default rather than this harness's short one.
   */
  dialBudgets?: { rendezvousTimeoutMs?: number; channelOpenTimeoutMs?: number };
  unreportedOfferResendMs?: number;
  attemptMs?: number;
  attemptOfferQuietMs?: number;
  idTakenRetryWindowMs?: number;
  /** The ICE servers the harness configures; absent is the harness's one STUN entry. */
  iceServers?: Array<{ urls: string }>;
  iceTransportPolicy?: "all" | "relay";
  signal?: AbortSignal;
  /**
   * Whether the broker confirms the registration with `OPEN`. A test of the
   * window before registration completes says no and leaves it unconfirmed.
   */
  confirmRegistration?: boolean;
  /**
   * How the broker answers each registration after the first, one socket per
   * connection attempt. Absent, it confirms each with `OPEN`.
   */
  laterRegistration?: (socket: ScriptedSocket, index: number) => void;
  attemptIceServers?: AttemptIceServers;
  /** Shared with another rendezvous so the two derive the same pair of ids. */
  sharedSecret?: string;
}): Promise<{
  socket: ScriptedSocket;
  /** Every broker socket opened, one per registration, in order; `socket` is the first. */
  sockets: Array<ScriptedSocket>;
  peer: ScriptedPeer;
  /** Every peer connection built, in order; `peer` is the first. */
  peers: Array<ScriptedPeer>;
  /** The configuration each of `peers` was built with. */
  configurations: Array<WeriftPeerConfiguration>;
  session: Promise<WebRtcPeerSession>;
  inviterId: string;
  acceptorId: string;
}> {
  const sharedSecret = options.sharedSecret ?? generateSharedSecret();
  const [inviterId, acceptorId] = await Promise.all([
    deriveRendezvousPeerId(sharedSecret, "inviter"),
    deriveRendezvousPeerId(sharedSecret, "acceptor"),
  ]);
  const socket = new ScriptedSocket();
  const peer = new ScriptedPeer();
  peer.candidatesDuringSetLocal = options.candidatesDuringSetLocal ?? [];
  const peers: Array<ScriptedPeer> = [];
  const sockets: Array<ScriptedSocket> = [];
  const configurations: Array<WeriftPeerConfiguration> = [];
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
    sharedSecret,
    iceServers: options.iceServers ?? [{ urls: "stun:127.0.0.1:3478" }],
    ...(options.dialBudgets !== undefined
      ? {
          rendezvousTimeoutMs: options.dialBudgets.rendezvousTimeoutMs,
          channelOpenTimeoutMs: options.dialBudgets.channelOpenTimeoutMs,
        }
      : {
          rendezvousTimeoutMs: options.rendezvousTimeoutMs ?? 10_000,
          channelOpenTimeoutMs: options.channelOpenTimeoutMs ?? 10_000,
        }),
    unreportedOfferResendMs: options.unreportedOfferResendMs,
    attemptMs: options.attemptMs,
    attemptOfferQuietMs: options.attemptOfferQuietMs,
    idTakenRetryWindowMs: options.idTakenRetryWindowMs,
    iceTransportPolicy: options.iceTransportPolicy,
    signal:
      options.signal === undefined
        ? teardown.signal
        : AbortSignal.any([options.signal, teardown.signal]),
    attemptIceServers: options.attemptIceServers,
    peerConnectionFactory: (configuration) => {
      const built = peers.length === 0 ? peer : new ScriptedPeer();
      peers.push(built);
      configurations.push(configuration);
      return built as unknown as RTCPeerConnection;
    },
    socketFactory: () => {
      const opened = sockets.length === 0 ? socket : new ScriptedSocket();
      const index = sockets.length;
      sockets.push(opened);
      // The client attaches its listeners as soon as the factory returns, so
      // a later socket is answered once that synchronous step is done.
      if (index > 0)
        queueMicrotask(() =>
          options.laterRegistration === undefined
            ? opened.register()
            : options.laterRegistration(opened, index),
        );
      return opened as unknown as WebSocket;
    },
  });
  session.then(
    (value) => sessions.push(value),
    () => {
      // A test that expects the rendezvous to fail owns the rejection.
    },
  );
  // The rendezvous derives both ids before it opens the socket, so wait for the
  // client to attach its listeners rather than guessing how long that takes.
  for (let attempt = 0; attempt < 200 && !socket.wired(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (options.confirmRegistration !== false) socket.register();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    socket,
    sockets,
    peer,
    peers,
    configurations,
    session,
    inviterId,
    acceptorId,
  };
}

/**
 * Whether a rendezvous has settled yet. A rendezvous still waiting is the
 * assertion in the tests below, so the answer has to come back rather than
 * block on a promise that is not meant to settle at all.
 */
async function settlementOf(
  session: Promise<WebRtcPeerSession>,
): Promise<"waiting" | "resolved" | "rejected"> {
  return await Promise.race([
    session.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"waiting">((resolve) =>
      setTimeout(() => resolve("waiting"), 20),
    ),
  ]);
}

// --- the dialer's offer -----------------------------------------------------

test("the acceptor's OFFER contains the payload a browser PeerJS peer parses", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  const [offer] = socket.ofType(BROKER_MESSAGE.offer);
  expect(offer.dst).toBe(inviterId);
  const payload = offer.payload as Record<string, unknown>;
  expect(payload.sdp).toEqual({ type: "offer", sdp: "v=0\r\noffer\r\n" });
  expect(payload.type).toBe("data");
  // The receiving PeerJS peer selects its DataConnection subclass from this
  // field, so a mismatch is a protocol break rather than a preference.
  expect(payload.serialization).toBe("binary");
  expect(payload.reliable).toBe(true);
  expect(payload.label).toBe(payload.connectionId);
  expect(String(payload.connectionId)).toMatch(/^dc_/);
  // The dialer creates the channel, and its label matches the connection id.
  expect(peer.channels).toHaveLength(1);
  expect(peer.channels[0].label).toBe(payload.connectionId);
  peer.channels[0].open();
  await session;
});

// --- the candidate queue ----------------------------------------------------

test("no candidate is sent before the local description reaches the broker", async () => {
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    candidatesDuringSetLocal: [CANDIDATE_A, CANDIDATE_B],
  });
  const offerAt = socket.firstIndexOf(BROKER_MESSAGE.offer);
  const candidateAt = socket.firstIndexOf(BROKER_MESSAGE.candidate);
  expect(offerAt).toBeGreaterThanOrEqual(0);
  expect(candidateAt).toBeGreaterThan(offerAt);
  // Both queued candidates are flushed once the offer is out; none is dropped.
  expect(
    socket
      .ofType(BROKER_MESSAGE.candidate)
      .map((frame) => (frame.payload as { candidate: unknown }).candidate),
  ).toEqual([CANDIDATE_A, CANDIDATE_B]);
  peer.channels[0].open();
  await session;
});

test("a candidate gathered after the description is sent goes out at once", async () => {
  const { socket, peer, session } = await startRendezvous({ role: "acceptor" });
  expect(socket.ofType(BROKER_MESSAGE.candidate)).toHaveLength(0);
  peer.onicecandidate?.({ candidate: asIceCandidate(CANDIDATE_A) });
  expect(
    socket
      .ofType(BROKER_MESSAGE.candidate)
      .map((frame) => (frame.payload as { candidate: unknown }).candidate),
  ).toEqual([CANDIDATE_A]);
  peer.channels[0].open();
  await session;
});

test("an end-of-candidates event sends nothing", async () => {
  const { socket, peer, session } = await startRendezvous({ role: "acceptor" });
  peer.onicecandidate?.({ candidate: undefined });
  expect(socket.ofType(BROKER_MESSAGE.candidate)).toHaveLength(0);
  peer.channels[0].open();
  await session;
});

// --- offering again after the broker's EXPIRE -----------------------------

test("the acceptor offers again on the broker's EXPIRE and otherwise only after the fallback", async () => {
  // A browser PeerJS peer handed two copies of one connection id closes the
  // connection its app already took, so no copy is sent while the broker may
  // still hold the last one. The fake clock also runs at wall-clock pace, so
  // the waits below stop a margin short of each deadline.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    shouldAdvanceTime: true,
  });
  const marginMs = 1_000;
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    candidatesDuringSetLocal: [CANDIDATE_A],
    rendezvousTimeoutMs: 10 * DEFAULT_UNREPORTED_OFFER_RESEND_MS,
  });
  await vi.advanceTimersByTimeAsync(
    DEFAULT_UNREPORTED_OFFER_RESEND_MS - marginMs,
  );
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(1);
  expect(socket.ofType(BROKER_MESSAGE.candidate)).toHaveLength(1);

  socket.deliver({ type: BROKER_MESSAGE.expire, src: inviterId });
  const offers = socket.ofType(BROKER_MESSAGE.offer);
  expect(offers).toHaveLength(2);
  expect(offers[1].payload).toEqual(offers[0].payload);
  // The broker dropped the candidates with the offer, so they go again after it.
  const resent = socket.sent.slice(socket.sent.indexOf(offers[1]) + 1);
  expect(
    resent.map((frame) => (frame.payload as { candidate: unknown }).candidate),
  ).toEqual([CANDIDATE_A]);

  // The first offer's deadline passes here; only the EXPIRE's own re-send
  // may be waiting.
  await vi.advanceTimersByTimeAsync(
    DEFAULT_UNREPORTED_OFFER_RESEND_MS - marginMs,
  );
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2 * marginMs);
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(3);
  expect(peer.channels).toHaveLength(1);
  peer.channels[0].open();
  await session;
});

/**
 * Fake the timers and the clock, which also runs at wall-clock pace, so the
 * waits below stop a margin short of each deadline.
 */
function holdOfferResendClock(): void {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
    shouldAdvanceTime: true,
  });
}

/** The OFFER and CANDIDATE frames sent, leaving out the heartbeats. */
function signalingFrames(
  socket: ScriptedSocket,
): Array<Record<string, unknown>> {
  return socket.sent.filter(
    (frame) =>
      frame.type === BROKER_MESSAGE.offer ||
      frame.type === BROKER_MESSAGE.candidate,
  );
}

function sentCandidates(
  frames: Array<Record<string, unknown>>,
): Array<unknown> {
  return frames
    .filter((frame) => frame.type === BROKER_MESSAGE.candidate)
    .map((frame) => (frame.payload as { candidate: unknown }).candidate);
}

test("EXPIREs inside the minimum interval are answered by one re-send when it ends", async () => {
  holdOfferResendClock();
  const marginMs = 1_000;
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    candidatesDuringSetLocal: [CANDIDATE_A, CANDIDATE_B],
    rendezvousTimeoutMs: 10 * DEFAULT_UNREPORTED_OFFER_RESEND_MS,
  });
  for (let index = 0; index < 5; index += 1) {
    socket.deliver({ type: BROKER_MESSAGE.expire, src: inviterId });
  }
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(1);
  const sentBefore = signalingFrames(socket).length;

  await vi.advanceTimersByTimeAsync(MIN_OFFER_RESEND_INTERVAL_MS - marginMs);
  expect(signalingFrames(socket)).toHaveLength(sentBefore);
  await vi.advanceTimersByTimeAsync(2 * marginMs);
  const resent = signalingFrames(socket).slice(sentBefore);
  expect(resent.map((frame) => frame.type)).toEqual([
    BROKER_MESSAGE.offer,
    BROKER_MESSAGE.candidate,
    BROKER_MESSAGE.candidate,
  ]);
  expect(sentCandidates(resent)).toEqual([CANDIDATE_A, CANDIDATE_B]);

  await vi.advanceTimersByTimeAsync(2 * MIN_OFFER_RESEND_INTERVAL_MS);
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(2);
  peer.channels[0].open();
  await session;
});

test("an EXPIRE after the minimum interval re-sends at once, and the interval restarts from that send", async () => {
  holdOfferResendClock();
  const marginMs = 1_000;
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    candidatesDuringSetLocal: [CANDIDATE_A],
    rendezvousTimeoutMs: 10 * DEFAULT_UNREPORTED_OFFER_RESEND_MS,
  });
  await vi.advanceTimersByTimeAsync(MIN_OFFER_RESEND_INTERVAL_MS + marginMs);
  const sentBefore = signalingFrames(socket).length;
  socket.deliver({ type: BROKER_MESSAGE.expire, src: inviterId });
  const resent = signalingFrames(socket).slice(sentBefore);
  expect(resent.map((frame) => frame.type)).toEqual([
    BROKER_MESSAGE.offer,
    BROKER_MESSAGE.candidate,
  ]);
  expect(sentCandidates(resent)).toEqual([CANDIDATE_A]);

  await vi.advanceTimersByTimeAsync(marginMs);
  socket.deliver({ type: BROKER_MESSAGE.expire, src: inviterId });
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(
    MIN_OFFER_RESEND_INTERVAL_MS - 3 * marginMs,
  );
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2 * marginMs);
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(3);
  peer.channels[0].open();
  await session;
});

test("a broker answering every frame with an EXPIRE draws at most one re-send per minimum interval", async () => {
  holdOfferResendClock();
  const startedAt = Date.now();
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    candidatesDuringSetLocal: [CANDIDATE_A, CANDIDATE_B],
    rendezvousTimeoutMs: 10 * DEFAULT_UNREPORTED_OFFER_RESEND_MS,
  });
  // `startedAt` precedes the first offer only by the few milliseconds the
  // rendezvous takes to start, far inside the interval.
  const offerSentAt: Array<number> = [startedAt];
  // Capped so a client that re-sends on every EXPIRE ends the test rather
  // than spinning it.
  let expiresLeft = 1_000;
  const send = socket.send.bind(socket);
  socket.send = (data: string) => {
    send(data);
    const { type } = JSON.parse(data) as { type: string };
    if (type === BROKER_MESSAGE.offer) offerSentAt.push(Date.now());
    if (
      (type === BROKER_MESSAGE.offer || type === BROKER_MESSAGE.candidate) &&
      expiresLeft > 0
    ) {
      expiresLeft -= 1;
      queueMicrotask(() =>
        socket.deliver({ type: BROKER_MESSAGE.expire, src: inviterId }),
      );
    }
  };
  socket.deliver({ type: BROKER_MESSAGE.expire, src: inviterId });

  const intervals = 3;
  await vi.advanceTimersByTimeAsync(
    intervals * MIN_OFFER_RESEND_INTERVAL_MS + MIN_OFFER_RESEND_INTERVAL_MS / 2,
  );
  expect(offerSentAt).toHaveLength(1 + intervals);
  for (let index = 1; index < offerSentAt.length; index += 1) {
    expect(offerSentAt[index] - offerSentAt[index - 1]).toBeGreaterThanOrEqual(
      MIN_OFFER_RESEND_INTERVAL_MS,
    );
  }
  expect(socket.ofType(BROKER_MESSAGE.candidate)).toHaveLength(
    2 * (1 + intervals),
  );
  peer.channels[0].open();
  await session;
});

test("an offer neither answered nor reported expired is sent again after the fallback", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    unreportedOfferResendMs: 200,
  });
  await waitFor(
    () => socket.ofType(BROKER_MESSAGE.offer).length === 3,
    NEGOTIATION_POLL,
  );
  // The answer stops the fallback before its next turn.
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(3);
  peer.channels[0].open();
  await session;
});

test("an EXPIRE from another id sends nothing", async () => {
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({ type: BROKER_MESSAGE.expire, src: "someone-else" });
  socket.deliver({ type: BROKER_MESSAGE.expire });
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(1);
  peer.channels[0].open();
  await session;
});

test("an EXPIRE after the answer lands sends nothing", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await waitFor(() => peer.remoteDescriptions.length === 1, NEGOTIATION_POLL);
  socket.deliver({ type: BROKER_MESSAGE.expire, src: inviterId });
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(1);
  peer.channels[0].open();
  await session;
});

test("an inviter sends nothing on an EXPIRE and keeps its connection", async () => {
  const { socket, peers, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      connectionId: "dc_partner",
    },
  });
  await waitFor(
    () => answeredConnectionIds(socket).length === 1,
    NEGOTIATION_POLL,
  );
  const sentBefore = socket.sent.length;
  socket.deliver({ type: BROKER_MESSAGE.expire, src: acceptorId });
  expect(socket.sent).toHaveLength(sentBefore);
  expect(peers).toHaveLength(1);
  expect(peers[0].closeCalls).toBe(0);
  const channel = new FakeChannel("dc_partner");
  peers[0].ondatachannel?.({ channel });
  channel.open();
  await session;
});

// --- which ceiling governs which wait ---------------------------------------

/**
 * The two ceilings measure different things, and only unequal values tell
 * them apart: the rendezvous budget covers a partner who has not arrived (ten
 * minutes), the channel-open ceiling a partner present and negotiating whose
 * channel never comes up (thirty seconds). The dialer creates its channel
 * before it has offered, so confusing the two cuts a ten-minute rendezvous to
 * thirty seconds and blames a network path for an operator who started late.
 */

test("the dialer's channel-open ceiling does not run before it is answered", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(await settlementOf(session)).toBe("waiting");

  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  peer.channels[0].open();
  await expect(session).resolves.toBeDefined();
});

test("an unanswered dialer fails on the rendezvous budget, and says so", async () => {
  const { session } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 150,
  });
  const err: unknown = await session.catch((e: unknown) => e);
  expect((err as Error).message).toBe(
    "Your partner did not connect within 0.15 seconds.",
  );
  expect(failureCauseOf(err)).toEqual({
    kind: "partner-never-arrived",
    channel: "webrtc",
    waitedMs: 150,
  });
  expect(renderFailureForOperator(err)).toBe(
    "Your partner did not connect within 0.15 seconds.\n" +
      "Check that your partner has started their side, then run again; " +
      "--peer-timeout sets how long to wait.",
  );
});

test("a channel that never opens after the answer fails at the open ceiling", async () => {
  const { socket, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  const failure = await session.then(
    () => expect.unreachable("the channel open should have failed"),
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(Error);
  const { message } = failure as Error;
  expect(message).toMatch(
    /did not open within 0.1s after the exchange partner's session description arrived/,
  );
  expect(message).not.toContain("--peer-timeout");
  expect(message).not.toContain("inactivity_timeout_ms");
});

/** The budgets a run's dial passes the transport under these connection options. */
function dialBudgetsFor(options: {
  peerTimeoutMs?: number;
  inactivityTimeoutMs?: number;
}): { rendezvousTimeoutMs?: number; channelOpenTimeoutMs?: number } {
  return webRtcDialFrom(
    {
      channel: "webrtc",
      server: { host: "127.0.0.1" },
      role: "acceptor",
      options,
    },
    generateSharedSecret(),
  ).options;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

test("an absent partner fails at peer_timeout_ms while the silence budget is long", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    shouldAdvanceTime: true,
  });
  const arrivalMs = 60_000;
  const { session } = await startRendezvous({
    role: "acceptor",
    dialBudgets: dialBudgetsFor({
      peerTimeoutMs: arrivalMs,
      inactivityTimeoutMs: SEVEN_DAYS_MS,
    }),
  });
  await vi.advanceTimersByTimeAsync(arrivalMs - 1_000);
  expect(await settlementOf(session)).toBe("waiting");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(session).rejects.toThrow(
    "Your partner did not connect within 1 minute.",
  );
});

test("the channel open ends its attempt at its fixed ceiling whatever both settings hold", async () => {
  const lines = captureDiagnostics();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    shouldAdvanceTime: true,
  });
  const { socket, sockets, session, inviterId } = await startRendezvous({
    role: "acceptor",
    dialBudgets: dialBudgetsFor({
      peerTimeoutMs: SEVEN_DAYS_MS,
      inactivityTimeoutMs: SEVEN_DAYS_MS,
    }),
  });
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await vi.advanceTimersByTimeAsync(DEFAULT_CHANNEL_OPEN_TIMEOUT_MS - 1_000);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2_000 + ICE_STATS_TIMEOUT_MS);
  // A seven-day wait's first attempt is not its last, so the ceiling starts
  // the next attempt rather than failing the wait.
  await waitFor(() => sockets.length === 2, NEGOTIATION_POLL);
  expect(await settlementOf(session)).toBe("waiting");
  expect(
    lines.some((line) =>
      line.includes(
        `did not open within ${DEFAULT_CHANNEL_OPEN_TIMEOUT_MS / 1000}s`,
      ),
    ),
  ).toBe(true);
});

// --- the listener's answer --------------------------------------------------

test("the inviter answers an offer and adopts its connection id", async () => {
  const { socket, peer, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(0);
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      type: "data",
      connectionId: "dc_fromtheirside",
      serialization: "binary",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [answer] = socket.ofType(BROKER_MESSAGE.answer);
  expect(answer.dst).toBe(acceptorId);
  const payload = answer.payload as Record<string, unknown>;
  expect(payload.sdp).toEqual({ type: "answer", sdp: "v=0\r\nanswer\r\n" });
  // The answer contains no label/reliable/serialization -- the offer settled all
  // three -- and reuses the id the dialer chose.
  expect(payload.connectionId).toBe("dc_fromtheirside");
  expect(payload).not.toHaveProperty("serialization");
  // The listener takes the channel the remote created rather than making one.
  expect(peer.channels).toHaveLength(0);
  const channel = new FakeChannel("dc_fromtheirside");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

test("an over-long connection id in an offer is neither adopted nor echoed", async () => {
  const { socket, peer, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  // Larger than the bound but still inside the broker's 256 KiB frame, so it
  // reaches onOffer; adopting it would push every outbound answer/candidate past
  // the broker's inbound limit.
  const oversized = `dc_${"x".repeat(MAX_CONNECTION_ID_LENGTH * 4)}`;
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      type: "data",
      connectionId: oversized,
      serialization: "binary",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [answer] = socket.ofType(BROKER_MESSAGE.answer);
  const echoed = (answer.payload as { connectionId: string }).connectionId;
  // The over-long id is refused; this side keeps its own short generated id.
  expect(echoed).not.toBe(oversized);
  expect(echoed.length).toBeLessThanOrEqual(MAX_CONNECTION_ID_LENGTH);
  expect(echoed).toMatch(/^dc_/);
  // And the rendezvous still completes on the channel the remote created.
  const channel = new FakeChannel("dc_ok");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

test("a repeated offer is re-answered rather than renegotiated", async () => {
  const { socket, peer, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  const offer = {
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      type: "data",
      connectionId: "dc_repeat",
    },
  };
  socket.deliver(offer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  socket.deliver(offer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(socket.ofType(BROKER_MESSAGE.answer).length).toBeGreaterThan(1);
  // One remote description: the repeat did not rebuild the connection already
  // forming.
  expect(peer.remoteDescriptions).toHaveLength(1);
  const channel = new FakeChannel("dc_repeat");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

// --- what the negotiation refuses to act on ---------------------------------

test("a signaling frame from any id but the derived partner is ignored", async () => {
  const { socket, peer, session } = await startRendezvous({ role: "inviter" });
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    src: "ffff9999ffff9999ffff9999ffff9999",
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\nintruder\r\n" },
      connectionId: "dc_intruder",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(socket.ofType(BROKER_MESSAGE.answer)).toHaveLength(0);
  expect(peer.remoteDescriptions).toHaveLength(0);
  const channel = new FakeChannel("dc_ok");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

test("a signaling frame containing no src is dropped", async () => {
  // The honest broker stamps src on every relayed frame, so a src-less frame is
  // not peer traffic; the one party that can plant one is a hostile signaling
  // server, and it must not be able to apply an offer.
  const { socket, peer, session } = await startRendezvous({ role: "inviter" });
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\nnosrc\r\n" },
      connectionId: "dc_nosrc",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(socket.ofType(BROKER_MESSAGE.answer)).toHaveLength(0);
  expect(peer.remoteDescriptions).toHaveLength(0);
  const channel = new FakeChannel("dc_ok");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;
});

test("a remote candidate is held until a remote description can apply it", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({
    type: BROKER_MESSAGE.candidate,
    src: inviterId,
    payload: { candidate: CANDIDATE_A },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toHaveLength(0);

  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toEqual([CANDIDATE_A]);
  peer.channels[0].open();
  await session;
});

test("a flood of remote candidates before the description is capped, and a late description still applies the ones held", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  // A partner (or hostile broker) that never answers could stream candidates for
  // the whole rendezvous budget; the queue that holds them is capped.
  for (let i = 0; i < MAX_PENDING_REMOTE_CANDIDATES + 25; i += 1) {
    socket.deliver({
      type: BROKER_MESSAGE.candidate,
      src: inviterId,
      payload: { candidate: CANDIDATE_A },
    });
  }
  // None is applied while the description has not arrived.
  expect(peer.remoteCandidates).toHaveLength(0);

  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // Exactly the cap was retained; the surplus was dropped, not queued -- and the
  // late description still completed the rendezvous.
  expect(peer.remoteCandidates).toHaveLength(MAX_PENDING_REMOTE_CANDIDATES);
  peer.channels[0].open();
  await session;
});

test("remote candidates applied after the description are capped, held ones counted with them", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  expect(MAX_APPLIED_REMOTE_CANDIDATES).toBe(128);
  const deliverCandidates = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      socket.deliver({
        type: BROKER_MESSAGE.candidate,
        src: inviterId,
        payload: { candidate: CANDIDATE_A },
      });
    }
  };
  deliverCandidates(10);
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toHaveLength(10);

  // Up to the cap every candidate is applied; past it each is dropped, and the
  // rendezvous still completes.
  deliverCandidates(MAX_APPLIED_REMOTE_CANDIDATES - 10);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toHaveLength(MAX_APPLIED_REMOTE_CANDIDATES);
  deliverCandidates(25);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toHaveLength(MAX_APPLIED_REMOTE_CANDIDATES);
  peer.channels[0].open();
  await session;
});

test("a rejected remote candidate does not consume the applied budget", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const deliverCandidates = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      socket.deliver({
        type: BROKER_MESSAGE.candidate,
        src: inviterId,
        payload: { candidate: CANDIDATE_A },
      });
    }
  };
  peer.rejectCandidates = true;
  deliverCandidates(MAX_APPLIED_REMOTE_CANDIDATES + 10);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toHaveLength(0);

  peer.rejectCandidates = false;
  deliverCandidates(MAX_APPLIED_REMOTE_CANDIDATES + 10);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteCandidates).toHaveLength(MAX_APPLIED_REMOTE_CANDIDATES);
  peer.channels[0].open();
  await session;
});

test("two answers delivered in one tick set the remote description once", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  const answer = {
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  };
  // Same tick, before the first setRemoteDescription resolves: the synchronous
  // latch must stop the second from re-applying and failing the rendezvous.
  socket.deliver(answer);
  socket.deliver(answer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peer.remoteDescriptions).toHaveLength(1);
  peer.channels[0].open();
  await session;
});

test("the partner leaving the broker fails the rendezvous", async () => {
  const { socket, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({ type: BROKER_MESSAGE.leave, src: inviterId, payload: {} });
  await expect(session).rejects.toThrow(/left the coordination server/);
});

// --- broker traffic after the session is established ------------------------

test("broker signaling after the channel opens is ignored", async () => {
  const { socket, peer, session, acceptorId } = await startRendezvous({
    role: "inviter",
  });
  const offer = {
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: {
      sdp: { type: "offer", sdp: "v=0\r\noffer\r\n" },
      type: "data",
      connectionId: "dc_open",
    },
  };
  socket.deliver(offer);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const channel = new FakeChannel("dc_open");
  peer.ondatachannel?.({ channel });
  channel.open();
  await session;

  const answersBefore = socket.ofType(BROKER_MESSAGE.answer).length;
  // Post-open, a repeated offer is not reflected as a fresh full-SDP answer
  // through the broker, and a late candidate is not fed to the peer.
  socket.deliver(offer);
  socket.deliver({
    type: BROKER_MESSAGE.candidate,
    src: acceptorId,
    payload: { candidate: CANDIDATE_A },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(socket.ofType(BROKER_MESSAGE.answer)).toHaveLength(answersBefore);
  expect(peer.remoteCandidates).toHaveLength(0);
});

// --- what an abort leaves behind --------------------------------------------

/**
 * The rendezvous can wait up to ten minutes, so `runProtocol` hands it the
 * interrupt signal for a quick Ctrl-C. Ending it early closes the broker
 * socket (releasing the derived id) and the peer connection, asserted against
 * the real session where that wiring lives. A webrtc open is two phases --
 * registering, then waiting for the partner -- each with its own cancellation
 * wording; the three tests below cover the three windows an abort can land in.
 */

test("an abort after registration names the rendezvous and tears both down", async () => {
  const controller = new AbortController();
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    signal: controller.signal,
  });
  // Registered and negotiating: the dialer's offer is already on the wire.
  expect(socket.ofType(BROKER_MESSAGE.offer).length).toBeGreaterThan(0);
  expect(socket.closeCalls).toBe(0);
  expect(peer.closeCalls).toBe(0);

  controller.abort();
  // The registration released the signal when the broker confirmed it, so what
  // reaches the operator names the phase they actually interrupted -- the wait
  // for the partner, not a connection to the signaling server that succeeded
  // minutes ago.
  await expect(session).rejects.toThrow(/the WebRTC rendezvous was cancelled/);
  // Exactly once each: an abandoned rendezvous leaves no registered id on the
  // broker and no half-open peer connection behind.
  expect(socket.closeCalls).toBe(1);
  expect(peer.closeCalls).toBe(1);
});

test("an abort inside the dialer's offer does not wait out the rendezvous", async () => {
  // The window between the two phases' listeners: the registration has released
  // the signal, and the negotiation cannot install its own until the acceptor's
  // offer resolves -- werift gathers as it describes, so that offer spans timer
  // turns. An abort landing here reaches no listener at all, and only the
  // negotiation's re-check keeps the run from sitting out its whole rendezvous
  // budget after the operator has already interrupted it.
  const controller = new AbortController();
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    signal: controller.signal,
    confirmRegistration: false,
    // Short enough that a missed abort fails as a timeout here rather than
    // spending the suite's own ceiling on it.
    rendezvousTimeoutMs: 500,
  });
  peer.createOffer = async () => {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { type: "offer", sdp: "v=0\r\noffer\r\n" };
  };
  socket.register();

  await expect(session).rejects.toThrow(/the WebRTC rendezvous was cancelled/);
  expect(socket.closeCalls).toBe(1);
  expect(peer.closeCalls).toBe(1);
});

test("a broker failure inside the acceptor's offer rejects rather than going unhandled", async () => {
  // The acceptor awaits its own offer before it awaits the rendezvous, so a
  // failure latched in that window rejects a promise nothing is waiting on
  // yet. Unhandled, that terminates the process at exit 1 instead of failing
  // the exchange the ordinary way. A terminal broker ERROR delivered while
  // createOffer is in flight is one of several failures that reach fail()
  // there.
  const unhandled: unknown[] = [];
  const record = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", record);
  try {
    const { socket, peer, session } = await startRendezvous({
      role: "acceptor",
      confirmRegistration: false,
    });
    peer.createOffer = async () => {
      socket.deliver({ type: BROKER_MESSAGE.error, payload: "server sank" });
      // The real offer does I/O (werift gathers as it describes), so the window
      // it holds open spans timer turns rather than resolving in the microtask
      // the failure landed in -- which is what leaves the rejection unhandled
      // long enough to be reported.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { type: "offer", sdp: "v=0\r\noffer\r\n" };
    };
    socket.register();

    await expect(session).rejects.toThrow(
      /coordination server reported an error/,
    );
    // The teardown the classified path owes, which an unhandled rejection skips.
    expect(peer.closeCalls).toBe(1);
    // A turn for the rejection to be reported if it was never handled.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("an abort before registration tears down the same, having sent nothing", async () => {
  // The earliest window: the socket exists but the broker has not confirmed it,
  // so the abort is the registration's, and its wording is what the operator
  // gets. The peer connection is already built by this point, and is what would
  // be left running if only the registration unwound itself.
  const controller = new AbortController();
  const { socket, peer, session } = await startRendezvous({
    role: "acceptor",
    signal: controller.signal,
    confirmRegistration: false,
  });

  controller.abort();
  await expect(session).rejects.toThrow(
    /connecting to the coordination server was cancelled/,
  );
  expect(socket.sent).toHaveLength(0);
  expect(socket.closeCalls).toBe(1);
  expect(peer.closeCalls).toBe(1);
});

// --- what a run reports about the path it found -----------------------------

/** A stats report in the map shape werift's `getStats()` resolves to. */
function iceStats(
  entries: Array<Record<string, unknown>>,
): Map<string, unknown> {
  return new Map(entries.map((entry) => [String(entry.id), entry]));
}

/** Statistics naming one nominated pair, the shape a live channel reports. */
function connectedStats(remoteType: string): Map<string, unknown> {
  return iceStats([
    { type: "local-candidate", id: "L1", candidateType: "host" },
    { type: "remote-candidate", id: "R1", candidateType: remoteType },
    {
      type: "candidate-pair",
      id: "P1",
      localCandidateId: "L1",
      remoteCandidateId: "R1",
      state: "succeeded",
      nominated: true,
    },
  ]);
}

/** Collect every diagnostic line the run emits, with debug lines admitted. */
function captureDiagnostics(): Array<string> {
  const lines: Array<string> = [];
  setDiagnosticSink((_method, _prefix, args) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  setLogLevel(logLibrary.levels.DEBUG);
  return lines;
}

/** The rendezvous failure, rendered as the operator is shown it. */
async function renderedFailure(
  session: Promise<WebRtcPeerSession>,
): Promise<string> {
  return sanitizeErrorForDisplay(
    await session.then(
      () => new Error("the rendezvous was expected to fail"),
      (err: unknown) => err,
    ),
  );
}

test("the open channel reports the candidate pair it runs over", async () => {
  const lines = captureDiagnostics();
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = connectedStats("relay");
  peer.channels[0].open();
  await session;
  expect(lines.join("\n")).toContain(
    "the data channel opened over candidate pair local host, remote relay",
  );
});

test("a run at a level that prints no debug line collects no statistics", async () => {
  // The pair line is the whole of what the collection is for, and collecting is
  // bounded rather than instant, so a run that would print nothing must not
  // spend the open channel's time on a peer whose getStats stalls.
  setLogLevel(logLibrary.levels.INFO);
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.statsAnswer = "never-settles";
  peer.stats = connectedStats("relay");
  const startedAt = Date.now();
  peer.channels[0].open();
  await session;
  expect(peer.statsCalls).toBe(0);
  expect(Date.now() - startedAt).toBeLessThan(ICE_STATS_TIMEOUT_MS);
});

test("a debug run collects them once", async () => {
  captureDiagnostics();
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = connectedStats("relay");
  peer.channels[0].open();
  await session;
  expect(peer.statsCalls).toBe(1);
});

test("a run whose statistics name no pair says so rather than nothing", async () => {
  const lines = captureDiagnostics();
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.channels[0].open();
  await session;
  expect(lines.join("\n")).toContain("ICE reported no selected candidate pair");
});

test("a partner's candidate type cannot drive the operator's terminal", async () => {
  const lines = captureDiagnostics();
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = connectedStats("relay\u001b[31m\nFAKE: exchange complete");
  peer.channels[0].open();
  await session;
  const reported = lines.find((line) => line.includes("candidate pair"));
  expect(reported).toContain(
    "remote relay\\x1b[31m\\x0aFAKE: exchange complete",
  );
  expect(reported).not.toContain("\u001b");
  expect(reported).not.toContain("\n");
});

test("an ICE failure names what was gathered, received and tried", async () => {
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = iceStats([
    { type: "local-candidate", id: "L1", candidateType: "host" },
    { type: "local-candidate", id: "L2", candidateType: "srflx" },
  ]);
  peer.failConnection();
  const rendered = await renderedFailure(session);
  expect(rendered).toContain(
    "no network path between the two parties could be established",
  );
  expect(rendered).toContain(
    "local candidates gathered: no relay candidate gathered; 2 (host, srflx)",
  );
  expect(rendered).toContain("remote candidates received: none");
  expect(rendered).toContain("candidate pairs: none formed");
});

test("a relay gathered that still found no path is reported apart", async () => {
  const { peer, session } = await startRendezvous({ role: "acceptor" });
  peer.stats = iceStats([
    { type: "local-candidate", id: "L1", candidateType: "relay" },
    { type: "remote-candidate", id: "R1", candidateType: "host" },
    {
      type: "candidate-pair",
      id: "P1",
      localCandidateId: "L1",
      remoteCandidateId: "R1",
      state: "failed",
    },
  ]);
  peer.failConnection();
  const rendered = await renderedFailure(session);
  expect(rendered).toContain(
    "local candidates gathered: relay candidate gathered; 1 (relay)",
  );
  expect(rendered).toContain("remote candidates received: 1 (host)");
  expect(rendered).toContain("candidate pairs: 1 tried, none succeeded");
});

test("a relay-only run's failure names the policy that shaped it", async () => {
  // The run gathered nothing because the policy permitted nothing else, which
  // is the one reading of an empty tally the operator can act on: the remedy
  // is the relay or the policy, never a direct path.
  const { peer, session } = await startRendezvous({
    role: "acceptor",
    iceTransportPolicy: "relay",
  });
  peer.stats = iceStats([]);
  peer.failConnection();
  const rendered = await renderedFailure(session);
  expect(rendered).toContain(
    "local candidates gathered: no relay candidate gathered under " +
      "ice_transport_policy relay; none",
  );
});

test("the channel-open ceiling reports the same diagnosis", async () => {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  peer.stats = iceStats([
    { type: "local-candidate", id: "L1", candidateType: "host" },
  ]);
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
  });
  const rendered = await renderedFailure(session);
  expect(rendered).toContain("did not open within 0.1s");
  expect(rendered).toContain(
    "local candidates gathered: no relay candidate gathered; 1 (host)",
  );
});

/**
 * Drive one of the two diagnosed failures against a peer whose statistics
 * cannot be read, timing the failure itself: the diagnosis is bounded, so what
 * a report that never arrives may cost is the description, not the outcome.
 * The never-settles mode lives in {@link neverSettlingStatsFailure} instead,
 * since a real clock can beat the ceiling by a millisecond.
 */
async function failureWithUnreadableStats(options: {
  statsAnswer: Exclude<ScriptedPeer["statsAnswer"], "never-settles">;
  path: "connection-failed" | "channel-open-ceiling";
}): Promise<{ error: ConnectionError; elapsedMs: number }> {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  peer.statsAnswer = options.statsAnswer;
  const startedAt = Date.now();
  if (options.path === "connection-failed") peer.failConnection();
  else
    socket.deliver({
      type: BROKER_MESSAGE.answer,
      src: inviterId,
      payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
    });
  const error = await session.then(
    () => new Error("the rendezvous was expected to fail"),
    (err: unknown) => err,
  );
  return { error: error as ConnectionError, elapsedMs: Date.now() - startedAt };
}

/** What every failure reporting no candidate report at all has in common. */
function expectUndiagnosedFailure(
  error: ConnectionError,
  summary: string,
): void {
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error.kind).toBe("transport");
  expect(error.message).toContain(summary);
  expect(error.cause).toBeUndefined();
  expect(sanitizeErrorForDisplay(error)).not.toContain("candidates gathered");
}

test("a failed connection whose statistics throw reports the failure alone", async () => {
  const { error, elapsedMs } = await failureWithUnreadableStats({
    statsAnswer: "throws",
    path: "connection-failed",
  });
  expectUndiagnosedFailure(
    error,
    "no network path between the two parties could be established",
  );
  // A peer that answers at once is not waited on: the ceiling below is what
  // bounds one that does not.
  expect(elapsedMs).toBeLessThan(ICE_STATS_TIMEOUT_MS);
});

/**
 * Drive one of the two diagnosed failures against a peer whose statistics
 * never settle, under fake timers: {@link ICE_STATS_TIMEOUT_MS} is a
 * `setTimeout` a test can advance deterministically, unlike a `Date.now()`
 * measurement, which a real timer can fire a millisecond ahead of on a
 * loaded runner.
 */
async function neverSettlingStatsFailure(options: {
  path: "connection-failed" | "channel-open-ceiling";
}): Promise<ConnectionError> {
  const { socket, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    channelOpenTimeoutMs: 100,
    rendezvousTimeoutMs: 30_000,
  });
  peer.statsAnswer = "never-settles";
  const settlement = session.then(
    () => new Error("the rendezvous was expected to fail"),
    (err: unknown) => err,
  );
  let settled = false;
  void settlement.then(() => {
    settled = true;
  });
  vi.useFakeTimers();
  try {
    if (options.path === "connection-failed") peer.failConnection();
    else
      socket.deliver({
        type: BROKER_MESSAGE.answer,
        src: inviterId,
        payload: { sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" } },
      });
    const ceilingMs =
      (options.path === "channel-open-ceiling" ? 100 : 0) +
      ICE_STATS_TIMEOUT_MS;
    // One ms short of the ceiling must still be pending, and the ceiling
    // itself must settle: fake time has none of a real timer's early-fire
    // slack, so this pins the ceiling exactly instead of a lower bound.
    await vi.advanceTimersByTimeAsync(ceilingMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
  return (await settlement) as ConnectionError;
}

test("a failed connection whose statistics never arrive fails on the ICE ceiling", async () => {
  const error = await neverSettlingStatsFailure({ path: "connection-failed" });
  expectUndiagnosedFailure(
    error,
    "no network path between the two parties could be established",
  );
});

test("a channel-open ceiling whose statistics throw reports the failure alone", async () => {
  const { error, elapsedMs } = await failureWithUnreadableStats({
    statsAnswer: "throws",
    path: "channel-open-ceiling",
  });
  expectUndiagnosedFailure(error, "did not open within 0.1s");
  expect(elapsedMs).toBeLessThan(ICE_STATS_TIMEOUT_MS);
});

test("a channel-open ceiling whose statistics never arrive still reports", async () => {
  const error = await neverSettlingStatsFailure({
    path: "channel-open-ceiling",
  });
  expectUndiagnosedFailure(error, "did not open within 0.1s");
});

// --- waiting in connection attempts -----------------------------------------

const ONE_MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 10 * ONE_MINUTE_MS;
const OFFER_SDP = { type: "offer", sdp: "v=0\r\noffer\r\n" };

// How a case polls for the state a scripted socket reaches.
const NEGOTIATION_POLL = { timeoutMs: 1_000, intervalMs: 5 };

/**
 * Put the attempt bounds and the wait's deadline on a clock the test
 * advances, called before the rendezvous starts. The clock also moves with
 * real time, so the harness's polling still runs.
 */
function holdAttemptClock(): void {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
    shouldAdvanceTime: true,
  });
}

/** Let a new registration's attempt attach to its socket. */
async function settleRegistration(
  sockets: Array<ScriptedSocket>,
  count: number,
): Promise<void> {
  await waitFor(() => sockets.length === count, NEGOTIATION_POLL);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Answer a registration the way the broker does an id it already holds. */
function refuseIdTaken(socket: ScriptedSocket): void {
  socket.readyState = ScriptedSocket.OPEN;
  socket.deliver({ type: BROKER_MESSAGE.idTaken });
}

function offeredConnectionIds(socket: ScriptedSocket): Array<string> {
  return socket
    .ofType(BROKER_MESSAGE.offer)
    .map((frame) => (frame.payload as { connectionId: string }).connectionId);
}

/** The connection id each ANSWER the inviter sent names, in order. */
function answeredConnectionIds(socket: ScriptedSocket): Array<string> {
  return socket
    .ofType(BROKER_MESSAGE.answer)
    .map((frame) => (frame.payload as { connectionId: string }).connectionId);
}

/** Deliver an ANSWER naming `connectionId`. */
function answer(
  socket: ScriptedSocket,
  inviterId: string,
  connectionId: string,
): void {
  socket.deliver({
    type: BROKER_MESSAGE.answer,
    src: inviterId,
    payload: {
      sdp: { type: "answer", sdp: "v=0\r\nanswer\r\n" },
      connectionId,
    },
  });
}

/** Deliver an OFFER naming `connectionId`. */
function offer(
  socket: ScriptedSocket,
  acceptorId: string,
  connectionId: string,
): void {
  socket.deliver({
    type: BROKER_MESSAGE.offer,
    src: acceptorId,
    payload: { sdp: OFFER_SDP, connectionId },
  });
}

test("a partner arriving mid-attempt is met by that attempt", async () => {
  holdAttemptClock();
  const { socket, sockets, peer, peers, session, inviterId } =
    await startRendezvous({
      role: "acceptor",
      attemptMs: ONE_MINUTE_MS,
      rendezvousTimeoutMs: TEN_MINUTES_MS,
    });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS / 2);
  answer(socket, inviterId, offeredConnectionIds(socket)[0]);
  await waitFor(() => peer.remoteDescriptions.length === 1, NEGOTIATION_POLL);
  peer.channels[0].open();
  expect((await session).channel).toBe(peer.channels[0]);
  expect(sockets).toHaveLength(1);
  expect(peers).toHaveLength(1);
});

test("an inviter's partner arriving between attempts is met by the next one", async () => {
  holdAttemptClock();
  const { socket, sockets, peers, session, acceptorId } = await startRendezvous(
    {
      role: "inviter",
      attemptMs: ONE_MINUTE_MS,
      rendezvousTimeoutMs: TEN_MINUTES_MS,
    },
  );
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  expect(socket.closeCalls).toBe(1);
  expect(peers).toHaveLength(2);
  expect(peers[0].closeCalls).toBe(1);

  // The broker holds an offer sent while this side was between registrations
  // and hands it to the new one.
  offer(sockets[1], acceptorId, "dc_partner");
  await waitFor(
    () => sockets[1].ofType(BROKER_MESSAGE.answer).length === 1,
    NEGOTIATION_POLL,
  );
  expect(socket.ofType(BROKER_MESSAGE.answer)).toEqual([]);
  expect(peers[1].remoteDescriptions).toEqual([OFFER_SDP]);
  const channel = new FakeChannel("dc_partner");
  peers[1].ondatachannel?.({ channel });
  channel.open();
  expect((await session).channel).toBe(channel);
});

test("an acceptor's next attempt offers a new connection from a fresh registration", async () => {
  holdAttemptClock();
  const { socket, sockets, peers, session, inviterId } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
  });
  const [firstId] = offeredConnectionIds(socket);
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  await waitFor(
    () => sockets[1].ofType(BROKER_MESSAGE.offer).length === 1,
    NEGOTIATION_POLL,
  );
  const [nextId] = offeredConnectionIds(sockets[1]);
  expect(nextId).not.toBe(firstId);
  expect(peers[0].closeCalls).toBe(1);
  expect(peers[1].channels.map((channel) => channel.label)).toEqual([nextId]);

  // An answer to the torn-down attempt's offer answers nothing this one made.
  answer(sockets[1], inviterId, firstId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(peers[1].remoteDescriptions).toEqual([]);

  answer(sockets[1], inviterId, nextId);
  await waitFor(
    () => peers[1].remoteDescriptions.length === 1,
    NEGOTIATION_POLL,
  );
  peers[1].channels[0].open();
  expect((await session).channel).toBe(peers[1].channels[0]);
});

test("the whole wait ends at peer_timeout_ms however many attempts it took", async () => {
  holdAttemptClock();
  const waitMs = 200_000;
  const { sockets, session } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: waitMs,
  });
  await vi.advanceTimersByTimeAsync(waitMs - 1_000);
  expect(await settlementOf(session)).toBe("waiting");
  // Two full attempts, then the rest in one rather than a third full one and
  // a short fourth.
  expect(sockets).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(session).rejects.toThrow(
    "Your partner did not connect within 200 seconds.",
  );
  expect(sockets.every((socket) => socket.closeCalls === 1)).toBe(true);
});

test("a wait within the last attempt's stretch makes one attempt", async () => {
  holdAttemptClock();
  const waitMs = 80_000;
  const { sockets, session } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: waitMs,
  });
  await vi.advanceTimersByTimeAsync(waitMs - 1_000);
  expect(await settlementOf(session)).toBe("waiting");
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(session).rejects.toThrow(
    "Your partner did not connect within 80 seconds.",
  );
});

test("a re-registration refused as ID-TAKEN is retried within the attempt cycle", async () => {
  holdAttemptClock();
  const { sockets, peers, session, acceptorId } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    laterRegistration: (socket, index) => {
      if (index === 1) refuseIdTaken(socket);
      else socket.register();
    },
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  expect(sockets[1].closeCalls).toBe(1);
  expect(await settlementOf(session)).toBe("waiting");
  await vi.advanceTimersByTimeAsync(ID_TAKEN_RETRY_FIRST_DELAY_MS);
  await settleRegistration(sockets, 3);
  // The retry registers the attempt's own peer connection; none is rebuilt.
  expect(peers).toHaveLength(2);
  offer(sockets[2], acceptorId, "dc_partner");
  await waitFor(
    () => sockets[2].ofType(BROKER_MESSAGE.answer).length === 1,
    NEGOTIATION_POLL,
  );
  const channel = new FakeChannel("dc_partner");
  peers[1].ondatachannel?.({ channel });
  channel.open();
  expect((await session).channel).toBe(channel);
});

test("a re-registration still refused past the retry window fails naming another run", async () => {
  holdAttemptClock();
  const windowMs = 5_000;
  const { sockets, peers, session } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    idTakenRetryWindowMs: windowMs,
    laterRegistration: refuseIdTaken,
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS + windowMs - 100);
  expect(await settlementOf(session)).toBe("waiting");
  await vi.advanceTimersByTimeAsync(200);
  const failure = await session.then(
    () => expect.unreachable("the wait should have failed"),
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(ConnectionError);
  expect((failure as ConnectionError).kind).toBe("usage");
  expect((failure as ConnectionError).message).toBe(
    idTakenAfterRetryMessage(windowMs),
  );
  expect(sockets.length).toBeGreaterThan(2);
  expect(peers[1].closeCalls).toBe(1);
});

test("a first registration refused as ID-TAKEN fails at once as the role mistake", async () => {
  const { socket, sockets, session } = await startRendezvous({
    role: "acceptor",
    confirmRegistration: false,
  });
  refuseIdTaken(socket);
  await expect(session).rejects.toThrow(ID_TAKEN_MESSAGE);
  expect(sockets).toHaveLength(1);
});

test("an interrupt during an ID-TAKEN retry ends the wait at once", async () => {
  holdAttemptClock();
  const interrupt = new AbortController();
  const { sockets, session } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    laterRegistration: refuseIdTaken,
    signal: interrupt.signal,
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  interrupt.abort();
  await expect(session).rejects.toThrow(/rendezvous was cancelled/);
});

test("a re-registration the coordination server drops is retried within the wait", async () => {
  const lines = captureDiagnostics();
  holdAttemptClock();
  const { sockets, peers, session, acceptorId } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    laterRegistration: (socket, index) => {
      if (index === 1) socket.drop();
      else socket.register();
    },
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  expect(await settlementOf(session)).toBe("waiting");
  expect(
    lines.find((line) =>
      line.includes("the coordination server closed the connection"),
    ),
  ).toContain("trying again until the wait for the partner ends");
  await vi.advanceTimersByTimeAsync(ID_TAKEN_RETRY_FIRST_DELAY_MS);
  await settleRegistration(sockets, 3);
  expect(peers).toHaveLength(2);
  offer(sockets[2], acceptorId, "dc_partner");
  await waitFor(
    () => sockets[2].ofType(BROKER_MESSAGE.answer).length === 1,
    NEGOTIATION_POLL,
  );
  const channel = new FakeChannel("dc_partner");
  peers[1].ondatachannel?.({ channel });
  channel.open();
  expect((await session).channel).toBe(channel);
});

test("a re-registration whose socket fails before the server answers is retried", async () => {
  captureDiagnostics();
  holdAttemptClock();
  const { sockets, session } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    laterRegistration: (socket, index) => {
      if (index === 1) socket.fail();
      else socket.register();
    },
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  expect(await settlementOf(session)).toBe("waiting");
  await vi.advanceTimersByTimeAsync(ID_TAKEN_RETRY_FIRST_DELAY_MS);
  await settleRegistration(sockets, 3);
  expect(await settlementOf(session)).toBe("waiting");
  expect(sockets[2].closeCalls).toBe(0);
});

test("a re-registration the server never confirms is retried once its open bound passes", async () => {
  captureDiagnostics();
  holdAttemptClock();
  const { sockets, session } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    laterRegistration: (socket, index) => {
      if (index !== 1) socket.register();
    },
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  await vi.advanceTimersByTimeAsync(
    BROKER_OPEN_TIMEOUT_MS + ID_TAKEN_RETRY_FIRST_DELAY_MS,
  );
  await settleRegistration(sockets, 3);
  expect(sockets[1].closeCalls).toBe(1);
  expect(await settlementOf(session)).toBe("waiting");
});

test("a re-registration the server never confirms ends at the deadline, not its open bound", async () => {
  captureDiagnostics();
  holdAttemptClock();
  const attemptMs = 20_000;
  const waitMs = 45_000;
  const { sockets, session } = await startRendezvous({
    role: "inviter",
    attemptMs,
    rendezvousTimeoutMs: waitMs,
    laterRegistration: (socket, index) => {
      if (index === 1) socket.drop();
    },
  });
  await vi.advanceTimersByTimeAsync(attemptMs);
  await settleRegistration(sockets, 2);
  await vi.advanceTimersByTimeAsync(ID_TAKEN_RETRY_FIRST_DELAY_MS);
  await settleRegistration(sockets, 3);
  // The retry's open now hangs; its own bound would end it 30 s on.
  expect(waitMs - attemptMs).toBeLessThan(BROKER_OPEN_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(
    waitMs - attemptMs - ID_TAKEN_RETRY_FIRST_DELAY_MS - 100,
  );
  expect(await settlementOf(session)).toBe("waiting");
  await vi.advanceTimersByTimeAsync(200);
  const failure = await session.then(
    () => expect.unreachable("the wait should have failed"),
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(ConnectionError);
  expect((failure as ConnectionError).kind).toBe("transport");
  expect((failure as ConnectionError).message).toMatch(
    /^the coordination server did not confirm registration within/,
  );
  expect(sockets).toHaveLength(3);
});

test("a re-registration still failing at the deadline fails with the coordination server's failure", async () => {
  captureDiagnostics();
  holdAttemptClock();
  const waitMs = 200_000;
  const { sockets, session } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: waitMs,
    laterRegistration: (socket) => socket.drop(),
  });
  await vi.advanceTimersByTimeAsync(waitMs - 1_000);
  expect(await settlementOf(session)).toBe("waiting");
  await vi.advanceTimersByTimeAsync(ID_TAKEN_RETRY_MAX_DELAY_MS + 1_000);
  const failure = await session.then(
    () => expect.unreachable("the wait should have failed"),
    (err: unknown) => err,
  );
  expect(failure).toBeInstanceOf(ConnectionError);
  expect((failure as ConnectionError).kind).toBe("transport");
  expect((failure as ConnectionError).message).toBe(
    "the coordination server closed the connection",
  );
  expect(sockets.length).toBeGreaterThan(3);
  expect(sockets.every((socket) => socket.closeCalls === 1)).toBe(true);
});

test("a first registration the coordination server drops fails at once", async () => {
  const { socket, sockets, session } = await startRendezvous({
    role: "acceptor",
    confirmRegistration: false,
  });
  socket.drop();
  await expect(session).rejects.toThrow(
    "the coordination server closed the connection",
  );
  expect(sockets).toHaveLength(1);
});

test("a broker socket dropped before the partner arrives starts the next attempt", async () => {
  const lines = captureDiagnostics();
  holdAttemptClock();
  const { socket, sockets, peers, session, inviterId } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    laterRegistration: (later, index) => {
      if (index === 1) refuseIdTaken(later);
      else later.register();
    },
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS / 2);
  socket.drop();
  await settleRegistration(sockets, 2);
  expect(await settlementOf(session)).toBe("waiting");
  expect(peers[0].closeCalls).toBe(1);
  expect(
    lines.find((line) =>
      line.includes("the coordination server closed the connection"),
    ),
  ).toContain("starting a new connection attempt");

  // The broker still holds the dropped socket's id, and the retry waits it out.
  await vi.advanceTimersByTimeAsync(ID_TAKEN_RETRY_FIRST_DELAY_MS);
  await settleRegistration(sockets, 3);
  await waitFor(
    () => sockets[2].ofType(BROKER_MESSAGE.offer).length === 1,
    NEGOTIATION_POLL,
  );
  answer(sockets[2], inviterId, offeredConnectionIds(sockets[2])[0]);
  await waitFor(
    () => peers[1].remoteDescriptions.length === 1,
    NEGOTIATION_POLL,
  );
  peers[1].channels[0].open();
  expect((await session).channel).toBe(peers[1].channels[0]);
});

test("a broker socket dropped as registration completes starts the next attempt", async () => {
  captureDiagnostics();
  holdAttemptClock();
  const { socket, sockets, peers, session, inviterId } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    confirmRegistration: false,
  });
  // Both run in one synchronous step, so the drop lands before the attempt's
  // run loop has started.
  socket.register();
  socket.drop();
  await settleRegistration(sockets, 2);
  expect(await settlementOf(session)).toBe("waiting");
  expect(peers[0].closeCalls).toBe(1);

  await waitFor(
    () => sockets[1].ofType(BROKER_MESSAGE.offer).length === 1,
    NEGOTIATION_POLL,
  );
  answer(sockets[1], inviterId, offeredConnectionIds(sockets[1])[0]);
  await waitFor(
    () => peers[1].remoteDescriptions.length === 1,
    NEGOTIATION_POLL,
  );
  peers[1].channels[0].open();
  expect((await session).channel).toBe(peers[1].channels[0]);
});

test("a broker socket error before the partner arrives starts the next attempt", async () => {
  const lines = captureDiagnostics();
  holdAttemptClock();
  const { socket, sockets, peers, session, inviterId } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS / 2);
  socket.fail();
  await settleRegistration(sockets, 2);
  expect(await settlementOf(session)).toBe("waiting");
  expect(peers[0].closeCalls).toBe(1);
  expect(
    lines.find((line) =>
      line.includes("the connection to the coordination server failed"),
    ),
  ).toContain("starting a new connection attempt");

  await waitFor(
    () => sockets[1].ofType(BROKER_MESSAGE.offer).length === 1,
    NEGOTIATION_POLL,
  );
  answer(sockets[1], inviterId, offeredConnectionIds(sockets[1])[0]);
  await waitFor(
    () => peers[1].remoteDescriptions.length === 1,
    NEGOTIATION_POLL,
  );
  peers[1].channels[0].open();
  expect((await session).channel).toBe(peers[1].channels[0]);
});

test("a broker socket dropped in the last attempt still waits out the rendezvous budget", async () => {
  captureDiagnostics();
  holdAttemptClock();
  const waitMs = 80_000;
  const { socket, sockets, session } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: waitMs,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  socket.drop();
  await settleRegistration(sockets, 2);
  await vi.advanceTimersByTimeAsync(waitMs - 30_000 - 1_000);
  expect(await settlementOf(session)).toBe("waiting");
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(session).rejects.toThrow(
    "Your partner did not connect within 80 seconds.",
  );
});

test("a broker socket dropped once the partner has answered fails the wait", async () => {
  const { socket, sockets, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
  });
  answer(socket, inviterId, offeredConnectionIds(socket)[0]);
  await waitFor(() => peer.remoteDescriptions.length === 1, NEGOTIATION_POLL);
  socket.drop();
  await expect(session).rejects.toThrow(
    /the coordination server closed the connection/,
  );
  expect(sockets).toHaveLength(1);
});

test("a broker error before the partner arrives fails the wait", async () => {
  const { socket, sockets, session } = await startRendezvous({
    role: "acceptor",
  });
  socket.deliver({ type: BROKER_MESSAGE.error, payload: { msg: "busy" } });
  await expect(session).rejects.toThrow(/reported an error/);
  expect(sockets).toHaveLength(1);
});

test("an acceptor sends no offer in the quiet period before an attempt that another follows", async () => {
  holdAttemptClock();
  const { socket, sockets, inviterId } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    attemptOfferQuietMs: 30_000,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    unreportedOfferResendMs: 20_000,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(15_000);
  socket.deliver({ type: BROKER_MESSAGE.expire, src: inviterId });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS - 35_000 - 1_000);
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1_000);
  await settleRegistration(sockets, 2);
  await waitFor(
    () => sockets[1].ofType(BROKER_MESSAGE.offer).length === 1,
    NEGOTIATION_POLL,
  );
});

test("the last attempt of a wait keeps offering to its end", async () => {
  holdAttemptClock();
  const { socket } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    attemptOfferQuietMs: 30_000,
    rendezvousTimeoutMs: ONE_MINUTE_MS,
    unreportedOfferResendMs: 20_000,
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS - 1_000);
  expect(socket.ofType(BROKER_MESSAGE.offer)).toHaveLength(3);
});

test("a partner that has answered is not cut off at the attempt's bound", async () => {
  holdAttemptClock();
  const { socket, sockets, peer, session, inviterId } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    channelOpenTimeoutMs: 30_000,
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS - 1_000);
  answer(socket, inviterId, offeredConnectionIds(socket)[0]);
  await waitFor(() => peer.remoteDescriptions.length === 1, NEGOTIATION_POLL);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sockets).toHaveLength(1);
  expect(peer.closeCalls).toBe(0);
  peer.channels[0].open();
  expect((await session).channel).toBe(peer.channels[0]);
});

test("an inviter whose answered partner goes quiet starts a new attempt after the channel-open budget", async () => {
  holdAttemptClock();
  const { socket, sockets, peers, acceptorId } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    channelOpenTimeoutMs: 10_000,
  });
  offer(socket, acceptorId, "dc_gone");
  await waitFor(
    () => socket.ofType(BROKER_MESSAGE.answer).length === 1,
    NEGOTIATION_POLL,
  );
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS + 9_000);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  await settleRegistration(sockets, 2);
  expect(peers[0].closeCalls).toBe(1);
});

const ATTEMPT_RELAY = [
  { urls: "turn:relay.example:3478", username: "minted", credential: "c2" },
];
const ATTEMPT_CREDENTIAL = {
  username: "1767229200:alcove",
  credential: "bWludGVk",
  expiresAt: new Date("2026-01-01T01:00:00Z"),
};

test("an inviter offered a new connection after answering answers it in a new attempt", async () => {
  const lines = captureDiagnostics();
  const reasons: Array<AttemptStartReason> = [];
  const { socket, sockets, peers, session, acceptorId } = await startRendezvous(
    {
      role: "inviter",
      attemptIceServers: (waitedMs, reason) => {
        reasons.push(reason);
        return Promise.resolve({
          iceServers: ATTEMPT_RELAY,
          notice: relayCredentialAttemptNotice(
            ATTEMPT_CREDENTIAL,
            waitedMs,
            reason,
          ),
        });
      },
    },
  );
  offer(socket, acceptorId, "dc_first");
  await waitFor(
    () => answeredConnectionIds(socket).length === 1,
    NEGOTIATION_POLL,
  );
  offer(socket, acceptorId, "dc_second");
  await settleRegistration(sockets, 2);
  expect(answeredConnectionIds(socket)).toEqual(["dc_first"]);
  expect(socket.closeCalls).toBe(1);
  expect(peers[0].closeCalls).toBe(1);

  // The broker delivered the new offer, so it holds nothing for the new
  // registration: the new attempt answers the offer the last one received.
  await waitFor(
    () => answeredConnectionIds(sockets[1]).length === 1,
    NEGOTIATION_POLL,
  );
  expect(answeredConnectionIds(sockets[1])).toEqual(["dc_second"]);
  expect(peers[1].remoteDescriptions).toEqual([OFFER_SDP]);
  const channel = new FakeChannel("dc_second");
  peers[1].ondatachannel?.({ channel });
  channel.open();
  expect((await session).channel).toBe(channel);

  expect(reasons).toEqual(["partner-reconnected"]);
  expect(
    lines.some((line) =>
      line.includes("the exchange partner started a new connection"),
    ),
  ).toBe(true);
  expect(lines.some((line) => line.includes("has not connected"))).toBe(false);
});

test("a later attempt of an inviter whose partner never offered names the wait", async () => {
  const lines = captureDiagnostics();
  holdAttemptClock();
  const { sockets } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  expect(
    lines.some((line) =>
      line.includes(
        "the exchange partner has not connected; starting connection attempt 2",
      ),
    ),
  ).toBe(true);
  expect(lines.some((line) => line.includes("started a new connection"))).toBe(
    false,
  );
});

test("an attempt that another follows whose channel does not open after the partner's description starts the next", async () => {
  const lines = captureDiagnostics();
  holdAttemptClock();
  const { socket, sockets, peers, session, inviterId } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    channelOpenTimeoutMs: 10_000,
  });
  peers[0].stats = iceStats([
    { type: "local-candidate", id: "L1", candidateType: "host" },
  ]);
  answer(socket, inviterId, offeredConnectionIds(socket)[0]);
  await waitFor(
    () => peers[0].remoteDescriptions.length === 1,
    NEGOTIATION_POLL,
  );
  await vi.advanceTimersByTimeAsync(9_000);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2_000);
  await settleRegistration(sockets, 2);
  expect(await settlementOf(session)).toBe("waiting");
  expect(peers[0].closeCalls).toBe(1);
  const warning = lines.find((line) =>
    line.includes("did not open within 10s"),
  );
  expect(warning).toContain(
    "local candidates gathered: no relay candidate gathered; 1 (host)",
  );
  expect(warning).toContain("starting a new connection attempt");

  await waitFor(
    () => sockets[1].ofType(BROKER_MESSAGE.offer).length === 1,
    NEGOTIATION_POLL,
  );
  answer(sockets[1], inviterId, offeredConnectionIds(sockets[1])[0]);
  await waitFor(
    () => peers[1].remoteDescriptions.length === 1,
    NEGOTIATION_POLL,
  );
  peers[1].channels[0].open();
  expect((await session).channel).toBe(peers[1].channels[0]);
});

test("the last attempt whose channel does not open after the partner's description fails the wait with the diagnosis", async () => {
  holdAttemptClock();
  const { sockets, peers, session, inviterId } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: 2 * ONE_MINUTE_MS,
    channelOpenTimeoutMs: 10_000,
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  await waitFor(
    () => sockets[1].ofType(BROKER_MESSAGE.offer).length === 1,
    NEGOTIATION_POLL,
  );
  peers[1].stats = iceStats([
    { type: "local-candidate", id: "L1", candidateType: "host" },
  ]);
  answer(sockets[1], inviterId, offeredConnectionIds(sockets[1])[0]);
  await waitFor(
    () => peers[1].remoteDescriptions.length === 1,
    NEGOTIATION_POLL,
  );
  await vi.advanceTimersByTimeAsync(11_000);
  const rendered = await renderedFailure(session);
  expect(rendered).toContain("did not open within 10s");
  expect(rendered).toContain(
    "local candidates gathered: no relay candidate gathered; 1 (host)",
  );
  expect(sockets).toHaveLength(2);
});
const ATTEMPT_NOTICE = "a new connection attempt starts with a new relay";

test("each attempt after the first is built from freshly resolved ICE servers", async () => {
  const lines = captureDiagnostics();
  const waits: Array<number> = [];
  const attemptIceServers = vi.fn(
    (waitedMs: number, reason: AttemptStartReason) => {
      expect(reason).toBe("partner-not-connected");
      waits.push(waitedMs);
      return Promise.resolve({
        iceServers: ATTEMPT_RELAY,
        notice: ATTEMPT_NOTICE,
      });
    },
  );
  holdAttemptClock();
  const { sockets, configurations } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    attemptIceServers,
  });
  expect(attemptIceServers).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 2);
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  await settleRegistration(sockets, 3);
  expect(attemptIceServers).toHaveBeenCalledTimes(2);
  expect(
    configurations.map((configuration) => configuration.iceServers),
  ).toEqual([[{ urls: "stun:127.0.0.1:3478" }], ATTEMPT_RELAY, ATTEMPT_RELAY]);
  expect(waits[0]).toBeGreaterThanOrEqual(ONE_MINUTE_MS);
  expect(waits[1]).toBeGreaterThanOrEqual(2 * ONE_MINUTE_MS);
  expect(lines.filter((line) => line.includes(ATTEMPT_NOTICE))).toHaveLength(2);
});

test("the no-ICE-servers warning is given once, not per attempt", async () => {
  const lines = captureDiagnostics();
  holdAttemptClock();
  const { sockets } = await startRendezvous({
    role: "inviter",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    iceServers: [],
  });
  await vi.advanceTimersByTimeAsync(2 * ONE_MINUTE_MS);
  await settleRegistration(sockets, 3);
  expect(
    lines.filter((line) => line.includes(NO_ICE_SERVERS_WARNING)),
  ).toHaveLength(1);
});

test("an attempt whose ICE servers cannot be resolved fails the wait", async () => {
  holdAttemptClock();
  const { sockets, session } = await startRendezvous({
    role: "acceptor",
    attemptMs: ONE_MINUTE_MS,
    rendezvousTimeoutMs: TEN_MINUTES_MS,
    attemptIceServers: () => Promise.reject(new Error("no secret")),
  });
  await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
  const error = await session.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ConnectionError);
  expect(sanitizeErrorForDisplay(error)).toMatch(
    /could not be started with a fresh relay credential/,
  );
  expect(sockets).toHaveLength(1);
});
