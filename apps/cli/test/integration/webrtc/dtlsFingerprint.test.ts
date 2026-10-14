import { RTCPeerConnection } from "werift";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import { startRefusingStunServer } from "./refusingStunServer";

import type { RTCIceServer } from "werift";
import type { RefusingStunServer } from "./refusingStunServer";

/**
 * werift's check of the remote DTLS certificate against the `a=fingerprint`
 * line of the SDP the peer was handed. The CLI's `webrtc` channel adds no
 * application-layer encryption, so this check is what binds the data channel
 * to the description that negotiated it. The assumption and its
 * re-verification on a bump are in docs/spec/DEPENDENCY_PINS.md.
 *
 * Two real werift peers meet over loopback with host candidates only, as in
 * transport.test.ts, handing each other their descriptions directly.
 */

/** How long a handshake that must fail is given before the test reports a hang. */
const FAILURE_WINDOW_MS = 30_000;

/**
 * How long past the first failure the pair is watched, so a channel that opened
 * late or a message that arrived late is counted rather than missed.
 */
const SETTLE_AFTER_FAILURE_MS = 2_000;

const PAYLOAD = "fingerprint-check";

let stunServer: RefusingStunServer;
let hostOnlyIce: Array<RTCIceServer>;
const openPeers: Array<RTCPeerConnection> = [];

snapshotDiagnosticSinkAndLevel();

beforeAll(async () => {
  stunServer = await startRefusingStunServer();
  hostOnlyIce = stunServer.iceServers;
}, 60_000);

afterEach(async () => {
  await Promise.all(openPeers.splice(0).map((peer) => peer.close()));
}, 60_000);

afterAll(async () => {
  await stunServer?.stop();
});

type Side = "offer" | "answer";

/** What a pair of peers did with one negotiation. */
interface Outcome {
  /** Data channels that reached `open` on either peer. */
  readonly channelsOpened: number;
  /** Payloads delivered to either peer's channel. */
  readonly messagesDelivered: Array<string>;
  /** Each peer's `connectionState` when the observation ended. */
  readonly finalStates: ReadonlyArray<string>;
}

const FINGERPRINT_LINE = /^(a=fingerprint:\S+ )([0-9A-F:]+)$/im;

/**
 * `sdp` with the first hex digit of its `a=fingerprint` value changed, so the
 * line stays well formed and names a different certificate.
 */
function withAlteredFingerprint(sdp: string): string {
  const altered = sdp.replace(
    FINGERPRINT_LINE,
    (_line, prefix: string, value: string) =>
      `${prefix}${value[0] === "0" ? "1" : "0"}${value.slice(1)}`,
  );
  expect(altered).not.toBe(sdp);
  return altered;
}

function sdpOf(peer: RTCPeerConnection): string {
  const sdp = peer.localDescription?.sdp;
  if (sdp === undefined || sdp === "")
    throw new Error("the peer connection produced no local description");
  return sdp;
}

/**
 * Negotiate one data channel between two peers, handing the `alteredSide`'s
 * description over with its fingerprint changed (or unchanged when
 * `undefined`), send a payload from each end as soon as its channel opens, and
 * report what happened.
 */
async function negotiate(alteredSide: Side | undefined): Promise<Outcome> {
  const offerer = new RTCPeerConnection({ iceServers: hostOnlyIce });
  const answerer = new RTCPeerConnection({ iceServers: hostOnlyIce });
  openPeers.push(offerer, answerer);

  let channelsOpened = 0;
  const messagesDelivered: Array<string> = [];
  const watch = (channel: ReturnType<typeof offerer.createDataChannel>) => {
    const onOpen = (): void => {
      channelsOpened += 1;
      channel.send(PAYLOAD);
    };
    if (channel.readyState === "open") onOpen();
    else channel.onopen = onOpen;
    channel.onmessage = ({ data }) => {
      messagesDelivered.push(String(data));
    };
  };

  watch(offerer.createDataChannel("fingerprint-probe"));
  answerer.ondatachannel = ({ channel }) => watch(channel);

  await offerer.setLocalDescription(await offerer.createOffer());
  const offer = sdpOf(offerer);
  await answerer.setRemoteDescription({
    type: "offer",
    sdp: alteredSide === "offer" ? withAlteredFingerprint(offer) : offer,
  });
  await answerer.setLocalDescription(await answerer.createAnswer());
  const answer = sdpOf(answerer);
  await offerer.setRemoteDescription({
    type: "answer",
    sdp: alteredSide === "answer" ? withAlteredFingerprint(answer) : answer,
  });

  const settled = (): boolean =>
    alteredSide === undefined
      ? messagesDelivered.length >= 2
      : messagesDelivered.length > 0 ||
        [offerer, answerer].some((peer) =>
          ["failed", "closed"].includes(peer.connectionState),
        );
  await vi
    .waitFor(() => expect(settled()).toBe(true), {
      timeout: FAILURE_WINDOW_MS,
      interval: 50,
    })
    .catch(() => {
      // The outcome below reports what the pair did instead.
    });
  await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_FAILURE_MS));

  return {
    channelsOpened,
    messagesDelivered,
    finalStates: [offerer.connectionState, answerer.connectionState],
  };
}

test("a pair whose descriptions name the certificates presented delivers a message each way", async () => {
  const outcome = await negotiate(undefined);

  expect(outcome.channelsOpened).toBe(2);
  expect(outcome.messagesDelivered).toEqual([PAYLOAD, PAYLOAD]);
  expect(outcome.finalStates).toEqual(["connected", "connected"]);
}, 60_000);

test.each(["offer", "answer"] as const)(
  "a peer handed a description whose %s fingerprint names a different certificate refuses the connection",
  async (alteredSide) => {
    const outcome = await negotiate(alteredSide);

    expect(outcome.channelsOpened).toBe(0);
    expect(outcome.messagesDelivered).toEqual([]);
    expect(outcome.finalStates).toContain("failed");
    expect(outcome.finalStates).not.toContain("connected");
  },
  60_000,
);
