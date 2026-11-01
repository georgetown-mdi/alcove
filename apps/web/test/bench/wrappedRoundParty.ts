import Peer from "peerjs";

import {
  EncryptedMessageConnection,
  deriveRendezvousPeerId,
} from "@alcove/core";
import { PSIParticipant } from "@alcove/core/testing";

import { openPeerMessageConnection } from "../../src/psi/transport/peerMessageConnection";

import type { DataConnection, PeerOptions } from "peerjs";
import type {
  HandshakeRole,
  MessageConnection,
  PsiEngine,
  PsiEngineMode,
} from "@alcove/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// The page side both parties of browserWrappedRound.ts share, bundled into each
// of its pages: a PeerJS data channel through the repository's broker, opened
// as the web app opens one (openPeerMessageConnection) and wrapped in core's
// EncryptedMessageConnection, then one PSI round of core's own participant
// over it. The wrap is keyed from a session key the bench hands both pages
// rather than from a key exchange, whose frames are a few hundred bytes.

// The round's steps run for longer than the transport's parked-receive budget
// on a host slower than the one the ceiling was measured on, and a round the
// budget ends measures nothing; the bench measures memory, not that budget.
const BENCH_INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// The participant reads the library only to build an in-process engine when
// it is handed none, and both bench parties hand it one.
const NO_LIBRARY = undefined as unknown as PSILibrary;

function peerOptions(brokerPort: number): PeerOptions {
  // Both browsers run on one host, so a loopback host candidate is all they need.
  return {
    host: "127.0.0.1",
    port: brokerPort,
    path: "/api/",
    config: { iceServers: [] },
  };
}

function opened(peer: Peer): Promise<void> {
  return new Promise((resolve, reject) => {
    peer.once("open", () => resolve());
    peer.once("error", (error) => reject(error));
  });
}

/**
 * Registers this page as the inviter, the party that listens, and resolves once
 * the broker has it, with the wait for the acceptor's channel to open.
 */
export async function listen(
  brokerPort: number,
  sharedSecret: string,
): Promise<{ channel: Promise<DataConnection> }> {
  const peer = new Peer(
    await deriveRendezvousPeerId(sharedSecret, "inviter"),
    peerOptions(brokerPort),
  );
  await opened(peer);
  const channel = new Promise<DataConnection>((resolve, reject) => {
    peer.once("connection", (conn) => conn.once("open", () => resolve(conn)));
    peer.once("error", (error) => reject(error));
  });
  return { channel };
}

/** Dials the inviter as the acceptor and resolves once the channel is open. */
export async function dial(
  brokerPort: number,
  sharedSecret: string,
): Promise<DataConnection> {
  const inviterId = await deriveRendezvousPeerId(sharedSecret, "inviter");
  const peer = new Peer(
    await deriveRendezvousPeerId(sharedSecret, "acceptor"),
    peerOptions(brokerPort),
  );
  await opened(peer);
  return new Promise<DataConnection>((resolve, reject) => {
    const conn = peer.connect(inviterId, { reliable: true });
    conn.once("open", () => resolve(conn));
    peer.once("error", (error) => reject(error));
  });
}

/** The web app's connection over `channel`, wrapped as its handshake wraps it. */
export async function wrap(
  channel: DataConnection,
  sessionKey: ReadonlyArray<number>,
  role: HandshakeRole,
): Promise<MessageConnection> {
  const connection = await openPeerMessageConnection(channel, {
    inactivityTimeoutMs: BENCH_INACTIVITY_TIMEOUT_MS,
  });
  return EncryptedMessageConnection.create(
    connection,
    new Uint8Array(sessionKey),
    role,
  );
}

/** One party's side of the round. */
export interface RoundSide {
  readonly id: string;
  readonly role: "starter" | "joiner";
  readonly mode: PsiEngineMode;
  readonly starterElements: number;
  readonly joinerElements: number;
  /** The receive ceiling this party holds the partner's sets to. */
  readonly ownCeiling: number;
  /** The receive ceiling the partner states, which this party's sets are held to. */
  readonly partnerCeiling: number;
}

/** What one party's round returned: the matched pairs. */
export interface RoundOutcome {
  readonly pairs: Array<[number, number]>;
}

/**
 * Runs one PSI round of core's participant over `connection`, as a cascade
 * round runs one, with the element bounds the two set sizes give.
 */
export async function runRound(
  connection: MessageConnection,
  engine: PsiEngine,
  side: RoundSide,
  values: Array<string>,
): Promise<RoundOutcome> {
  const participant = new PSIParticipant(
    side.id,
    NO_LIBRARY,
    { role: side.role },
    { setup: side.starterElements, request: side.joinerElements },
    engine,
    undefined,
    { local: side.ownCeiling, partner: side.partnerCeiling },
  );
  try {
    const [local, partner] = await participant.identifyIntersection(
      connection,
      values,
    );
    return { pairs: local.map((index, pair) => [index, partner[pair]]) };
  } finally {
    participant.dispose();
  }
}
