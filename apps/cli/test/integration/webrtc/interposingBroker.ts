import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import { RTCPeerConnection } from "werift";
import { WebSocketServer } from "ws";

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { RTCDataChannel, RTCIceServer } from "werift";
import type { WebSocket } from "ws";

import type { BrokerLocation } from "../../../src/connection/webrtc/brokerClient";

/**
 * A coordination server that answers each party with a peer connection of its
 * own and copies data-channel datagrams between the two. It speaks the PeerJS
 * signaling wire the vendored broker does (test/signaling/brokerProcess.ts,
 * src/connection/webrtc/brokerClient.ts), so the parties reach it with the
 * unmodified CLI transport. Test-only.
 */

/** The signaling frame both directions put on the wire, as the server sees it. */
interface Frame {
  type: string;
  src?: string;
  dst?: string;
  payload?: {
    sdp?: { type?: string; sdp?: string };
    candidate?: Record<string, unknown>;
    connectionId?: string;
    [key: string]: unknown;
  };
}

/** Which party sent a datagram. */
export type DatagramSender = "inviter" | "acceptor";

/** One data-channel datagram the server copied between the parties. */
export interface RelayedDatagram {
  /** Which party sent it. */
  from: DatagramSender;
  /** The bytes exactly as the server forwarded them. */
  bytes: Buffer;
}

/**
 * Rewrites a datagram before it is forwarded, or returns it unchanged. Called
 * once per datagram, in arrival order per sender.
 */
export type DatagramRewrite = (from: DatagramSender, bytes: Buffer) => Buffer;

/** A running interposing coordination server. */
export interface InterposingBroker {
  /** Where the two parties dial it, as a CLI webrtc connection locator. */
  location: BrokerLocation;
  /** Every datagram the server forwarded between the two data channels. */
  relayed: () => ReadonlyArray<RelayedDatagram>;
  /** Stop the server and tear down both peer connections. */
  stop: () => Promise<void>;
}

function connectionId(): string {
  return randomBytes(8).toString("hex");
}

function toDatagramBuffer(data: unknown): Buffer | undefined {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

/**
 * Start the server on an ephemeral loopback port. `iceServers` is the same
 * host-candidates-only list the parties use, so the server's two peer
 * connections gather and connect the way a loopback exchange does.
 */
export async function startInterposingBroker(options: {
  iceServers: Array<RTCIceServer>;
  rewrite?: DatagramRewrite;
}): Promise<InterposingBroker> {
  const { iceServers, rewrite = (_from, bytes) => bytes } = options;
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  const sockets = new Map<string, WebSocket>();
  const queued = new Map<string, Array<Frame>>();
  const relayed: Array<RelayedDatagram> = [];

  let acceptorId: string | undefined;
  let inviterId: string | undefined;
  let peerFacingAcceptor: RTCPeerConnection | undefined;
  let peerFacingInviter: RTCPeerConnection | undefined;
  let acceptorChannel: RTCDataChannel | undefined;
  let inviterChannel: RTCDataChannel | undefined;
  const toInviterQueue: Array<Buffer> = [];
  const toAcceptorQueue: Array<Buffer> = [];
  let acceptorConnectionId: string | undefined;

  const send = (id: string, frame: Frame): void => {
    const socket = sockets.get(id);
    if (socket === undefined) {
      const pending = queued.get(id) ?? [];
      pending.push(frame);
      queued.set(id, pending);
      return;
    }
    socket.send(JSON.stringify(frame));
  };

  const flushQueues = (): void => {
    if (inviterChannel?.readyState === "open")
      for (const b of toInviterQueue.splice(0)) inviterChannel.send(b);
    if (acceptorChannel?.readyState === "open")
      for (const b of toAcceptorQueue.splice(0)) acceptorChannel.send(b);
  };

  const forward = (from: DatagramSender, data: unknown): void => {
    const received = toDatagramBuffer(data);
    if (received === undefined) return;
    const bytes = rewrite(from, received);
    relayed.push({ from, bytes });
    const [channel, queue] =
      from === "acceptor"
        ? [inviterChannel, toInviterQueue]
        : [acceptorChannel, toAcceptorQueue];
    if (channel?.readyState === "open") channel.send(bytes);
    else queue.push(bytes);
  };

  // Toward the acceptor the server stands in for the inviter: it answers the
  // acceptor's offer and takes the channel the acceptor created.
  const answerAcceptor = async (offerSdp: string): Promise<void> => {
    if (peerFacingAcceptor !== undefined) return;
    const pc = new RTCPeerConnection({ iceServers });
    peerFacingAcceptor = pc;
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || acceptorId === undefined) return;
      send(acceptorId, {
        type: "CANDIDATE",
        src: inviterId,
        dst: acceptorId,
        payload: {
          candidate: candidate.toJSON() as Record<string, unknown>,
          type: "data",
          connectionId: acceptorConnectionId,
        },
      });
    };
    pc.ondatachannel = ({ channel }) => {
      acceptorChannel = channel;
      channel.onmessage = ({ data }) => forward("acceptor", data);
      channel.onopen = flushQueues;
    };
    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    const local = pc.localDescription;
    if (acceptorId !== undefined && local)
      send(acceptorId, {
        type: "ANSWER",
        src: inviterId,
        dst: acceptorId,
        payload: {
          sdp: { type: local.type, sdp: local.sdp },
          type: "data",
          connectionId: acceptorConnectionId,
        },
      });
  };

  // Toward the inviter the server stands in for the acceptor: it opens a data
  // channel and offers it.
  const offerInviter = async (): Promise<void> => {
    if (peerFacingInviter !== undefined || inviterId === undefined) return;
    const pc = new RTCPeerConnection({ iceServers });
    peerFacingInviter = pc;
    const offerConnectionId = connectionId();
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || inviterId === undefined) return;
      send(inviterId, {
        type: "CANDIDATE",
        src: acceptorId,
        dst: inviterId,
        payload: {
          candidate: candidate.toJSON() as Record<string, unknown>,
          type: "data",
          connectionId: offerConnectionId,
        },
      });
    };
    const channel = pc.createDataChannel(offerConnectionId, { ordered: true });
    inviterChannel = channel;
    channel.onmessage = ({ data }) => forward("inviter", data);
    channel.onopen = flushQueues;
    await pc.setLocalDescription(await pc.createOffer());
    const local = pc.localDescription;
    if (local)
      send(inviterId, {
        type: "OFFER",
        src: acceptorId,
        dst: inviterId,
        payload: {
          sdp: { type: local.type, sdp: local.sdp },
          type: "data",
          connectionId: offerConnectionId,
          label: offerConnectionId,
          metadata: null,
          reliable: true,
          serialization: "binary",
        },
      });
  };

  const onFrame = async (fromId: string, frame: Frame): Promise<void> => {
    switch (frame.type) {
      case "OFFER": {
        // The party that offers is the acceptor; its dst is the inviter.
        acceptorId = fromId;
        inviterId = frame.dst;
        acceptorConnectionId = frame.payload?.connectionId;
        const sdp = frame.payload?.sdp?.sdp;
        if (sdp !== undefined) await answerAcceptor(sdp);
        await offerInviter();
        return;
      }
      case "ANSWER": {
        const sdp = frame.payload?.sdp?.sdp;
        if (sdp !== undefined && peerFacingInviter !== undefined)
          await peerFacingInviter.setRemoteDescription({ type: "answer", sdp });
        return;
      }
      case "CANDIDATE": {
        const candidate = frame.payload?.candidate;
        if (candidate === undefined) return;
        const pc =
          fromId === acceptorId ? peerFacingAcceptor : peerFacingInviter;
        if (pc !== undefined) {
          try {
            await pc.addIceCandidate(candidate);
          } catch {
            // One unusable candidate is not fatal; others complete the path.
          }
        }
        return;
      }
      default:
        return;
    }
  };

  wss.on("connection", (socket: WebSocket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.searchParams.get("id");
    if (id === null) {
      socket.close();
      return;
    }
    sockets.set(id, socket);
    socket.send(JSON.stringify({ type: "OPEN" }));
    for (const frame of queued.get(id)?.splice(0) ?? []) {
      socket.send(JSON.stringify(frame));
    }
    socket.on("message", (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(data.toString()) as Frame;
      } catch {
        return;
      }
      if (frame.type === "HEARTBEAT") return;
      void onFrame(id, frame);
    });
    socket.on("close", () => {
      if (sockets.get(id) === socket) sockets.delete(id);
    });
  });

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () =>
      resolve((httpServer.address() as AddressInfo).port),
    );
  });

  return {
    location: {
      host: "127.0.0.1",
      port,
      path: "/",
      key: "peerjs",
      secure: false,
    },
    relayed: () => relayed,
    stop: async () => {
      for (const socket of sockets.values()) socket.terminate();
      sockets.clear();
      await Promise.all([
        peerFacingAcceptor?.close(),
        peerFacingInviter?.close(),
      ]);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
