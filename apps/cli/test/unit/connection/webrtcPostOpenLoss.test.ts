import { afterEach, expect, test } from "vitest";

import { RTCPeerConnection } from "werift";

import type { RTCDataChannel } from "werift";

// The session treats any departure from `connected` after the channel opens as
// the partner lost (weriftPeer.ts, the post-open state hook). That holds only
// if werift has no post-open state it recovers from: driven here over a real
// loopback pair, a partner that goes silent past werift's consent window takes
// this side to `failed`, never through `disconnected`, and its packets flowing
// again do not bring the connection back.

/**
 * An unreachable STUN entry: nothing listens on this loopback port, so werift
 * gathers host candidates only rather than selecting its built-in default.
 */
const HOST_ONLY_ICE = [{ urls: "stun:127.0.0.1:3478" }];

/** werift's consent window: RFC 7675's 30 s since the last answered check. */
const CONSENT_WINDOW_MS = 30_000;

const peers: Array<RTCPeerConnection> = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close().catch(() => {});
});

/** Two werift peers on loopback with a data channel open between them. */
async function openLoopbackPair(): Promise<{
  local: RTCPeerConnection;
  remote: RTCPeerConnection;
  channel: RTCDataChannel;
}> {
  const local = new RTCPeerConnection({ iceServers: HOST_ONLY_ICE });
  const remote = new RTCPeerConnection({ iceServers: HOST_ONLY_ICE });
  peers.push(local, remote);
  local.onicecandidate = ({ candidate }) => {
    if (candidate) void remote.addIceCandidate(candidate);
  };
  remote.onicecandidate = ({ candidate }) => {
    if (candidate) void local.addIceCandidate(candidate);
  };
  const channel = local.createDataChannel("loss", { ordered: true });
  const opened = new Promise<void>((resolve) => {
    channel.onopen = () => resolve();
  });
  // Trickled rather than gathered first, so the unreachable STUN entry's
  // timeout is not spent before the descriptions are exchanged.
  const offer = await local.createOffer();
  void local.setLocalDescription(offer);
  await remote.setRemoteDescription(offer);
  const answer = await remote.createAnswer();
  void remote.setLocalDescription(answer);
  await local.setRemoteDescription(answer);
  await opened;
  return { local, remote, channel };
}

/**
 * Drop everything `peer` sends -- ICE checks, their answers and data alike --
 * until the returned function is called, as a partner cut off from the network
 * and then reconnected would.
 */
function silence(peer: RTCPeerConnection): () => void {
  let silenced = true;
  const protocols = (
    peer as unknown as {
      iceTransports: Array<{
        connection: {
          protocols: Array<{
            transport: { send: (...args: Array<unknown>) => Promise<void> };
          }>;
        };
      }>;
    }
  ).iceTransports[0].connection.protocols;
  expect(protocols.length).toBeGreaterThan(0);
  for (const protocol of protocols) {
    const send = protocol.transport.send.bind(protocol.transport);
    protocol.transport.send = (...args) =>
      silenced ? Promise.resolve() : send(...args);
  }
  return () => {
    silenced = false;
  };
}

test(
  "a partner silent past the consent window fails the connection, which does not recover",
  async () => {
    const { local, remote } = await openLoopbackPair();
    expect(local.connectionState).toBe("connected");
    const states: Array<string> = [];
    const left = new Promise<void>((resolve) => {
      local.onconnectionstatechange = () => {
        states.push(local.connectionState);
        if (local.connectionState !== "connected") resolve();
      };
    });

    const restore = silence(remote);
    const silencedAt = Date.now();
    await left;
    // The window runs from the last answered check, up to one check interval
    // (at most 6 s) before the silence began, so the failure lands well past
    // any single unanswered check.
    expect(Date.now() - silencedAt).toBeGreaterThanOrEqual(
      CONSENT_WINDOW_MS - 10_000,
    );
    expect(states).toEqual(["failed"]);

    // More than one consent-check interval (werift: about 5 s) with the
    // partner answering again.
    restore();
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(local.connectionState).toBe("failed");
    expect(states).toEqual(["failed"]);
  },
  CONSENT_WINDOW_MS + 45_000,
);
