/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, inject, test } from "vitest";

import Peer from "peerjs";

import { decodeInvitation } from "@alcove/core";

import { dialAsAcceptor, listenAsInviter } from "@psi/transport/rendezvous";
import {
  parseCoordinationServerUrl,
  writeCoordinationServerSetting,
} from "@psi/transport/coordinationServerSetting";
import { boundPeerSignaling } from "@psi/transport/signalingBounds";
import { generateInvitation } from "@psi/invitation";
import { invitationLocation } from "@psi/invitationLocation";
import { waitForIncomingConnection } from "@psi/transport/waitForConnection";

import { canReachServer } from "../utils/pspiFixtures.js";

import type { DataConnection, PeerOptions } from "peerjs";
import type { WebRTCEndpoint } from "@alcove/core";

/**
 * A browser inviter with its own coordination server set, in real Chromium
 * over the standalone broker: the invitation it creates names that server,
 * the inviter registers there rather than at this page's own `/api/`, and an
 * acceptor dialling the server the invitation names reaches it.
 *
 * Both peers run on one machine, so each is built with no ICE server: a
 * loopback host candidate connects them, and no STUN server is contacted.
 */

// Published by the browser project's globalSetup; absent, the probe below
// skips the suite.
const brokerPort = inject("signalingBrokerPort") ?? 0;
const brokerHost = "127.0.0.1";
const hostString = `http://${brokerHost}:${String(brokerPort)}`;

/** `options` with no ICE server, on a peer whose signaling is bounded as a
 * run's is. */
function hermeticPeer(id: string, options: PeerOptions): Peer {
  return boundPeerSignaling(
    new Peer(id, { ...options, config: { ...options.config, iceServers: [] } }),
  );
}

const peers: Array<Peer> = [];

afterEach(() => {
  for (const peer of peers.splice(0)) peer.destroy();
  writeCoordinationServerSetting(undefined);
});

test(
  "an inviter with its own coordination server registers there, and an acceptor reaches it",
  { timeout: 60_000 },
  async (ctx) => {
    if (!(await canReachServer(hostString)))
      return ctx.skip(
        `PeerJS coordination server at ${hostString} unreachable`,
      );
    const entry = parseCoordinationServerUrl(
      `ws://${brokerHost}:${String(brokerPort)}/api/`,
      window.location.protocol,
    );
    if (!entry.ok) throw new Error(entry.message);
    writeCoordinationServerSetting(entry.url);

    const minted = await generateInvitation({
      allowedRelays: undefined,
      inviterName: "County Health Dept",
      profiledColumns: ["ssn", "first_name", "last_name", "dob"],
      location: invitationLocation(),
      defaultRelay: () => undefined,
    });
    const named = (await decodeInvitation(minted.encoded)).connectionEndpoint;
    const expected: WebRTCEndpoint = {
      channel: "webrtc",
      host: brokerHost,
      port: brokerPort,
      path: "/api/",
    };
    expect(named).toEqual(expected);
    expect(Number(window.location.port)).not.toBe(brokerPort);

    let registeredAt: PeerOptions | undefined;
    const inviterPeer = await listenAsInviter(
      minted.sharedSecret,
      named as WebRTCEndpoint,
      {
        peerFactory: (id, options) => {
          registeredAt = options;
          const peer = hermeticPeer(id, options);
          peers.push(peer);
          return peer;
        },
      },
    );
    expect(registeredAt).toMatchObject({
      host: brokerHost,
      port: brokerPort,
      path: "/api/",
    });
    expect(inviterPeer.open).toBe(true);

    const inbound: Promise<DataConnection> =
      waitForIncomingConnection(inviterPeer);
    const [acceptorPeer, acceptorConn] = await dialAsAcceptor(
      minted.sharedSecret,
      named as WebRTCEndpoint,
      {
        peerFactory: (id, options) => {
          const peer = hermeticPeer(id, options);
          peers.push(peer);
          return peer;
        },
      },
    );
    const inviterConn = await inbound;

    expect(acceptorPeer.options).toMatchObject({
      host: brokerHost,
      port: brokerPort,
      path: "/api/",
    });
    expect(acceptorConn.open).toBe(true);
    expect(inviterConn.peer).toBe(acceptorPeer.id);
  },
);
