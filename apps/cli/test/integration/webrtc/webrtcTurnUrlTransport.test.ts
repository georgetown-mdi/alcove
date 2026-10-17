import dns from "node:dns";

import { RTCPeerConnection } from "werift";
import { beforeAll, expect, test } from "vitest";

import { safeParseConnectionConfig } from "@alcove/core";

import type { RTCIceCandidate } from "werift";

/**
 * Which forms of a TURN url's `transport` parameter werift keeps, driven
 * rather than read: werift reads the parameter itself and refuses the whole
 * entry over a value it does not support, continuing without it, so the run
 * loses that relay with nothing said. The connection schema's grammar is drawn
 * from this table (`packages/core/src/config/connection.ts`).
 *
 * Each form is measured by gathering relay candidates only against an
 * unreachable loopback relay: a kept entry leaves the connection with a relay
 * that answers nothing, so it gathers nothing, while a refused one leaves it
 * with no server werift can parse, so it gathers a host candidate. The policy
 * is the probe's alone; a run gathers every candidate type. No form reaches
 * the network: a refused form falls back to werift's built-in Google STUN
 * default, so the table runs with the resolver intercepted, as the sibling
 * transport suite does for the same case (transport.test.ts).
 */

/** The credential every form presents to a loopback relay nothing serves. */
const UNREACHABLE_TURN = {
  username: "alcove",
  credential: "placeholder-not-a-secret",
};

/**
 * How long the whole TRANSPORT_FORMS table may take. Its forms gather at
 * once rather than one after another, so this is a run of werift's own
 * timer for an unreachable ICE server, six or seven seconds, with room for
 * the slowest machine that runs it.
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

/** Candidates one relay-only probe gathered against `url`. */
async function gatheredCandidates(url: string): Promise<Array<string>> {
  const peer = new RTCPeerConnection({
    iceServers: [{ ...UNREACHABLE_TURN, urls: url }],
    iceTransportPolicy: "relay",
  });
  const candidates: Array<string> = [];
  peer.onicecandidate = ({ candidate }: { candidate?: RTCIceCandidate }) => {
    if (candidate !== undefined) candidates.push(candidate.candidate);
  };
  try {
    peer.createDataChannel("transport-probe");
    await peer.setLocalDescription(await peer.createOffer());
    while (peer.iceGatheringState !== "complete") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return candidates;
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

/** What each form of TRANSPORT_FORMS gathered, keyed by its url. */
const gatheredPerForm = new Map<string, Array<string>>();

/**
 * Every form of TRANSPORT_FORMS gathers in one window, before the arms below
 * read the results: gathering is what takes the time, the forms are
 * independent, and one window keeps the resolver intercepted until the last
 * peer has closed.
 */
beforeAll(async () => {
  const gathered = await withResolverIntercepted(() =>
    Promise.all(TRANSPORT_FORMS.map(({ url }) => gatheredCandidates(url))),
  );
  TRANSPORT_FORMS.forEach(({ url }, index) => {
    gatheredPerForm.set(url, gathered[index] ?? []);
  });
}, TRANSPORT_TABLE_TIMEOUT_MS);

test.each(TRANSPORT_FORMS)(
  'werift keeps the entry "$url": $kept',
  ({ url, kept }) => {
    const candidates = gatheredPerForm.get(url);
    expect(candidates, `nothing was gathered for ${url}`).toBeDefined();
    expect(
      (candidates ?? []).some((candidate) => candidate.includes("typ host")),
    ).toBe(!kept);
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
