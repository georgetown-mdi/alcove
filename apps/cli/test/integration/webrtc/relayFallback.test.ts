import { RTCPeerConnection } from "werift";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import logLibrary from "loglevel";

import {
  EncryptedMessageConnection,
  authenticateConnection,
  deriveRelayExchangeId,
  deriveRelayKey,
  generateSharedSecret,
  handshakeRoleForRendezvousRole,
  setDiagnosticSink,
  setLogLevel,
} from "@alcove/core";

import { openWebRtcWithRelayFallback } from "../../../src/connection/webrtc/relayFallback";
import { webSocketRelayDialsFor } from "../../../src/connection/webrtc/websocketRelayDial";
import { snapshotDiagnosticSinkAndLevel } from "../../loggingTestSupport";
import { startBrokerProcess } from "../../signaling/brokerProcess";
import { startWebSocketRelayProcess } from "../../signaling/websocketRelayProcess";
import { startRefusingStunServer } from "./refusingStunServer";

import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { WebSocketRelayProcess } from "../../signaling/websocketRelayProcess";
import type { RefusingStunServer } from "./refusingStunServer";
import type { MessageConnection, RendezvousRole } from "@alcove/core";
import type { RTCIceServer } from "werift";

/**
 * The CLI's fallback to the WebSocket relay end to end: two CLI parties
 * meeting through the repository's real broker, each also parked at the
 * repository's real relay, with the relay list injected as a run's would be.
 * ICE is host candidates only, as in transport.test.ts.
 */

let broker: BrokerProcess;
let relay: WebSocketRelayProcess;
let stunServer: RefusingStunServer;
let hostOnlyIce: Array<RTCIceServer>;
const openConnections: Array<MessageConnection> = [];

snapshotDiagnosticSinkAndLevel();

beforeAll(async () => {
  stunServer = await startRefusingStunServer();
  hostOnlyIce = stunServer.iceServers;
  broker = await startBrokerProcess();
  relay = await startWebSocketRelayProcess({});
}, 60_000);

afterEach(async () => {
  for (const connection of openConnections.splice(0))
    await connection.close().catch(() => {
      // Already terminal.
    });
}, 60_000);

afterAll(async () => {
  await relay?.stop();
  await broker?.stop();
  await stunServer?.stop();
});

/** A fresh secret, its relay key enrolled at the relay. */
async function enrolledSecret(): Promise<string> {
  const secret = generateSharedSecret();
  relay.enroll({
    [await deriveRelayExchangeId(secret)]: await deriveRelayKey(secret),
  });
  return secret;
}

function partyOptions(sharedSecret: string, role: RendezvousRole) {
  return {
    location: {
      host: "127.0.0.1",
      port: broker.port,
      path: broker.path,
      key: broker.key,
      secure: false,
    },
    role,
    sharedSecret,
    iceServers: hostOnlyIce,
    rendezvousTimeoutMs: 60_000,
    channelOpenTimeoutMs: 3_000,
    closeFlushTimeoutMs: 5_000,
  };
}

/** A peer connection that gathers relay candidates only, and lists no relay: it never connects. */
function blockedPeerConnection(
  configuration: ConstructorParameters<typeof RTCPeerConnection>[0],
): RTCPeerConnection {
  return new RTCPeerConnection({
    ...configuration,
    iceTransportPolicy: "relay",
  });
}

/** What the relay sockets a party dials send and how they close. */
interface RelaySockets {
  socketFactory: (url: string) => WebSocket;
  dialed: number;
  textSent: Array<string>;
  binarySent: number;
  closeCodes: Array<number>;
}

function recordingRelaySockets(): RelaySockets {
  const record: RelaySockets = {
    socketFactory: (url) => {
      record.dialed += 1;
      const socket = new WebSocket(url);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") record.textSent.push(data);
        else record.binarySent += 1;
        send(data);
      };
      socket.addEventListener("close", (event: CloseEvent) =>
        record.closeCodes.push(event.code),
      );
      return socket;
    },
    dialed: 0,
    textSent: [],
    binarySent: 0,
    closeCodes: [],
  };
  return record;
}

function captureLines(): Array<string> {
  const lines: Array<string> = [];
  setDiagnosticSink((_method, _prefix, args) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  setLogLevel(logLibrary.levels.INFO);
  return lines;
}

/** Run the key exchange over both connections with the wrap requested, then one frame each way. */
async function exchangeOverWrap(
  secret: string,
  inviterRaw: MessageConnection,
  acceptorRaw: MessageConnection,
): Promise<void> {
  const wrap = async (
    connection: MessageConnection,
    role: RendezvousRole,
  ): Promise<MessageConnection> => {
    const handshakeRole = handshakeRoleForRendezvousRole(role);
    const { sessionKey, applyEncryption } = await authenticateConnection(
      connection,
      { sharedSecret: secret },
      handshakeRole,
      true,
      { history: [] },
    );
    expect(applyEncryption).toBe(true);
    return EncryptedMessageConnection.create(
      connection,
      sessionKey,
      handshakeRole,
    );
  };
  const [inviter, acceptor] = await Promise.all([
    wrap(inviterRaw, "inviter"),
    wrap(acceptorRaw, "acceptor"),
  ]);
  await inviter.send({ from: "inviter" });
  expect(await acceptor.receive()).toEqual({ from: "inviter" });
  await acceptor.send({ from: "acceptor" });
  expect(await inviter.receive()).toEqual({ from: "acceptor" });
}

test("an exchange whose WebRTC path never opens completes over the relay", async () => {
  const lines = captureLines();
  const secret = await enrolledSecret();
  const open = async (role: RendezvousRole) =>
    openWebRtcWithRelayFallback(
      {
        ...partyOptions(secret, role),
        peerConnectionFactory: blockedPeerConnection,
      },
      await webSocketRelayDialsFor({ websocketRelay: relay.url }, secret, role),
    );
  const [inviter, acceptor] = await Promise.all([
    open("inviter"),
    open("acceptor"),
  ]);
  openConnections.push(inviter, acceptor);
  await exchangeOverWrap(secret, inviter, acceptor);
  expect(
    lines.filter((line) =>
      line.startsWith("the exchange runs over the WebSocket relay at"),
    ),
  ).toHaveLength(2);
}, 120_000);

test("an exchange whose WebRTC path opens closes both relay sockets unused", async () => {
  const lines = captureLines();
  const secret = await enrolledSecret();
  const sockets = {
    inviter: recordingRelaySockets(),
    acceptor: recordingRelaySockets(),
  };
  const open = async (role: RendezvousRole) =>
    openWebRtcWithRelayFallback(
      partyOptions(secret, role),
      await webSocketRelayDialsFor({ websocketRelay: relay.url }, secret, role),
      { socketFactory: sockets[role].socketFactory },
    );
  const [inviter, acceptor] = await Promise.all([
    open("inviter"),
    open("acceptor"),
  ]);
  openConnections.push(inviter, acceptor);
  await exchangeOverWrap(secret, inviter, acceptor);
  expect(
    lines.filter((line) =>
      line.startsWith("the exchange runs over the WebRTC connection"),
    ),
  ).toHaveLength(2);
  for (const record of Object.values(sockets)) {
    expect(record.dialed).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(record.closeCodes).toHaveLength(record.dialed),
    );
    expect(record.closeCodes.every((code) => code === 1000)).toBe(true);
    expect(record.binarySent).toBe(0);
    expect(record.textSent.some((text) => text.includes('"start"'))).toBe(
      false,
    );
  }
}, 120_000);

test("an empty relay list opens no relay socket", async () => {
  const secret = await enrolledSecret();
  const sockets = recordingRelaySockets();
  const open = (role: RendezvousRole) =>
    openWebRtcWithRelayFallback(partyOptions(secret, role), [], {
      socketFactory: sockets.socketFactory,
    });
  const [inviter, acceptor] = await Promise.all([
    open("inviter"),
    open("acceptor"),
  ]);
  openConnections.push(inviter, acceptor);
  await exchangeOverWrap(secret, inviter, acceptor);
  expect(sockets.dialed).toBe(0);
}, 120_000);
