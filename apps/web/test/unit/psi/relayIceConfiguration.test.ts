import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  deriveRelayKey,
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
  mintRelayCredential,
  mintRunRelayCredential,
} from "@alcove/core";

import {
  RELAY_CREDENTIAL_TTL_SECONDS,
  buildIceServers,
  dialAsAcceptor,
  listenAsInviter,
} from "../../../src/psi/transport/rendezvous.js";
import { DEFAULT_PEER_WAIT_TIMEOUT_MS } from "../../../src/psi/transport/waitForConnection.js";
import { prepareAcceptedInvitation } from "../../../src/psi/acceptInvitation.js";
import { relayForRun } from "../../../src/psi/transport/ownRelaySetting.js";
import { relayWithDefaultForRun } from "../../../src/psi/transport/defaultRelay.js";

import type { WebRTCEndpoint, enrollRelayKeyWithinWait } from "@alcove/core";

import type { OwnRelayRead } from "../../../src/psi/transport/ownRelaySetting.js";
import type Peer from "peerjs";
import type { PeerOptions } from "peerjs";
import type { RelayLocator } from "../../../src/psi/transport/rendezvous.js";

// The ICE configuration the browser's peer connection is built with: the
// default STUN server always, and with a relay its urls beside it, the TURN
// entry holding a credential minted for this run from the exchange's shared
// secret.

const DEFAULT_STUN_ENTRY = { urls: ["stun:stun.l.google.com:19302"] };

/** The configuration of a run that lists no relay. */
const NO_RELAY_CONFIG = {
  iceServers: [DEFAULT_STUN_ENTRY],
  sdpSemantics: "unified-plan",
  iceTransportPolicy: "all",
};

const RELAY: RelayLocator = {
  turn: ["turns:relay.example.org:443?transport=tcp"],
  stun: [],
};

const NOW = new Date("2026-09-22T12:00:00Z");

class FakePeer extends EventEmitter {
  destroy = vi.fn();
  connect = vi.fn();
}

/** Construct a peer through the rendezvous and return the options it was
 * built with; the peer never opens, so the call is left pending. */
async function peerOptionsOf(
  start: (factory: (id: string, options: PeerOptions) => Peer) => unknown,
): Promise<PeerOptions> {
  let captured: PeerOptions | undefined;
  const fake = new FakePeer();
  void start((_id, options) => {
    captured = options;
    return fake as unknown as Peer;
  });
  await vi.waitFor(() => expect(captured).toBeDefined());
  return captured as PeerOptions;
}

const endpoint: WebRTCEndpoint = {
  channel: "webrtc",
  host: "127.0.0.1",
  port: 3000,
  path: "/api/",
};

function stubWindow(): void {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", port: "3000", protocol: "http:" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buildIceServers", () => {
  test("with no relay is the default STUN server alone", async () => {
    expect(
      await buildIceServers(undefined, generateSharedSecret(), NOW),
    ).toEqual(NO_RELAY_CONFIG.iceServers);
  });

  test("with a relay naming no url is the default STUN server alone", async () => {
    expect(
      await buildIceServers(
        { turn: [], stun: [] },
        generateSharedSecret(),
        NOW,
      ),
    ).toEqual(NO_RELAY_CONFIG.iceServers);
  });

  test("with TURN urls alone keeps the default STUN server beside the TURN entry", async () => {
    const secret = generateSharedSecret();
    const expected = await mintRelayCredential({
      key: await deriveRelayKey(secret),
      label: "alcove",
      ttlSeconds: RELAY_CREDENTIAL_TTL_SECONDS,
      now: NOW,
    });

    expect(await buildIceServers(RELAY, secret, NOW)).toEqual([
      DEFAULT_STUN_ENTRY,
      {
        urls: RELAY.turn,
        username: expected.username,
        credential: expected.credential,
      },
    ]);
  });

  test("with TURN and STUN urls lists the relay's STUN urls after the default server", async () => {
    const relay: RelayLocator = {
      turn: RELAY.turn,
      stun: ["stun:stun.example.org:3478"],
    };
    const iceServers = await buildIceServers(
      relay,
      generateSharedSecret(),
      NOW,
    );
    expect(iceServers).toHaveLength(2);
    expect(iceServers[0]).toEqual({
      urls: [...DEFAULT_STUN_ENTRY.urls, "stun:stun.example.org:3478"],
    });
    expect(iceServers[1].urls).toEqual(RELAY.turn);
  });

  test("the relay's STUN urls join the default server, which is listed once", async () => {
    const relay: RelayLocator = {
      turn: [],
      stun: ["stun:stun.example.org:3478", ...DEFAULT_STUN_ENTRY.urls],
    };
    expect(await buildIceServers(relay, generateSharedSecret(), NOW)).toEqual([
      { urls: [...DEFAULT_STUN_ENTRY.urls, "stun:stun.example.org:3478"] },
    ]);
  });

  test("the credential expires one lifetime after the run starts", async () => {
    const [, turn] = await buildIceServers(RELAY, generateSharedSecret(), NOW);
    const expiry = Number(turn.username?.split(":")[0]);
    expect(expiry).toBe(NOW.getTime() / 1000 + RELAY_CREDENTIAL_TTL_SECONDS);
  });

  test("each run mints its own credential rather than reusing one", async () => {
    const secret = generateSharedSecret();
    const first = await buildIceServers(RELAY, secret, NOW);
    const later = await buildIceServers(
      RELAY,
      secret,
      new Date(NOW.getTime() + 60_000),
    );
    const otherExchange = await buildIceServers(
      RELAY,
      generateSharedSecret(),
      NOW,
    );
    expect(later[1].username).not.toBe(first[1].username);
    expect(otherExchange[1].credential).not.toBe(first[1].credential);
  });
});

test("the credential lifetime covers the peer wait and stays within an hour", () => {
  expect(RELAY_CREDENTIAL_TTL_SECONDS).toBeGreaterThan(
    DEFAULT_PEER_WAIT_TIMEOUT_MS / 1000,
  );
  expect(RELAY_CREDENTIAL_TTL_SECONDS).toBeLessThanOrEqual(
    RELAY_CREDENTIAL_MAX_TTL_SECONDS,
  );
  expect(RELAY_CREDENTIAL_MAX_TTL_SECONDS).toBe(3600);
});

describe.each([
  {
    seat: "inviter",
    start: (
      secret: string,
      relay: RelayLocator | undefined,
      factory: (id: string, options: PeerOptions) => Peer,
    ) => listenAsInviter(secret, { relay, peerFactory: factory }),
  },
  {
    seat: "acceptor",
    start: (
      secret: string,
      relay: RelayLocator | undefined,
      factory: (id: string, options: PeerOptions) => Peer,
    ) => dialAsAcceptor(secret, endpoint, { relay, peerFactory: factory }),
  },
])("the $seat's peer", ({ start }) => {
  test("with no relay is built with the unchanged configuration", async () => {
    stubWindow();
    const options = await peerOptionsOf((factory) =>
      start(generateSharedSecret(), undefined, factory),
    );
    expect(options.config).toStrictEqual(NO_RELAY_CONFIG);
  });

  test("with a TURN-only relay holds the default STUN server and the TURN entry minted for this run", async () => {
    stubWindow();
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const secret = generateSharedSecret();
    const expected = await mintRelayCredential({
      key: await deriveRelayKey(secret),
      label: "alcove",
      ttlSeconds: RELAY_CREDENTIAL_TTL_SECONDS,
      now: NOW,
    });
    const options = await peerOptionsOf((factory) =>
      start(secret, RELAY, factory),
    );
    expect(options.config).toStrictEqual({
      ...NO_RELAY_CONFIG,
      iceServers: [
        DEFAULT_STUN_ENTRY,
        {
          urls: RELAY.turn,
          username: expected.username,
          credential: expected.credential,
        },
      ],
    });
  });
});

// The acceptor seat dials the invitation's endpoint with the relays
// `relayForRun(endpoint.relay)` lists (useAcceptorExchange, managed re-run).
describe("the acceptor seat's dial of an invitation endpoint", () => {
  const OWN: RelayLocator = {
    turn: ["turns:own-relay.example.org:443?transport=tcp"],
    stun: ["stun:own-relay.example.org:3478"],
  };
  const NAMED = {
    turn: ["turns:partner-relay.example.org:443?transport=tcp"],
    stun: ["stun:partner-relay.example.org:3478"],
  };

  async function dialConfig(
    invited: WebRTCEndpoint,
    readOwn: () => OwnRelayRead,
    secret: string,
  ): Promise<RTCConfiguration> {
    const options = await peerOptionsOf((factory) =>
      dialAsAcceptor(secret, invited, {
        relay: relayForRun(invited.relay, undefined, readOwn),
        peerFactory: factory,
      }),
    );
    return options.config as RTCConfiguration;
  }

  test("lists this browser's own relay, then the invitation's, under one credential", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    stubWindow();
    const secret = generateSharedSecret();
    const config = await dialConfig(
      { ...endpoint, relay: NAMED },
      () => ({
        kind: "set",
        relay: OWN,
      }),
      secret,
    );
    const expected = await mintRunRelayCredential(secret, NOW);
    expect(config.iceServers).toEqual([
      { urls: [...DEFAULT_STUN_ENTRY.urls, ...OWN.stun, ...NAMED.stun] },
      {
        urls: [...OWN.turn, ...NAMED.turn],
        username: expected.username,
        credential: expected.credential,
      },
    ]);
  });

  test("falls back to this browser's own relay when the invitation names none", async () => {
    stubWindow();
    const config = await dialConfig(
      endpoint,
      () => ({ kind: "set", relay: OWN }),
      generateSharedSecret(),
    );
    const urls = config.iceServers?.flatMap((server) => server.urls);
    expect(urls).toEqual([
      ...DEFAULT_STUN_ENTRY.urls,
      ...OWN.stun,
      ...OWN.turn,
    ]);
  });

  test("with neither is built with the unchanged configuration", async () => {
    stubWindow();
    const config = await dialConfig(
      endpoint,
      () => ({ kind: "none" }),
      generateSharedSecret(),
    );
    expect(config).toStrictEqual(NO_RELAY_CONFIG);
  });

  // The console names its relay as TURN urls alone. The browser's entry is that
  // url unchanged, under the credential the console's own run mints for the
  // same secret and instant, beside the default STUN server, gathering every
  // candidate type.
  test("from an encoded TURN-only invitation holds the inviter's url and the command line's credential", async () => {
    stubWindow();
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const secret = generateSharedSecret();
    const encoded = await encodeInvitation({
      version: "1",
      linkageTerms: getDefaultLinkageTerms("Inviter"),
      sharedSecret: secret,
      connectionEndpoint: {
        ...endpoint,
        relay: { turn: ["turns:relay.example.org:443?transport=tcp"] },
      },
    });
    const accepted = await prepareAcceptedInvitation(encoded, {
      profile: "hosted",
    });
    if (accepted.endpoint.channel !== "webrtc")
      throw new Error("the invitation decoded to a non-webrtc endpoint");

    const config = await dialConfig(
      accepted.endpoint,
      () => ({ kind: "none" }),
      accepted.token.sharedSecret,
    );

    const commandLine = await mintRunRelayCredential(secret, NOW);
    expect(config).toStrictEqual({
      ...NO_RELAY_CONFIG,
      iceServers: [
        DEFAULT_STUN_ENTRY,
        {
          urls: ["turns:relay.example.org:443?transport=tcp"],
          username: commandLine.username,
          credential: commandLine.credential,
        },
      ],
    });
  });
});

// A build naming a default relay lists it from the first attempt, beside any
// relay the invitation or this browser's own setting names, once the run has
// enrolled its key; the registrar client is mocked.
describe("the ICE list of a build naming a default relay", () => {
  const DEFAULT_RELAY = {
    turnUrl: "turns:turn.example.org:443?transport=tcp",
    registrarUrl: "https://registrar.example.org",
  };
  const OWN: RelayLocator = {
    turn: ["turns:own-relay.example.org:443?transport=tcp"],
    stun: [],
  };
  const NAMED = {
    turn: ["turns:partner-relay.example.org:443?transport=tcp"],
  };
  const registered = vi.fn<typeof enrollRelayKeyWithinWait>(() =>
    Promise.resolve({ kind: "enrolled", lapsesAt: "2026-09-22T13:10:00Z" }),
  );

  async function iceList(
    invitationRelay: { turn?: Array<string> } | undefined,
    own: OwnRelayRead,
    setting: typeof DEFAULT_RELAY | undefined,
    enroll: typeof enrollRelayKeyWithinWait = registered,
  ): Promise<{
    urls: Array<string>;
    servers: Array<RTCIceServer>;
    secret: string;
  }> {
    const secret = generateSharedSecret();
    const { relay } = await relayWithDefaultForRun(
      secret,
      relayForRun(invitationRelay, undefined, () => own),
      undefined,
      { setting: () => setting, enroll },
    );
    const servers = await buildIceServers(relay, secret, NOW);
    return { urls: servers.flatMap((server) => server.urls), servers, secret };
  }

  test("holds the default relay with no invitation or own relay", async () => {
    const { servers, secret } = await iceList(
      undefined,
      { kind: "none" },
      DEFAULT_RELAY,
    );
    const expected = await mintRunRelayCredential(secret, NOW);
    expect(servers).toEqual([
      DEFAULT_STUN_ENTRY,
      {
        urls: [DEFAULT_RELAY.turnUrl],
        username: expected.username,
        credential: expected.credential,
      },
    ]);
  });

  test("holds the default relay beside an invitation's relay", async () => {
    const { urls } = await iceList(NAMED, { kind: "none" }, DEFAULT_RELAY);
    expect(urls).toEqual([
      ...DEFAULT_STUN_ENTRY.urls,
      ...NAMED.turn,
      DEFAULT_RELAY.turnUrl,
    ]);
  });

  test("holds this browser's own relay, the invitation's, and the default relay, in that order", async () => {
    const { urls } = await iceList(
      NAMED,
      { kind: "set", relay: OWN },
      DEFAULT_RELAY,
    );
    expect(urls).toEqual([
      ...DEFAULT_STUN_ENTRY.urls,
      ...OWN.turn,
      ...NAMED.turn,
      DEFAULT_RELAY.turnUrl,
    ]);
  });

  test("holds the default relay beside this browser's own relay", async () => {
    const { urls } = await iceList(
      undefined,
      { kind: "set", relay: OWN },
      DEFAULT_RELAY,
    );
    expect(urls).toEqual([
      ...DEFAULT_STUN_ENTRY.urls,
      ...OWN.turn,
      DEFAULT_RELAY.turnUrl,
    ]);
  });

  test("lists the default relay once when the invitation names it", async () => {
    const { urls } = await iceList(
      { turn: [DEFAULT_RELAY.turnUrl] },
      { kind: "none" },
      DEFAULT_RELAY,
    );
    expect(urls).toEqual([...DEFAULT_STUN_ENTRY.urls, DEFAULT_RELAY.turnUrl]);
  });

  test("is unchanged, apart from the kept STUN server, when the build names none", async () => {
    const enroll = vi.fn<typeof enrollRelayKeyWithinWait>();
    const none = await iceList(undefined, { kind: "none" }, undefined, enroll);
    expect(none.servers).toEqual(NO_RELAY_CONFIG.iceServers);
    const named = await iceList(NAMED, { kind: "none" }, undefined, enroll);
    expect(named.urls).toEqual([...DEFAULT_STUN_ENTRY.urls, ...NAMED.turn]);
    expect(enroll).not.toHaveBeenCalled();
  });

  test("leaves the default relay out, and keeps STUN and the invitation's relay, when the enrollment fails", async () => {
    const refused = vi.fn<typeof enrollRelayKeyWithinWait>(() =>
      Promise.resolve({ kind: "failed", detail: "HTTP 409" }),
    );
    const { urls } = await iceList(
      NAMED,
      { kind: "none" },
      DEFAULT_RELAY,
      refused,
    );
    expect(urls).toEqual([...DEFAULT_STUN_ENTRY.urls, ...NAMED.turn]);
  });
});
