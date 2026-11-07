/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, inject, test } from "vitest";

import Peer from "peerjs";

import {
  PEERJS_SERIALIZATION,
  binaryBytes,
  generateSharedSecret,
} from "@alcove/core";

import { dialAsAcceptor, listenAsInviter } from "@psi/transport/rendezvous";
import { boundPeerSignaling } from "@psi/transport/signalingBounds";
import { openPeerMessageConnection } from "@psi/transport/peerMessageConnection";
import { waitForIncomingConnection } from "@psi/transport/waitForConnection";

import { canReachServer } from "../utils/pspiFixtures.js";

import type { DataConnection, PeerOptions } from "peerjs";
import type { WebRTCEndpoint } from "@alcove/core";

/**
 * The connections a registered peer is offered past the one a run takes, in
 * real Chromium over the standalone broker: the inviter closes a second offer
 * from its partner's peer and an offer from any other peer id, the acceptor
 * closes every inbound offer, and a frame on the run's own connection still
 * arrives afterwards.
 *
 * Every peer runs on one machine, so each is built with no ICE server: a
 * loopback host candidate connects them, and no STUN server is contacted.
 */

// Published by the browser project's globalSetup; absent, the probe below
// skips the suite.
const brokerPort = inject("signalingBrokerPort") ?? 0;
const brokerHost = "127.0.0.1";
const hostString = `http://${brokerHost}:${String(brokerPort)}`;

const endpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: brokerHost,
  port: brokerPort,
  path: "/api/",
};

/** Long enough for a loopback channel that was answered to open. */
const OPEN_WINDOW_MS = 3_000;

const peers: Array<Peer> = [];

afterEach(() => {
  for (const peer of peers.splice(0)) peer.destroy();
});

function hermeticPeer(id: string, options: PeerOptions): Peer {
  const peer = boundPeerSignaling(
    new Peer(id, { ...options, config: { ...options.config, iceServers: [] } }),
  );
  peers.push(peer);
  return peer;
}

/** A peer the broker names, registered as no party of the run. */
async function strangerPeer(): Promise<Peer> {
  const peer = new Peer({
    host: brokerHost,
    port: brokerPort,
    path: "/api/",
    config: { iceServers: [] },
    debug: 0,
  });
  peers.push(peer);
  await new Promise<void>((resolve, reject) => {
    peer.once("open", () => resolve());
    peer.once("error", reject);
  });
  return peer;
}

/** The connections `peer` is handed after its guard has seen them. */
function offeredTo(peer: Peer): Array<DataConnection> {
  const offered: Array<DataConnection> = [];
  peer.on("connection", (conn) => offered.push(conn));
  return offered;
}

/** Resolves after the open window with whether `conn` opened. */
function openedWithin(conn: DataConnection): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(conn.open), OPEN_WINDOW_MS);
    conn.once("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function expectRefused(peer: Peer, conn: DataConnection): void {
  expect(conn.open).toBe(false);
  expect(peer.getConnection(conn.peer, conn.connectionId)).toBeNull();
}

test(
  "a registered peer closes every connection it is offered past the run's own",
  { timeout: 60_000 },
  async (ctx) => {
    if (!(await canReachServer(hostString)))
      return ctx.skip(
        `PeerJS coordination server at ${hostString} unreachable`,
      );
    const secret = generateSharedSecret();
    const inviterPeer = await listenAsInviter(secret, endpoint, {
      peerFactory: hermeticPeer,
    });
    const inbound = waitForIncomingConnection(inviterPeer);
    const [acceptorPeer, acceptorConn] = await dialAsAcceptor(
      secret,
      endpoint,
      { peerFactory: hermeticPeer },
    );
    const inviterConn = await inbound;
    const toInviter = offeredTo(inviterPeer);
    const toAcceptor = offeredTo(acceptorPeer);

    const second = acceptorPeer.connect(inviterPeer.id, {
      serialization: PEERJS_SERIALIZATION,
      reliable: true,
    });
    const stranger = await strangerPeer();
    const fromStranger = stranger.connect(inviterPeer.id, {
      serialization: PEERJS_SERIALIZATION,
      reliable: true,
    });
    const intoAcceptor = inviterPeer.connect(acceptorPeer.id, {
      serialization: PEERJS_SERIALIZATION,
      reliable: true,
    });
    const opened = await Promise.all(
      [second, fromStranger, intoAcceptor].map(openedWithin),
    );
    expect(opened).toEqual([false, false, false]);

    expect(toInviter.map((conn) => conn.peer).sort()).toEqual(
      [acceptorPeer.id, stranger.id].sort(),
    );
    for (const conn of toInviter) expectRefused(inviterPeer, conn);
    expect(toAcceptor.map((conn) => conn.peer)).toEqual([inviterPeer.id]);
    for (const conn of toAcceptor) expectRefused(acceptorPeer, conn);

    const [inviterSide, acceptorSide] = await Promise.all([
      openPeerMessageConnection(inviterConn),
      openPeerMessageConnection(acceptorConn),
    ]);
    try {
      await acceptorSide.send(new Uint8Array([1, 2, 3]));
      const received = binaryBytes(await inviterSide.receive());
      expect(received && Array.from(received)).toEqual([1, 2, 3]);
    } finally {
      await Promise.allSettled([inviterSide.close(), acceptorSide.close()]);
    }
  },
);
