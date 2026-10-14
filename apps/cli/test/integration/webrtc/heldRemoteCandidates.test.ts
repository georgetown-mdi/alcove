import { randomUUID } from "node:crypto";

import { RTCPeerConnection } from "werift";
import { afterAll, beforeAll, expect, test } from "vitest";

import { generateSharedSecret } from "@alcove/core";

import { BROKER_MESSAGE } from "../../../src/connection/webrtc/brokerClient";
import { readIceStats } from "../../../src/connection/webrtc/iceDiagnostics";
import { openWebRtcPeerSession } from "../../../src/connection/webrtc/weriftPeer";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import { startBrokerProcess } from "../../signaling/brokerProcess";
import { startRefusingStunServer } from "./refusingStunServer";

import type { RTCIceServer } from "werift";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { RefusingStunServer } from "./refusingStunServer";

/**
 * A browser sends `<uuid>.local` host candidates by default, and werift spends
 * 10 s on the mDNS lookup of one no host answers before it drops it. Two real
 * werift peers meet through the real broker, the partner made browser-shaped
 * by rewriting what the party under test exchanges with it:
 * - the partner's description reaches it with no candidates, followed in the
 *   same tick by two unresolvable `.local` host candidates and then the
 *   partner's real host address labelled `srflx`, so all three are held until
 *   the description is applied;
 * - none of its own candidates reach the partner, so the only working path is
 *   the one to that `srflx` candidate.
 */

/**
 * The bound on the channel opening after the partner's description: well
 * under the 20 s two candidates would cost if each held the next, and above
 * the half second the path takes on loopback.
 */
const OPEN_BOUND_MS = 5_000;

let broker: BrokerProcess;
let stunServer: RefusingStunServer;
let hostOnlyIce: Array<RTCIceServer>;

snapshotDiagnosticSinkAndLevel();

beforeAll(async () => {
  stunServer = await startRefusingStunServer();
  hostOnlyIce = stunServer.iceServers;
  broker = await startBrokerProcess();
}, 60_000);

afterAll(async () => {
  await broker?.stop();
  await stunServer?.stop();
});

interface Frame {
  type: string;
  src?: string;
  dst?: string;
  payload?: {
    sdp?: { type: string; sdp: string };
    connectionId?: string;
    [field: string]: unknown;
  };
}

type Listener = (event: { data: string }) => void;

function withoutCandidates(sdp: string): string {
  return sdp
    .split("\r\n")
    .filter(
      (line) =>
        !line.startsWith("a=candidate:") && line !== "a=end-of-candidates",
    )
    .join("\r\n");
}

/** A broker socket whose inbound and outbound frames pass through a rewrite. */
class RewritingSocket {
  private readonly socket: WebSocket;
  private readonly messageListeners = new Set<Listener>();

  constructor(
    url: string,
    inbound: (frame: Frame, deliver: (frame: Frame) => void) => void,
    private readonly outbound: (frame: Frame) => Frame | undefined,
  ) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      inbound(JSON.parse(String(event.data)) as Frame, (frame) => {
        const data = JSON.stringify(frame);
        for (const listener of [...this.messageListeners]) listener({ data });
      });
    });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "message") this.messageListeners.add(listener);
    else this.socket.addEventListener(type, listener as () => void);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "message") this.messageListeners.delete(listener);
    else this.socket.removeEventListener(type, listener as () => void);
  }

  send(data: string): void {
    const frame = this.outbound(JSON.parse(data) as Frame);
    if (frame !== undefined) this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.socket.close();
  }
}

/** When the party under test met the partner's description, and answered it. */
interface Timeline {
  descriptionAt?: number;
  answerSentAt?: number;
}

/**
 * The socket the party under test dials with: `descriptionType` is the frame
 * holding the partner's description, `OFFER` for an inviter and `ANSWER` for
 * an acceptor.
 */
function browserShapedPartner(
  descriptionType: string,
  timeline: Timeline,
): (url: string) => WebSocket {
  const inbound = (frame: Frame, deliver: (frame: Frame) => void): void => {
    if (frame.type === BROKER_MESSAGE.candidate) return;
    const description = frame.payload?.sdp;
    if (frame.type !== descriptionType || description === undefined) {
      deliver(frame);
      return;
    }
    const { sdp } = description;
    deliver({
      ...frame,
      payload: {
        ...frame.payload,
        sdp: { ...description, sdp: withoutCandidates(sdp) },
      },
    });
    if (timeline.descriptionAt !== undefined) return;
    timeline.descriptionAt = performance.now();
    const sdpMid = /^a=mid:(\S+)$/m.exec(sdp)?.[1];
    const hosts = sdp
      .split("\r\n")
      .filter((line) => line.startsWith("a=candidate:"))
      .map((line) => line.slice("a=".length).split(" "))
      .filter(
        (fields) =>
          fields[2].toLowerCase() === "udp" &&
          fields[7] === "host" &&
          /^\d+\.\d+\.\d+\.\d+$/.test(fields[4]),
      );
    const candidateFrame = (candidate: string): Frame => ({
      type: BROKER_MESSAGE.candidate,
      src: frame.src,
      dst: frame.dst,
      payload: {
        candidate: { candidate, sdpMid, sdpMLineIndex: 0 },
        type: "data",
        connectionId: frame.payload?.connectionId,
      },
    });
    for (const port of [50_000, 50_001]) {
      deliver(
        candidateFrame(
          `candidate:${port} 1 udp 2122260223 ${randomUUID()}.local ${port} typ host`,
        ),
      );
    }
    for (const [index, fields] of hosts.entries()) {
      deliver(
        candidateFrame(
          `candidate:${index + 1} 1 udp 1686052607 ${fields[4]} ${fields[5]} ` +
            "typ srflx raddr 0.0.0.0 rport 0",
        ),
      );
    }
  };
  const outbound = (frame: Frame): Frame | undefined => {
    if (frame.type === BROKER_MESSAGE.candidate) return undefined;
    const sdp = frame.payload?.sdp;
    if (sdp === undefined) return frame;
    if (frame.type === BROKER_MESSAGE.answer)
      timeline.answerSentAt ??= performance.now();
    return {
      ...frame,
      payload: {
        ...frame.payload,
        sdp: { ...sdp, sdp: withoutCandidates(sdp.sdp) },
      },
    };
  };
  return (url) =>
    new RewritingSocket(url, inbound, outbound) as unknown as WebSocket;
}

test.each(["acceptor", "inviter"] as const)(
  "an %s opens the channel without waiting out the partner's unresolvable .local candidates",
  async (role) => {
    const sharedSecret = generateSharedSecret();
    const timeline: Timeline = {};
    const peers: Array<RTCPeerConnection> = [];
    const common = {
      location: {
        host: "127.0.0.1",
        port: broker.port,
        path: broker.path,
        key: broker.key,
        secure: false,
      },
      sharedSecret,
      iceServers: hostOnlyIce,
      rendezvousTimeoutMs: 60_000,
      channelOpenTimeoutMs: 30_000,
    };
    const partner = openWebRtcPeerSession({
      ...common,
      role: role === "inviter" ? "acceptor" : "inviter",
    });
    const underTest = openWebRtcPeerSession({
      ...common,
      role,
      socketFactory: browserShapedPartner(
        role === "inviter" ? BROKER_MESSAGE.offer : BROKER_MESSAGE.answer,
        timeline,
      ),
      peerConnectionFactory: (configuration) => {
        const peer = new RTCPeerConnection(configuration);
        peers.push(peer);
        return peer;
      },
    });
    const [session, partnerSession] = await Promise.all([underTest, partner]);
    const openedAt = performance.now();
    try {
      if (timeline.descriptionAt === undefined)
        throw new Error("the partner's description never reached the party");
      expect(openedAt - timeline.descriptionAt).toBeLessThan(OPEN_BOUND_MS);
      if (role === "inviter") {
        expect(timeline.answerSentAt).toBeDefined();
        expect(
          (timeline.answerSentAt ?? Infinity) - timeline.descriptionAt,
        ).toBeLessThan(OPEN_BOUND_MS);
      }
      const report = await readIceStats(peers[0]);
      expect(report?.selected?.remoteType).toBe("srflx");
    } finally {
      await session.close();
      await partnerSession.close();
    }
  },
  60_000,
);
