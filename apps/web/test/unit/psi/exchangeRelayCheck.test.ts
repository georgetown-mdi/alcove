import { describe, expect, test, vi } from "vitest";

import {
  ConnectionError,
  deriveRelayExchangeId,
  deriveRelayKey,
  enrollRelayKeyWithinWait,
  generateSharedSecret,
  mintRunRelayCredential,
} from "@alcove/core";

import {
  checkTurnRelay,
  checkWebSocketRelay,
  exchangeRelayCheckSubject,
  runExchangeRelayCheck,
} from "../../../src/psi/transport/exchangeRelayCheck.js";

import type {
  MessageConnection,
  RelayEnrollmentWithinWait,
} from "@alcove/core";
import type {
  PeerConnectionFactory,
  WebSocketRelayParking,
} from "../../../src/psi/transport/exchangeRelayCheck.js";
import type { WebSocketRelayConnectionOptions } from "../../../src/psi/transport/websocketRelayConnection.js";

// The web check of an exchange's relays, driven with fake peer connections
// and a fake relay client: what it contacts, the credential and proof it
// presents, and each outcome.

const OWN_TURN = "turns:own-relay.example.org:443?transport=tcp";
const INVITED_TURN = "turn:invited-relay.example.org:3478";
const OWN_WEBSOCKET = "wss://own-relay.example.org/relay";
const DEFAULT_RELAY = {
  turnUrl: "turns:turn.example.org:443?transport=tcp",
  registrarUrl: "https://registrar.example.org",
  websocketUrl: "wss://turn.example.org/relay",
};

type TurnScenario = "works" | "not-reached" | "refused" | "no-relayed-path";

/** A fake `RTCDataChannel` end, delivering what it sends to its other end. */
class FakeChannel extends EventTarget {
  other: FakeChannel | undefined;
  send(data: unknown): void {
    const other = this.other;
    queueMicrotask(() =>
      other?.dispatchEvent(Object.assign(new Event("message"), { data })),
    );
  }
}

/** Two fake peer connections of one check, with what each was built with. */
function fakePeers(scenario: TurnScenario) {
  const built: Array<RTCConfiguration> = [];
  const peers: Array<FakePeer> = [];
  class FakePeer extends EventTarget {
    iceGatheringState: RTCIceGatheringState = "new";
    closed = false;
    channel: FakeChannel | undefined;
    createDataChannel(): FakeChannel {
      this.channel = new FakeChannel();
      return this.channel;
    }
    createOffer() {
      return Promise.resolve({ type: "offer", sdp: "" });
    }
    createAnswer() {
      return Promise.resolve({ type: "answer", sdp: "" });
    }
    setRemoteDescription() {
      return Promise.resolve();
    }
    addIceCandidate() {
      return Promise.resolve();
    }
    setLocalDescription() {
      setTimeout(() => this.gather(), 0);
      return Promise.resolve();
    }
    close(): void {
      this.closed = true;
    }
    private gather(): void {
      if (scenario === "works" || scenario === "no-relayed-path")
        this.dispatchEvent(
          Object.assign(new Event("icecandidate"), {
            candidate: { type: "relay" },
          }),
        );
      if (scenario === "refused")
        this.dispatchEvent(
          Object.assign(new Event("icecandidateerror"), { errorCode: 401 }),
        );
      this.iceGatheringState = "complete";
      this.dispatchEvent(new Event("icegatheringstatechange"));
      this.dispatchEvent(
        Object.assign(new Event("icecandidate"), { candidate: null }),
      );
      const index = peers.indexOf(this);
      if (scenario === "works" && index % 2 === 1)
        this.connect(peers[index - 1]);
    }
    private connect(offerer: FakePeer | undefined): void {
      const local = offerer?.channel;
      if (local === undefined) return;
      const remote = new FakeChannel();
      local.other = remote;
      remote.other = local;
      this.dispatchEvent(
        Object.assign(new Event("datachannel"), { channel: remote }),
      );
      local.dispatchEvent(new Event("open"));
    }
  }
  const create: PeerConnectionFactory = (configuration) => {
    built.push(configuration);
    const peer = new FakePeer();
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  };
  return { create, built, peers };
}

const ICE_SERVER = { urls: [OWN_TURN], username: "u", credential: "c" };

function bound(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

const NOT_ABORTED = new AbortController().signal;

describe("checkTurnRelay", () => {
  test("works where a message passes between two relay-only connections", async () => {
    const { create, built, peers } = fakePeers("works");
    await expect(
      checkTurnRelay(ICE_SERVER, bound(5_000), create),
    ).resolves.toBe("works");
    expect(built).toEqual([
      { iceServers: [ICE_SERVER], iceTransportPolicy: "relay" },
      { iceServers: [ICE_SERVER], iceTransportPolicy: "relay" },
    ]);
    expect(peers.every((peer) => peer.closed)).toBe(true);
  });

  test("is not reached where neither connection gathers a relay candidate", async () => {
    const { create } = fakePeers("not-reached");
    await expect(
      checkTurnRelay(ICE_SERVER, bound(5_000), create),
    ).resolves.toBe("not_reached");
  });

  test("a refused credential is credential_refused, never reached", async () => {
    const { create } = fakePeers("refused");
    await expect(
      checkTurnRelay(ICE_SERVER, bound(5_000), create),
    ).resolves.toBe("credential_refused");
  });

  test("relay candidates and no message by the bound is no relayed path", async () => {
    const { create } = fakePeers("no-relayed-path");
    await expect(checkTurnRelay(ICE_SERVER, bound(50), create)).resolves.toBe(
      "no_relayed_path",
    );
  });

  test("a second peer connection that cannot be built closes the first", async () => {
    const { create, peers } = fakePeers("works");
    let calls = 0;
    const secondThrows: PeerConnectionFactory = (configuration) => {
      calls += 1;
      if (calls === 2) throw new Error("no second peer connection");
      return create(configuration);
    };
    await expect(
      checkTurnRelay(ICE_SERVER, bound(5_000), secondThrows),
    ).rejects.toThrow("no second peer connection");
    expect(peers).toHaveLength(1);
    expect(peers[0]?.closed).toBe(true);
  });
});

type RelayScenario =
  | { kind: "pairs" }
  | { kind: "pairs-and-drops" }
  | { kind: "closes"; code: number; times?: number }
  | { kind: "role-taken" }
  | { kind: "protocol" }
  | { kind: "silent" };

/** A fake relay client: each park in `scenario`, its options recorded. */
function fakeRelay(scenario: RelayScenario) {
  const parkedWith: Array<WebSocketRelayConnectionOptions> = [];
  // One connected pair for each inviter and acceptor parked in turn: what
  // the inviter's end sends, the acceptor's end receives.
  const connectedPair = (): Array<MessageConnection> => {
    const delivered: Array<unknown> = [];
    const waiting: Array<(value: unknown) => void> = [];
    return [
      {
        send: (data) => {
          if (scenario.kind === "pairs") {
            const next = waiting.shift();
            if (next !== undefined) next(data);
            else delivered.push(data);
          }
          return Promise.resolve();
        },
        receive: () => Promise.resolve(undefined),
        close: () => Promise.resolve(),
      },
      {
        send: () => Promise.resolve(),
        receive: () =>
          delivered.length > 0
            ? Promise.resolve(delivered.shift())
            : new Promise((resolve) => waiting.push(resolve)),
        close: () => Promise.resolve(),
      },
    ];
  };
  let pair = connectedPair();
  const closed: Array<string> = [];
  const park: WebSocketRelayParking = (options) => {
    parkedWith.push(options);
    if (options.role === "inviter") pair = connectedPair();
    const index = options.role === "inviter" ? 0 : 1;
    const ends = pair;
    const listeners = new Set<() => void>();
    const parked = {
      url: options.url,
      paired: false,
      partnerStarted: false,
      failure: undefined as ConnectionError | undefined,
      onChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start: () => Promise.resolve(ends[index]),
      close: () => closed.push(options.role),
    };
    const notify = () => listeners.forEach((listener) => listener());
    setTimeout(() => {
      switch (scenario.kind) {
        case "pairs":
        case "pairs-and-drops":
          parked.paired = true;
          notify();
          return;
        case "closes":
          for (let time = 0; time < (scenario.times ?? 1); time += 1)
            options.onSetupClose?.(scenario.code);
          if (scenario.code === 4005) {
            parked.failure = new ConnectionError("expired", "transport");
            notify();
          }
          return;
        case "role-taken":
          if (options.role === "inviter") {
            parked.paired = true;
            notify();
          } else options.onSetupClose?.(4006);
          return;
        case "protocol":
          parked.failure = new ConnectionError("odd", "protocol");
          notify();
          return;
        case "silent":
          return;
      }
    }, 0);
    return parked;
  };
  return { park, parkedWith, closed };
}

const RELAY = { url: OWN_WEBSOCKET, exchangeId: "a".repeat(32) };
const RELAY_KEY = "b".repeat(64);

describe("checkWebSocketRelay", () => {
  test("parks one socket in each role under the run's exchange id and key, and works where a message passes", async () => {
    const relay = fakeRelay({ kind: "pairs" });
    await expect(
      checkWebSocketRelay(RELAY, RELAY_KEY, bound(5_000), relay.park),
    ).resolves.toEqual({ kind: "works" });
    expect(
      relay.parkedWith.map(({ url, exchangeId, role, relayKey }) => ({
        url,
        exchangeId,
        role,
        relayKey,
      })),
    ).toEqual([
      { ...RELAY, role: "inviter", relayKey: RELAY_KEY },
      { ...RELAY, role: "acceptor", relayKey: RELAY_KEY },
    ]);
  });

  test.each([
    [4003, false],
    [4004, false],
    [4008, false],
  ])("a %i refusal ends the check at once", async (code) => {
    const relay = fakeRelay({ kind: "closes", code });
    await expect(
      checkWebSocketRelay(RELAY, RELAY_KEY, bound(5_000), relay.park),
    ).resolves.toEqual({
      kind: "refused",
      closeCode: code,
      proofRemadeOnRelayClock: false,
    });
  });

  test("a 4005 after a proof made again on the relay's clock says so", async () => {
    const relay = fakeRelay({ kind: "closes", code: 4005, times: 2 });
    await expect(
      checkWebSocketRelay(RELAY, RELAY_KEY, bound(5_000), relay.park),
    ).resolves.toEqual({
      kind: "refused",
      closeCode: 4005,
      proofRemadeOnRelayClock: true,
    });
  });

  test("a partner already waiting is admitted, and no start is sent", async () => {
    const relay = fakeRelay({ kind: "role-taken" });
    const started = vi.fn();
    const park: WebSocketRelayParking = (options) => {
      const parked = relay.park(options);
      return {
        ...parked,
        get paired() {
          return parked.paired;
        },
        get failure() {
          return parked.failure;
        },
        start: () => {
          started();
          return parked.start();
        },
      };
    };
    await expect(
      checkWebSocketRelay(RELAY, RELAY_KEY, bound(5_000), park),
    ).resolves.toEqual({ kind: "admitted" });
    expect(started).not.toHaveBeenCalled();
    expect(relay.closed.sort()).toEqual(["acceptor", "inviter"]);
  });

  test("an answer the client does not take is unexpected_message", async () => {
    const relay = fakeRelay({ kind: "protocol" });
    await expect(
      checkWebSocketRelay(RELAY, RELAY_KEY, bound(5_000), relay.park),
    ).resolves.toEqual({ kind: "unexpected_message" });
  });

  test("no answer by the bound is not reached", async () => {
    const relay = fakeRelay({ kind: "silent" });
    await expect(
      checkWebSocketRelay(RELAY, RELAY_KEY, bound(50), relay.park),
    ).resolves.toEqual({ kind: "not_reached" });
  });

  test("paired and no message by the bound is no relayed path", async () => {
    const relay = fakeRelay({ kind: "pairs-and-drops" });
    await expect(
      checkWebSocketRelay(RELAY, RELAY_KEY, bound(50), relay.park),
    ).resolves.toEqual({ kind: "no_relayed_path" });
  });
});

const ENROLLED: RelayEnrollmentWithinWait = {
  kind: "enrolled",
  lapsesAt: "2026-11-07T18:10:00Z",
};

describe("runExchangeRelayCheck", () => {
  test("contacts nothing until it starts, then presents the credential the exchange's secret derives", async () => {
    const secret = generateSharedSecret();
    const enroll = vi.fn<typeof enrollRelayKeyWithinWait>(() =>
      Promise.resolve(ENROLLED),
    );
    const peers = fakePeers("works");
    const create = vi.fn<PeerConnectionFactory>(peers.create);
    const relay = fakeRelay({ kind: "pairs" });
    const park = vi.fn<WebSocketRelayParking>(relay.park);
    const subject = exchangeRelayCheckSubject(
      secret,
      { turn: [INVITED_TURN] },
      undefined,
      {
        readOwn: () => ({
          kind: "set",
          relay: { turn: [OWN_TURN], stun: [], websocket: OWN_WEBSOCKET },
        }),
        build: () => ({ kind: "on", relay: DEFAULT_RELAY }),
        enroll,
      },
    );
    expect(subject.hosts).toEqual({
      registrar: DEFAULT_RELAY.registrarUrl,
      turn: [OWN_TURN, INVITED_TURN, DEFAULT_RELAY.turnUrl],
      websocket: [OWN_WEBSOCKET, DEFAULT_RELAY.websocketUrl],
      listedOnceEnrolled: [DEFAULT_RELAY.turnUrl, DEFAULT_RELAY.websocketUrl],
      leftOut: [],
    });
    expect(enroll).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(park).not.toHaveBeenCalled();

    const now = new Date("2026-11-07T17:00:00Z");
    const lines = await runExchangeRelayCheck(subject, NOT_ABORTED, {
      createPeerConnection: create,
      parkWebSocketRelay: park,
      now: () => now,
    });
    expect(enroll).toHaveBeenCalledOnce();
    expect(lines.map((line) => [line.relay, line.url])).toEqual([
      ["turn", OWN_TURN],
      ["turn", INVITED_TURN],
      ["turn", DEFAULT_RELAY.turnUrl],
      ["websocket", OWN_WEBSOCKET],
      ["websocket", DEFAULT_RELAY.websocketUrl],
    ]);
    const relayKey = await deriveRelayKey(secret);
    const { username, credential } = await mintRunRelayCredential(secret, now);
    const presented = {
      iceTransportPolicy: "relay",
    };
    expect(create.mock.calls.map(([configuration]) => configuration)).toEqual(
      [OWN_TURN, INVITED_TURN, DEFAULT_RELAY.turnUrl].flatMap((url) =>
        Array.from({ length: 2 }, () => ({
          iceServers: [{ urls: [url], username, credential }],
          ...presented,
        })),
      ),
    );
    const derivedId = await deriveRelayExchangeId(secret);
    expect(
      park.mock.calls.map(([options]) => [
        options.url,
        options.exchangeId,
        options.relayKey,
      ]),
    ).toEqual([
      [OWN_WEBSOCKET, derivedId, relayKey],
      [OWN_WEBSOCKET, derivedId, relayKey],
      [DEFAULT_RELAY.websocketUrl, derivedId, relayKey],
      [DEFAULT_RELAY.websocketUrl, derivedId, relayKey],
    ]);
  });

  test("a default relay that does not enroll the exchange is reported not enrolled and is not contacted", async () => {
    const enroll = vi.fn<typeof enrollRelayKeyWithinWait>(() =>
      Promise.resolve({ kind: "failed", detail: "unreachable" }),
    );
    const peers = fakePeers("works");
    const create = vi.fn<PeerConnectionFactory>(peers.create);
    const relay = fakeRelay({ kind: "pairs" });
    const park = vi.fn<WebSocketRelayParking>(relay.park);
    const subject = exchangeRelayCheckSubject(
      generateSharedSecret(),
      undefined,
      undefined,
      { build: () => ({ kind: "on", relay: DEFAULT_RELAY }), enroll },
    );
    const lines = await runExchangeRelayCheck(subject, NOT_ABORTED, {
      createPeerConnection: create,
      parkWebSocketRelay: park,
    });
    expect(lines).toEqual([
      {
        relay: "turn",
        url: DEFAULT_RELAY.turnUrl,
        notEnrolled: { cause: "unreachable" },
      },
      {
        relay: "websocket",
        url: DEFAULT_RELAY.websocketUrl,
        notEnrolled: { cause: "unreachable" },
      },
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(park).not.toHaveBeenCalled();
  });

  test("repeat checks of one exchange enroll the same key under the same id", async () => {
    const secret = generateSharedSecret();
    const requests: Array<string> = [];
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      requests.push(`${String(input)} ${String(init?.body)}`);
      return Promise.resolve(
        new Response(
          JSON.stringify({ maxAgeDays: null, lapsesAt: ENROLLED.lapsesAt }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    const subject = exchangeRelayCheckSubject(secret, undefined, undefined, {
      build: () => ({ kind: "on", relay: DEFAULT_RELAY }),
      enroll: (params, options) =>
        enrollRelayKeyWithinWait(params, { ...options, fetch }),
    });
    const dependencies = {
      createPeerConnection: fakePeers("works").create,
      parkWebSocketRelay: fakeRelay({ kind: "pairs" }).park,
    };
    await runExchangeRelayCheck(subject, NOT_ABORTED, dependencies);
    await runExchangeRelayCheck(subject, NOT_ABORTED, {
      ...dependencies,
      createPeerConnection: fakePeers("works").create,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[0]).toContain(await deriveRelayExchangeId(secret));
  });

  test("a url the allowed relays leave out is neither contacted nor reported", async () => {
    const peers = fakePeers("works");
    const create = vi.fn<PeerConnectionFactory>(peers.create);
    const subject = exchangeRelayCheckSubject(
      generateSharedSecret(),
      { turn: [INVITED_TURN] },
      ["own-relay.example.org:443"],
      {
        readOwn: () => ({ kind: "set", relay: { turn: [OWN_TURN], stun: [] } }),
        build: () => ({ kind: "none" }),
      },
    );
    expect(subject.hosts.leftOut).toEqual([INVITED_TURN]);
    const lines = await runExchangeRelayCheck(subject, NOT_ABORTED, {
      createPeerConnection: create,
    });
    expect(lines.map(({ url }) => url)).toEqual([OWN_TURN]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  function ownAndInvitedRelays(): ReturnType<typeof exchangeRelayCheckSubject> {
    return exchangeRelayCheckSubject(
      generateSharedSecret(),
      { turn: [INVITED_TURN] },
      undefined,
      {
        readOwn: () => ({
          kind: "set",
          relay: { turn: [OWN_TURN], stun: [], websocket: OWN_WEBSOCKET },
        }),
        build: () => ({ kind: "none" }),
      },
    );
  }

  test("a relay whose request throws is not started, and the other relays keep their results", async () => {
    const peers = fakePeers("works");
    const invitedThrows: PeerConnectionFactory = (configuration) => {
      const urls = (configuration.iceServers ?? []).flatMap(
        (server) => server.urls,
      );
      if (urls.includes(INVITED_TURN)) throw new Error("cannot build");
      return peers.create(configuration);
    };
    const lines = await runExchangeRelayCheck(
      ownAndInvitedRelays(),
      NOT_ABORTED,
      {
        createPeerConnection: invitedThrows,
        parkWebSocketRelay: fakeRelay({ kind: "pairs" }).park,
      },
    );
    expect(lines).toEqual([
      { relay: "turn", url: OWN_TURN, result: "works" },
      { relay: "turn", url: INVITED_TURN, result: "not_started" },
      { relay: "websocket", url: OWN_WEBSOCKET, result: { kind: "works" } },
    ]);
  });

  test("a TURN credential that cannot be made is reported on every TURN relay, and contacts none of them", async () => {
    const peers = fakePeers("works");
    const lines = await runExchangeRelayCheck(
      ownAndInvitedRelays(),
      NOT_ABORTED,
      {
        createPeerConnection: peers.create,
        parkWebSocketRelay: fakeRelay({ kind: "pairs" }).park,
        now: () => new Date(Number.NaN),
      },
    );
    expect(lines).toEqual([
      { relay: "turn", url: OWN_TURN, result: "credential_not_made" },
      { relay: "turn", url: INVITED_TURN, result: "credential_not_made" },
      { relay: "websocket", url: OWN_WEBSOCKET, result: { kind: "works" } },
    ]);
    expect(peers.peers).toHaveLength(0);
  });

  test("a WebSocket relay whose request throws is not started, and the TURN relays keep their results", async () => {
    const lines = await runExchangeRelayCheck(
      ownAndInvitedRelays(),
      NOT_ABORTED,
      {
        createPeerConnection: fakePeers("works").create,
        parkWebSocketRelay: () => {
          throw new Error("cannot park");
        },
      },
    );
    expect(lines).toEqual([
      { relay: "turn", url: OWN_TURN, result: "works" },
      { relay: "turn", url: INVITED_TURN, result: "works" },
      {
        relay: "websocket",
        url: OWN_WEBSOCKET,
        result: { kind: "not_started" },
      },
    ]);
  });

  test("an abort closes every request's peer connections and sockets, and rejects", async () => {
    const peers = fakePeers("no-relayed-path");
    const relay = fakeRelay({ kind: "silent" });
    const park = vi.fn<WebSocketRelayParking>(relay.park);
    const check = new AbortController();
    const running = runExchangeRelayCheck(ownAndInvitedRelays(), check.signal, {
      createPeerConnection: peers.create,
      parkWebSocketRelay: park,
      boundMs: 60_000,
    });
    await vi.waitFor(() => {
      expect(peers.peers).toHaveLength(4);
      expect(park).toHaveBeenCalledTimes(2);
    });
    check.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(peers.peers.every((peer) => peer.closed)).toBe(true);
    expect(relay.closed.sort()).toEqual(["acceptor", "inviter"]);
  });
});
