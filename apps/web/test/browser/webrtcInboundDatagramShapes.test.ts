/// <reference types="@vitest/browser-playwright/context" />

import { expect, inject, test } from "vitest";

import { WEBRTC_MALFORMED_DATAGRAM_FIXTURES } from "@alcove/testkit/webrtcInboundFrames";
import { generateSharedSecret } from "@alcove/core";

import { openPeerMessageConnection } from "../../src/psi/transport/peerMessageConnection.js";

import { canReachServer } from "../utils/pspiFixtures.js";
import { connectRendezvousPair } from "../utils/rendezvousPair.js";

/**
 * The web transport's receive path against the shared malformed datagrams, sent
 * on the real data channel between a real PeerJS pair in real Chromium. Only the
 * real stack says what PeerJS hands its unpack for a text or zero-length message
 * and what that unpack makes of it, so only it can show each is refused rather
 * than delivered or left waiting.
 */

const addressInfo = {
  address: "127.0.0.1",
  port: inject("signalingBrokerPort") ?? 0,
};
const hostString = `http://${addressInfo.address}:${String(addressInfo.port)}`;
const serverUnreachableNote = `PeerJS coordination server at ${hostString} unreachable`;

for (const fixture of WEBRTC_MALFORMED_DATAGRAM_FIXTURES) {
  test(`refuses ${fixture.label}`, async (ctx) => {
    if (!(await canReachServer(hostString)))
      return ctx.skip(serverUnreachableNote);

    const pair = await connectRendezvousPair(
      generateSharedSecret(),
      addressInfo,
    );
    try {
      const receiverMc = await openPeerMessageConnection(pair.inviterConn);
      const channel = pair.acceptorConn.dataChannel;
      if (typeof fixture.datagram === "string") channel.send(fixture.datagram);
      else channel.send(fixture.datagram as Uint8Array<ArrayBuffer>);

      const outcome = await receiverMc.receive(10_000).then(
        (value: unknown) => ({ delivered: value }),
        (err: unknown) => ({
          kind: (err as { kind?: unknown }).kind,
          message: (err as { message?: unknown }).message,
        }),
      );
      expect(outcome, fixture.label).toEqual({
        kind: "protocol",
        message: fixture.message,
      });

      await receiverMc.close();
    } finally {
      pair.inviterPeer.destroy();
      pair.acceptorPeer.destroy();
    }
  }, 60_000);
}
