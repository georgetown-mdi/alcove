import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { RTCPeerConnection } from "werift";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  relayOnlyRelaysLeftOutMessage,
  UsageError,
} from "@alcove/core";
import { StandardizedDataset } from "@alcove/core/testing";

import { loadConfigWebRTCConnection } from "../../../src/config/loaders";
import { persistInvitationRelay } from "../../../src/config/persist";
import { WERIFT_BUILT_IN_STUN_URI } from "../../../src/connection/webrtc/weriftPeer";
import { saveKeyFile } from "../../../src/keyFile";
import { runProtocol } from "../../../src/protocol";

import type { PreparedExchange, WebRTCConnectionConfig } from "@alcove/core";
import type { RTCIceCandidate } from "werift";

/**
 * The two runs `connection.allowed_relays` can leave with no TURN url that a
 * CLI run refuses (`webRtcDialFrom`), and the werift behavior behind each.
 * A relay-only policy is applied only where a TURN server reaches werift
 * (webrtcIceTransportPolicy.test.ts), and a peer given no STUN url it can
 * parse gathers against werift's built-in default, which the first test
 * measures for every server list such a run could pass.
 */

const BUILT_IN_STUN_HOST = (() => {
  const match = /^stun:([^:]+):\d+$/.exec(WERIFT_BUILT_IN_STUN_URI);
  if (match?.[1] === undefined)
    throw new Error(`not a stun:host:port uri: ${WERIFT_BUILT_IN_STUN_URI}`);
  return match[1];
})();

const GATHERING_TIMEOUT_MS = 30_000;

/**
 * Run `body` with every DNS lookup failed at once and recorded, so nothing
 * here reaches werift's built-in STUN server on the network.
 */
async function withLookupsRecorded<T>(
  body: () => Promise<T>,
): Promise<{ result: T; lookedUp: Set<string> }> {
  const lookedUp = new Set<string>();
  const blocked = new Error("resolver intercepted by the allowed_relays suite");
  const realPromiseLookup = dns.promises.lookup;
  const realCallbackLookup = dns.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (
    hostname: string,
  ): Promise<never> => {
    lookedUp.add(hostname);
    throw blocked;
  };
  (dns as { lookup: unknown }).lookup = (
    hostname: string,
    options: unknown,
    callback: unknown,
  ): void => {
    lookedUp.add(hostname);
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error,
    ) => void;
    cb(blocked);
  };
  try {
    return { result: await body(), lookedUp };
  } finally {
    (dns.promises as { lookup: unknown }).lookup = realPromiseLookup;
    (dns as { lookup: unknown }).lookup = realCallbackLookup;
  }
}

async function gatheredCandidates(
  configuration: ConstructorParameters<typeof RTCPeerConnection>[0],
): Promise<Array<string>> {
  const peer = new RTCPeerConnection(configuration);
  const candidates: Array<string> = [];
  peer.onicecandidate = ({ candidate }: { candidate?: RTCIceCandidate }) => {
    if (candidate !== undefined) candidates.push(candidate.candidate);
  };
  try {
    const gatheringComplete = peer.iceGatheringStateChange.watch(
      (state) => state === "complete",
      GATHERING_TIMEOUT_MS,
    );
    peer.createDataChannel("allowed-relays-probe");
    await peer.setLocalDescription(await peer.createOffer());
    await gatheringComplete;
    return candidates;
  } finally {
    await peer.close();
  }
}

test.each([
  ["no server list", {}],
  ["an empty server list", { iceServers: [] }],
  ["a server naming no url", { iceServers: [{ urls: [] }] }],
])(
  "a peer given %s gathers host candidates and looks up werift's built-in STUN server",
  { timeout: GATHERING_TIMEOUT_MS + 10_000 },
  async (_shape, configuration) => {
    const { result, lookedUp } = await withLookupsRecorded(() =>
      gatheredCandidates(configuration),
    );
    expect(result.some((candidate) => candidate.includes("typ host"))).toBe(
      true,
    );
    expect([...lookedUp]).toContain(BUILT_IN_STUN_HOST);
  },
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-allowed-relays-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const minimalPrepared = {
  metadata: [],
  linkageTerms: getDefaultLinkageTerms("Acceptor"),
  dataset: new StandardizedDataset([], []),
  rawRows: [],
  rowCount: 0,
} satisfies PreparedExchange;

const OLD_RELAY = "turn:old-partner-relay.example.net";
const NEW_RELAY = "turn:new-partner-relay.example.net";

test("a relay-only configuration whose allowed_relays leaves out a newly accepted relay is refused before it gathers", async () => {
  // A loopback listener stands in for the coordination server: an offer and
  // its candidates reach the partner only through it.
  const brokerConnections: Array<net.Socket> = [];
  const broker = net.createServer((socket) => {
    brokerConnections.push(socket);
    socket.destroy();
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const brokerPort = (broker.address() as net.AddressInfo).port;
  try {
    const configPath = path.join(tmpDir, "alcove.yaml");
    fs.writeFileSync(
      configPath,
      [
        "connection:",
        "  channel: webrtc",
        "  server:",
        "    host: 127.0.0.1",
        `    port: ${brokerPort}`,
        "  role: acceptor",
        "  ice_transport_policy: relay",
        "  allowed_relays:",
        "    - old-partner-relay.example.net",
        "  invitation_relay:",
        "    turn:",
        `      - "${OLD_RELAY}"`,
        "",
      ].join("\n"),
    );
    const kept = loadConfigWebRTCConnection(configPath);
    expect(kept?.invitationRelay?.turn).toEqual([OLD_RELAY]);

    // The acceptance of a new invitation writes its relay over the old one.
    expect(persistInvitationRelay(configPath, { turn: [NEW_RELAY] })).toBe(
      "set",
    );
    expect(() => loadConfigWebRTCConnection(configPath)).toThrow(
      relayOnlyRelaysLeftOutMessage([NEW_RELAY]),
    );

    // The run checks the list it is about to use as well.
    const connection: WebRTCConnectionConfig = {
      ...(kept as WebRTCConnectionConfig),
      invitationRelay: { turn: [NEW_RELAY] },
    };
    const sharedSecret = generateSharedSecret();
    const keyFilePath = path.join(tmpDir, "alcove.key");
    saveKeyFile(keyFilePath, { sharedSecret });
    const { result: error, lookedUp } = await withLookupsRecorded(() =>
      runProtocol({
        connection,
        auth: { sharedSecret, keyFilePath },
        prepared: minimalPrepared,
        output: path.join(tmpDir, "result.csv"),
        verbosity: -1,
        loggerName: "test",
      }).then(
        () => undefined,
        (err: unknown) => err,
      ),
    );
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toBe(
      relayOnlyRelaysLeftOutMessage([NEW_RELAY]),
    );
    expect([...lookedUp]).toEqual([]);
    expect(brokerConnections).toHaveLength(0);
  } finally {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});
