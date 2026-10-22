/// <reference types="@vitest/browser-playwright/context" />

import { beforeEach, expect, inject, test } from "vitest";

import Peer from "peerjs";

import {
  BoundedInboundFrames,
  deriveRelayExchangeId,
  deriveRelayKey,
  deriveRendezvousPeerId,
  generateSharedSecret,
  prepareForExchange,
} from "@alcove/core";
import { AEAD_ENVELOPE_VERSION } from "@alcove/core/testing";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  openOneShotPeerConnection,
  runExchangeLifecycle,
} from "@psi/exchangeLifecycle";
import { dialAsAcceptor } from "@psi/transport/rendezvous";
import { openRunConnectionWithRelayFallback } from "@psi/transport/relayFallback";
import { waitForIncomingConnection } from "@psi/transport/waitForConnection";

import {
  canReachServer,
  clientRows,
  firstNameOnlyTerms,
  serverRows,
} from "../utils/pspiFixtures.js";

import type { PreparedExchange, RendezvousRole } from "@alcove/core";
import type {
  WebRtcPathFailure,
  WebRtcPathHooks,
} from "@psi/transport/relayFallback";
import type { ExchangeErrorCategory } from "@psi/exchangeLifecycle";
import type { ForwardedMessage } from "../devServer/websocketRelay.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { PeerCloseOutcome } from "@psi/transport/waitForPeerClose";
import type { PeerOptions } from "peerjs";
import type { RunConnection } from "@psi/transport/runConnection";

// The fallback from WebRTC to the WebSocket relay, both browser parties in real
// Chromium over the standalone broker and the relay the browser project's
// globalSetup runs: with WebRTC blocked the exchange completes over the relay,
// every message after the key exchange an AEAD envelope as read at the relay;
// with WebRTC open the relay sockets close unused. The relay is reached through
// the relay client's socket factory over loopback `ws`, as the production
// client dials `wss` only.

const brokerPort = inject("signalingBrokerPort") ?? 0;
const relayAddress = inject("websocketRelay");
const brokerHost = "127.0.0.1";
const hostString = `http://${brokerHost}:${String(brokerPort)}`;

/** The relay address the parties list; its socket goes to the test relay. */
const LISTED_RELAY_URL = "wss://relay.invalid/relay";

/** A TLS relay under a reserved name that never resolves (RFC 6761). Held to
 * relay candidates alone, a party with only this relay has no WebRTC path,
 * as on a network that stops TURN. */
const UNREACHABLE_TURN_URL = "turns:relay.invalid:443";

/** The acceptor's channel-open bound, short of the default 30 s. */
const OPEN_TIMEOUT_MS = 8_000;

beforeEach(async (ctx) => {
  if (relayAddress === undefined) ctx.skip("no WebSocket relay was provided");
  if (!(await canReachServer(hostString)))
    ctx.skip(`PeerJS coordination server at ${hostString} unreachable`);
});

function relayOnly(options: PeerOptions): PeerOptions {
  return {
    ...options,
    config: { ...options.config, iceTransportPolicy: "relay" },
  };
}

/** What one party's relay sockets were sent and closed with. */
interface SocketRecord {
  opened: Array<WebSocket>;
  sent: Array<string>;
  /** The codes this side closed its sockets with. */
  closedWith: Array<number>;
}

/** One party, its WebRTC path open or blocked, listing the test relay. */
interface Party {
  role: RendezvousRole;
  sockets: SocketRecord;
  pathFailures: Array<WebRtcPathFailure>;
  notices: Array<string>;
  open: (context: {
    signal: AbortSignal;
    onCloseOutcome: (outcome: PeerCloseOutcome) => void;
    onRunNotice: (notice: string) => void;
  }) => Promise<RunConnection>;
}

async function enroll(secret: string): Promise<{
  exchangeId: string;
  relayKey: string;
}> {
  const exchangeId = await deriveRelayExchangeId(secret);
  const relayKey = await deriveRelayKey(secret);
  const response = await fetch(
    `${relayAddress?.testOrigin}/enroll?exchange_id=${exchangeId}&key=${relayKey}`,
  );
  expect(response.status).toBe(204);
  return { exchangeId, relayKey };
}

function party(
  role: RendezvousRole,
  secret: string,
  exchangeId: string,
  blocked: boolean,
): Party {
  const sockets: SocketRecord = { opened: [], sent: [], closedWith: [] };
  const pathFailures: Array<WebRtcPathFailure> = [];
  const createSocket = (): WebSocket => {
    const socket = new WebSocket(relayAddress?.url ?? "");
    sockets.opened.push(socket);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (typeof data === "string") sockets.sent.push(data);
      send(data);
    };
    const close = socket.close.bind(socket);
    socket.close = (code, reason) => {
      if (code !== undefined) sockets.closedWith.push(code);
      close(code, reason);
    };
    return socket;
  };
  const turn = blocked ? [UNREACHABLE_TURN_URL] : [];
  const policy = (options: PeerOptions) =>
    blocked ? relayOnly(options) : options;

  const openWebRtc = async (
    { signal, onPathFailed }: WebRtcPathHooks,
    onCloseOutcome: (outcome: PeerCloseOutcome) => void,
  ): Promise<RunConnection> => {
    const reported = (failure: WebRtcPathFailure) => {
      pathFailures.push(failure);
      onPathFailed?.(failure);
    };
    if (role === "acceptor") {
      const [peer, conn] = await dialAsAcceptor(
        secret,
        {
          channel: "webrtc",
          host: brokerHost,
          port: brokerPort,
          path: "/api/",
        },
        {
          signal,
          relay: { turn, stun: [] },
          openTimeoutMs: OPEN_TIMEOUT_MS,
          peerFactory: (id, options) => new Peer(id, policy(options)),
          onPathFailed: reported,
        },
      );
      return openOneShotPeerConnection(peer, conn, {
        signal,
        onCloseOutcome,
        onPathFailed: reported,
      });
    }
    const peer = new Peer(
      await deriveRendezvousPeerId(secret, "inviter"),
      policy({
        host: brokerHost,
        port: brokerPort,
        path: "/api/",
        config: {
          iceServers: blocked
            ? [{ urls: turn, username: "u", credential: "c" }]
            : [],
        },
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        peer.once("open", () => resolve());
        peer.once("error", reject);
      });
      const conn = await waitForIncomingConnection(peer, {
        signal,
        onPathFailed: reported,
      });
      return await openOneShotPeerConnection(peer, conn, {
        signal,
        onCloseOutcome,
        onPathFailed: reported,
      });
    } catch (error) {
      peer.destroy();
      throw error;
    }
  };

  const notices: Array<string> = [];
  return {
    role,
    sockets,
    pathFailures,
    notices,
    open: ({ signal, onCloseOutcome, onRunNotice }) =>
      openRunConnectionWithRelayFallback(
        {
          role,
          sharedSecret: secret,
          relays: [{ url: LISTED_RELAY_URL, exchangeId }],
          signal,
          onCloseOutcome,
          onRunNotice: (notice) => {
            notices.push(notice);
            onRunNotice(notice);
          },
          openWebRtc: (hooks) => openWebRtc(hooks, onCloseOutcome),
        },
        { createSocket },
      ),
  };
}

function prepared(role: RendezvousRole): PreparedExchange {
  const identity = role === "inviter" ? "server" : "client";
  return prepareForExchange(
    { linkageTerms: { ...firstNameOnlyTerms, identity } },
    identity,
    role === "inviter" ? serverRows : clientRows,
    ["first_name"],
  );
}

/** Run one party's whole exchange through the app's lifecycle. */
async function runParty(
  runner: Party,
  secret: string,
  psiLibrary: PSILibrary,
): Promise<{
  results: number;
  errors: Array<{ category: ExchangeErrorCategory; error: unknown }>;
}> {
  let results = 0;
  const errors: Array<{ category: ExchangeErrorCategory; error: unknown }> = [];
  await runExchangeLifecycle({
    acquire: async (context) => ({
      ...(await runner.open(context)),
      psi: Promise.resolve(psiLibrary),
      prepared: prepared(runner.role),
    }),
    exchangeRole: runner.role === "inviter" ? "responder" : "initiator",
    sharedSecret: secret,
    signal: new AbortController().signal,
    generateOutput: () => ({ kind: "matched" as const, resultsUrl: "blob:x" }),
    onStages: () => {},
    onStage: () => {},
    onResult: () => {
      results += 1;
    },
    onError: (failure) => errors.push(failure),
  });
  return { results, errors };
}

/** The frames one party sent through the relay, reassembled from the binary
 * messages the relay forwarded. */
function framesFrom(
  messages: Array<ForwardedMessage>,
  from: RendezvousRole,
): Array<unknown> {
  const frames = new BoundedInboundFrames();
  const values: Array<unknown> = [];
  for (const message of messages) {
    if (message.from !== from) continue;
    const bytes = Uint8Array.from(atob(message.base64), (c) => c.charCodeAt(0));
    const outcome = frames.accept(bytes);
    if (outcome.kind === "frame") values.push(outcome.value);
  }
  return values;
}

function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

test(
  "with WebRTC blocked the exchange completes over the relay, every frame after the key exchange an AEAD envelope at the relay",
  { timeout: 120_000 },
  async () => {
    const secret = generateSharedSecret();
    const { exchangeId, relayKey } = await enroll(secret);
    const psiLibrary = await (PSI() as Promise<PSILibrary>);
    const inviter = party("inviter", secret, exchangeId, true);
    const acceptor = party("acceptor", secret, exchangeId, true);

    const [inviterRun, acceptorRun] = await Promise.all([
      runParty(inviter, secret, psiLibrary),
      runParty(acceptor, secret, psiLibrary),
    ]);

    expect(inviterRun).toEqual({ results: 1, errors: [] });
    expect(acceptorRun).toEqual({ results: 1, errors: [] });
    const relayNotice =
      "This exchange runs over the WebSocket relay at wss://relay.invalid.";
    expect(inviter.notices).toEqual([relayNotice]);
    expect(acceptor.notices).toEqual([relayNotice]);
    // Chromium reports no ICE failure for a party with no candidate, so the
    // acceptor's start waits for its channel-open bound; it then abandons the
    // inviter's WebRTC open.
    expect(acceptor.pathFailures).toEqual(["channel-not-opened"]);

    const forwarded = (await (
      await fetch(`${relayAddress?.testOrigin}/forwarded?key=${relayKey}`)
    ).json()) as Array<ForwardedMessage>;
    for (const from of ["inviter", "acceptor"] as const) {
      const frames = framesFrom(forwarded, from);
      const firstEnvelope = frames.findIndex((frame) => bytesOf(frame));
      const handshake = frames.slice(0, firstEnvelope);
      const wrapped = frames.slice(firstEnvelope);
      expect(handshake.length).toBeGreaterThan(0);
      for (const frame of handshake) expect(bytesOf(frame)).toBeUndefined();
      expect(wrapped.length).toBeGreaterThan(0);
      for (const frame of wrapped)
        expect(bytesOf(frame)?.[0]).toBe(AEAD_ENVELOPE_VERSION);
    }
  },
);

test(
  "with WebRTC open the relay sockets close unused",
  { timeout: 60_000 },
  async () => {
    const secret = generateSharedSecret();
    const { exchangeId, relayKey } = await enroll(secret);
    const inviter = party("inviter", secret, exchangeId, false);
    const acceptor = party("acceptor", secret, exchangeId, false);
    const context = {
      signal: new AbortController().signal,
      onCloseOutcome: () => {},
      onRunNotice: () => {},
    };

    const opened = await Promise.all([
      inviter.open(context),
      acceptor.open(context),
    ]);

    const webRtcNotice = "This exchange runs over the WebRTC connection.";
    expect(inviter.notices).toEqual([webRtcNotice]);
    expect(acceptor.notices).toEqual([webRtcNotice]);
    for (const { sockets } of [inviter, acceptor]) {
      expect(sockets.opened.length).toBeGreaterThan(0);
      await expect
        .poll(() =>
          sockets.opened.every(
            (socket) => socket.readyState === WebSocket.CLOSED,
          ),
        )
        .toBe(true);
      expect(
        sockets.sent.map(
          (frame) => (JSON.parse(frame) as { type: string }).type,
        ),
      ).not.toContain("start");
    }
    // A socket the relay closed first, as its partner closed, takes no close
    // from this side, so one side's list may be empty.
    const closedWith = [
      ...inviter.sockets.closedWith,
      ...acceptor.sockets.closedWith,
    ];
    expect(closedWith.length).toBeGreaterThan(0);
    expect(closedWith.every((code) => code === 1000)).toBe(true);
    const forwarded = (await (
      await fetch(`${relayAddress?.testOrigin}/forwarded?key=${relayKey}`)
    ).json()) as Array<ForwardedMessage>;
    expect(forwarded).toEqual([]);
    for (const { connection, release } of opened) {
      await connection.close();
      release();
    }
  },
);
