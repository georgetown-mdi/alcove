import dns from "node:dns";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";

import { RTCPeerConnection } from "werift";
import { beforeAll, expect, test } from "vitest";

import { safeParseConnectionConfig } from "@alcove/core";

import type { Socket as UdpSocket } from "node:dgram";
import type { Server, Socket as TcpSocket } from "node:net";

/**
 * Which forms of a TURN url's `transport` parameter werift keeps, driven
 * rather than read: werift reads the parameter itself and refuses the whole
 * entry over a value it does not support, continuing without it, so the run
 * loses that relay with nothing said. The connection schema's grammar is drawn
 * from this table (`packages/core/src/config/connection.ts`).
 *
 * Each form is measured against a loopback relay that listens on UDP and TCP
 * at one port and answers nothing: a kept entry contacts it over the transport
 * the form names, and a refused one leaves the peer with no relay to contact.
 * A refused form falls back to werift's built-in Google STUN default, so the
 * table runs with the resolver intercepted, as the sibling transport suite
 * does for the same case (transport.test.ts), and no packet leaves the machine.
 */

/** The credential every form presents to a loopback relay that answers nothing. */
const UNREACHABLE_TURN = {
  username: "alcove",
  credential: "placeholder-not-a-secret",
};

/**
 * How long the whole TRANSPORT_FORMS table may take. Its forms gather at
 * once rather than one after another, so this is a run of werift's own
 * timer for an ICE server that never answers, six or seven seconds, with room
 * for the slowest machine that runs it.
 */
const TRANSPORT_TABLE_TIMEOUT_MS = 90_000;

/**
 * Run `gather` with DNS resolution short-circuited, so a peer left with no
 * server it can parse cannot reach werift's built-in Google STUN default: the
 * lookup that fallback needs fails at once and no packet leaves the machine.
 * werift resolves through `dns.promises.lookup`; the callback form is hooked
 * too so a future switch does not silently reach the network.
 */
async function withResolverIntercepted<T>(
  gather: () => Promise<T>,
): Promise<T> {
  const intercepted = new Error(
    "resolver intercepted by the TURN url transport suite",
  );
  const realPromiseLookup = dns.promises.lookup;
  const realCallbackLookup = dns.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (): Promise<never> => {
    throw intercepted;
  };
  (dns as { lookup: unknown }).lookup = (
    _hostname: string,
    options: unknown,
    callback: unknown,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error,
    ) => void;
    cb(intercepted);
  };
  try {
    return await gather();
  } finally {
    (dns.promises as { lookup: unknown }).lookup = realPromiseLookup;
    (dns as { lookup: unknown }).lookup = realCallbackLookup;
  }
}

/** A loopback relay on one port, UDP and TCP, that records being contacted and answers nothing. */
interface SilentRelay {
  readonly port: number;
  contacted(): boolean;
  stop(): Promise<void>;
}

async function listenTcp(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

async function bindUdp(socket: UdpSocket, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

async function startSilentRelay(): Promise<SilentRelay> {
  for (let attempt = 0; ; attempt += 1) {
    let contacted = false;
    const connections = new Set<TcpSocket>();
    const tcp = createServer((connection) => {
      contacted = true;
      connections.add(connection);
      connection.on("error", () => {
        // The peer's close resets a connection this relay never answered.
      });
    });
    const udp = createSocket("udp4");
    udp.on("message", () => {
      contacted = true;
    });
    const port = await listenTcp(tcp, 0);
    try {
      await bindUdp(udp, port);
    } catch (error) {
      tcp.close();
      udp.close();
      if (attempt >= 10) throw error;
      continue;
    }
    return {
      port,
      contacted: () => contacted,
      stop: async () => {
        for (const connection of connections) connection.destroy();
        await Promise.all([
          new Promise<void>((resolve) => tcp.close(() => resolve())),
          new Promise<void>((resolve) => udp.close(() => resolve())),
        ]);
      },
    };
  }
}

/** Whether a relay-only probe against `url`, its port moved to `relay`'s, contacts that relay. */
async function contactsRelay(
  url: string,
  relay: SilentRelay,
): Promise<boolean> {
  const peer = new RTCPeerConnection({
    iceServers: [
      {
        ...UNREACHABLE_TURN,
        urls: url.replace(/:(3478|5349)(?=\?|$)/, `:${relay.port}`),
      },
    ],
    iceTransportPolicy: "relay",
  });
  try {
    peer.createDataChannel("transport-probe");
    await peer.setLocalDescription(await peer.createOffer());
    while (peer.iceGatheringState !== "complete") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return relay.contacted();
  } finally {
    await peer.close();
  }
}

/** A TURN url's `transport` parameter, and whether werift keeps the entry. */
const TRANSPORT_FORMS: Array<{ url: string; kept: boolean }> = [
  { url: "turn:127.0.0.1:3478", kept: true },
  { url: "turn:127.0.0.1:3478?transport=tcp", kept: true },
  { url: "turn:127.0.0.1:3478?transport=udp", kept: true },
  { url: "turn:127.0.0.1:3478?transport=tcp&foo=bar", kept: true },
  { url: "turn:127.0.0.1:3478?foo=bar", kept: true },
  { url: "turn:127.0.0.1:3478?Transport=tcp", kept: true },
  { url: "turn:127.0.0.1:3478?transport=tcp&transport=udp", kept: true },
  { url: "turns:127.0.0.1:5349", kept: true },
  { url: "turns:127.0.0.1:5349?transport=tcp", kept: true },
  { url: "turns:127.0.0.1:5349?transport=tcp&transport=udp", kept: true },
  { url: "turn:127.0.0.1:3478?transport=UDP", kept: false },
  { url: "turn:127.0.0.1:3478?transport=TCP", kept: false },
  { url: "turn:127.0.0.1:3478?transport=quic", kept: false },
  { url: "turn:127.0.0.1:3478?transport=", kept: false },
  { url: "turn:127.0.0.1:3478?transport=tcp;x", kept: false },
  { url: "turn:127.0.0.1:3478?transport=quic&transport=tcp", kept: false },
  { url: "turns:127.0.0.1:5349?transport=udp", kept: false },
  { url: "turns:127.0.0.1:5349?transport=quic", kept: false },
  { url: "turns:127.0.0.1:5349?transport=TCP", kept: false },
];

/** Whether each form of TRANSPORT_FORMS contacted its relay, keyed by its url. */
const contactedPerForm = new Map<string, boolean>();

/**
 * Every form of TRANSPORT_FORMS gathers in one window, before the arms below
 * read the results: gathering is what takes the time, the forms are
 * independent, and one window keeps the resolver intercepted until the last
 * peer has closed. The relays bind before it, since binding resolves their
 * address through the resolver.
 */
beforeAll(async () => {
  const relays = await Promise.all(TRANSPORT_FORMS.map(startSilentRelay));
  try {
    const contacted = await withResolverIntercepted(() =>
      Promise.all(
        TRANSPORT_FORMS.map(({ url }, index) =>
          contactsRelay(url, relays[index]!),
        ),
      ),
    );
    TRANSPORT_FORMS.forEach(({ url }, index) => {
      contactedPerForm.set(url, contacted[index] ?? false);
    });
  } finally {
    await Promise.all(relays.map((relay) => relay.stop()));
  }
}, TRANSPORT_TABLE_TIMEOUT_MS);

test.each(TRANSPORT_FORMS)(
  'werift keeps the entry "$url": $kept',
  ({ url, kept }) => {
    expect(
      contactedPerForm.get(url),
      `nothing was recorded for ${url}`,
    ).toBeDefined();
    expect(contactedPerForm.get(url)).toBe(kept);
  },
);

/**
 * The forms the schema refuses although werift keeps them. The schema holds
 * every occurrence of `transport` to the rule instead of resting on werift
 * reading the first, so a url setting it twice is refused where the two values
 * disagree, and it refuses every query parameter but `transport`, the name
 * read case-sensitively. Listing them here keeps the correspondence below
 * exact in both directions: any other divergence fails an arm.
 */
const REFUSED_THOUGH_KEPT = new Set([
  "turns:127.0.0.1:5349?transport=tcp&transport=udp",
  "turn:127.0.0.1:3478?transport=tcp&foo=bar",
  "turn:127.0.0.1:3478?foo=bar",
  "turn:127.0.0.1:3478?Transport=tcp",
]);

test.each(TRANSPORT_FORMS)(
  'the connection schema accepts "$url" only where werift keeps it',
  ({ url, kept }) => {
    const parsed = safeParseConnectionConfig({
      channel: "webrtc",
      server: { host: "peers.example.org" },
      turn: [{ url, ...UNREACHABLE_TURN }],
    });
    expect(parsed.success).toBe(kept && !REFUSED_THOUGH_KEPT.has(url));
  },
);
