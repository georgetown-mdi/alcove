import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  deriveRendezvousPeerId,
  enrollRelayKeyWithinWait,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  BROKER_REGISTRATION_TIMEOUT_MS,
  buildIceServers,
} from "@psi/transport/rendezvous";
import {
  ManagedSignalingEndpointRefusedError,
  assertManagedRendezvousPossible,
  assertManagedRerunDispatchable,
  beginManagedRendezvous,
  managedRendezvousPreviousSecret,
  managedRunRelayPlan,
  managedSignalingEndpoint,
} from "@psi/managed/managedRendezvous";
import { DEFAULT_RELAY_NOT_ENROLLED_NOTICE } from "@psi/transport/defaultRelay";
import { PartnerNoShowError } from "@psi/transport/waitForConnection";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import type {
  ExchangeSpec,
  WebRTCEndpoint,
  WebRTCExchangeLocator,
} from "@alcove/core";
import type { DataConnection } from "peerjs";
import type Peer from "peerjs";

import type { ManagedExchangeSide } from "@psi/managed/managedExchangeRecord";
import type { ManagedRendezvousFlows } from "@psi/managed/managedRendezvous";

// The side-dispatched rendezvous, tested in Node with the rendezvous flows faked:
// the record's local `side` selects listenAsInviter vs dialAsAcceptor, the
// current sharedSecret goes to whichever runs (its peer id derives fresh, never
// from storage), and both sides reach the signaling server the record saved,
// never the app's own location.

const LABEL = "Riverbend quarterly";

/** Plan the relays of a record of `side` holding `sharedSecret` and
 * `exchangeFile`, then begin its rendezvous on them, as a run does. */
async function begin(
  side: ManagedExchangeSide,
  sharedSecret: string,
  file: ExchangeSpec,
  options: Parameters<typeof managedRunRelayPlan>[1] &
    Omit<Parameters<typeof beginManagedRendezvous>[1], "relayPlan"> = {},
) {
  const record = { side, sharedSecret, exchangeFile: file, label: LABEL };
  const relayPlan = await managedRunRelayPlan(record, options);
  return beginManagedRendezvous(record, { ...options, relayPlan });
}

// Every locator field differs from the stubbed app location below, so an
// assertion on the dial endpoint distinguishes the two sources.
const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 9999,
  path: "/stored-locator/",
};

function exchangeFile(
  locator: WebRTCExchangeLocator = webrtcLocator,
): ExchangeSpec {
  return composeManagedExchangeFile({
    connection: locator,
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
  });
}

/** A fake peer the flows resolve, distinct per flow so a test can tell which ran. */
function fakePeer(tag: string): Peer {
  return { tag } as unknown as Peer;
}

function fakeConn(): DataConnection {
  return {} as unknown as DataConnection;
}

/** Recording flows: capture the (secret, endpoint) each flow was called with, so a
 * test asserts the side dispatch and the current-secret pass-through. */
function recordingFlows(): {
  flows: ManagedRendezvousFlows;
  inviterCalls: Array<{ secret: string; endpoint: WebRTCEndpoint }>;
  acceptorCalls: Array<{
    secret: string;
    endpoint: WebRTCEndpoint;
    options: Parameters<ManagedRendezvousFlows["dialAsAcceptor"]>[2];
  }>;
} {
  const inviterCalls: Array<{ secret: string; endpoint: WebRTCEndpoint }> = [];
  const acceptorCalls: Array<{
    secret: string;
    endpoint: WebRTCEndpoint;
    options: Parameters<ManagedRendezvousFlows["dialAsAcceptor"]>[2];
  }> = [];
  const flows: ManagedRendezvousFlows = {
    listenAsInviter: (secret, endpoint) => {
      inviterCalls.push({ secret, endpoint });
      return Promise.resolve(fakePeer("inviter"));
    },
    dialAsAcceptor: (secret, endpoint, options) => {
      acceptorCalls.push({ secret, endpoint, options });
      return Promise.resolve([fakePeer("acceptor"), fakeConn()]);
    },
  };
  return { flows, inviterCalls, acceptorCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The app's own location, stubbed: what the acceptor's dial endpoint must derive
 * from. */
function stubAppLocation(): void {
  vi.stubGlobal("window", {
    location: {
      origin: "https://app.example.test:3000",
      hostname: "app.example.test",
      port: "3000",
      protocol: "https:",
    },
  });
}

describe("beginManagedRendezvous: side dispatch", () => {
  test("side inviter runs listenAsInviter with the current secret, not dialAsAcceptor", async () => {
    const secret = generateSharedSecret();
    const { flows, inviterCalls, acceptorCalls } = recordingFlows();

    const acquisition = await begin("inviter", secret, exchangeFile(), {
      flows,
    });

    expect(acquisition.side).toBe("inviter");
    expect(inviterCalls.map((call) => call.secret)).toEqual([secret]);
    // The acceptor flow was never reached: the dispatch is on `side`.
    expect(acceptorCalls).toHaveLength(0);
  });

  test("side acceptor runs dialAsAcceptor with the current secret", async () => {
    stubAppLocation();
    const secret = generateSharedSecret();
    const { flows, inviterCalls, acceptorCalls } = recordingFlows();

    const acquisition = await begin("acceptor", secret, exchangeFile(), {
      flows,
    });

    expect(acquisition.side).toBe("acceptor");
    expect(inviterCalls).toHaveLength(0);
    expect(acceptorCalls).toHaveLength(1);
    expect(acceptorCalls[0].secret).toBe(secret);
  });

  test("the acceptor dials the signaling server its record saved, not the app's own", async () => {
    stubAppLocation();
    const { flows, acceptorCalls } = recordingFlows();

    await begin("acceptor", generateSharedSecret(), exchangeFile(), { flows });

    expect(acceptorCalls[0].endpoint).toEqual({
      channel: "webrtc",
      host: webrtcLocator.host,
      port: webrtcLocator.port,
      path: webrtcLocator.path,
    });
  });

  test("the inviter registers at the signaling server its record saved, not the app's own", async () => {
    stubAppLocation();
    const { flows, inviterCalls } = recordingFlows();

    await begin("inviter", generateSharedSecret(), exchangeFile(), { flows });

    expect(inviterCalls[0].endpoint).toEqual({
      channel: "webrtc",
      host: webrtcLocator.host,
      port: webrtcLocator.port,
      path: webrtcLocator.path,
    });
  });

  test("a saved address with no port or path is dialled as saved, the defaults left to the dial", async () => {
    const { flows, acceptorCalls } = recordingFlows();

    await begin(
      "acceptor",
      generateSharedSecret(),
      exchangeFile({ channel: "webrtc", host: "signaling.example.org" }),
      { flows },
    );

    expect(acceptorCalls[0].endpoint).toEqual({
      channel: "webrtc",
      host: "signaling.example.org",
    });
  });

  test("passes a supplied peer-wait bound into the acceptor's dial budget", async () => {
    stubAppLocation();
    const { flows, acceptorCalls } = recordingFlows();

    await begin("acceptor", generateSharedSecret(), exchangeFile(), {
      flows,
      peerWaitTimeoutMs: 90_000,
    });

    expect(acceptorCalls[0].options?.totalTimeoutMs).toBe(90_000);
  });

  test("supplies no dial budget of its own when none is given", async () => {
    stubAppLocation();
    const { flows, acceptorCalls } = recordingFlows();

    await begin("acceptor", generateSharedSecret(), exchangeFile(), { flows });

    // Absent rather than an explicit undefined, and absent rather than a bound
    // this module picked: the dial keeps the flows' own shared default, and the
    // only policy that overrides it is the scheduled runner's window clamp.
    expect(acceptorCalls[0].options).not.toHaveProperty("totalTimeoutMs");
  });

  test("a non-webrtc stored connection cannot re-run and fails before any flow", async () => {
    // A record whose connection is not webrtc is not live-coordinated; the dispatch
    // must fail before either flow runs, on either side.
    const notWebrtc = {
      ...exchangeFile(),
      connection: { channel: "filedrop" },
    } as unknown as ExchangeSpec;
    const { flows, inviterCalls, acceptorCalls } = recordingFlows();
    await expect(
      begin("acceptor", generateSharedSecret(), notWebrtc, {
        flows,
      }),
    ).rejects.toThrow(/webrtc/);
    await expect(
      begin("inviter", generateSharedSecret(), notWebrtc, {
        flows,
      }),
    ).rejects.toThrow(/webrtc/);
    expect(inviterCalls).toHaveLength(0);
    expect(acceptorCalls).toHaveLength(0);
  });
});

describe("beginManagedRendezvous: registration bound", () => {
  function registrationBoundFlows(): {
    flows: ManagedRendezvousFlows;
    options: Array<{ registrationTimeoutMs?: number } | undefined>;
  } {
    const options: Array<{ registrationTimeoutMs?: number } | undefined> = [];
    const flows: ManagedRendezvousFlows = {
      listenAsInviter: (_secret, _endpoint, flowOptions) => {
        options.push(flowOptions);
        return Promise.resolve(fakePeer("inviter"));
      },
      dialAsAcceptor: (_secret, _endpoint, flowOptions) => {
        options.push(flowOptions);
        return Promise.resolve([fakePeer("acceptor"), fakeConn()]);
      },
    };
    return { flows, options };
  }

  test.each(["inviter", "acceptor"] as const)(
    "the %s's registration ends with a peer wait shorter than its default",
    async (side) => {
      stubAppLocation();
      const { flows, options } = registrationBoundFlows();
      const peerWaitTimeoutMs = BROKER_REGISTRATION_TIMEOUT_MS - 18_000;

      await begin(side, generateSharedSecret(), exchangeFile(), {
        flows,
        peerWaitTimeoutMs,
      });

      expect(options).toHaveLength(1);
      expect(options[0]?.registrationTimeoutMs).toBe(peerWaitTimeoutMs);
    },
  );

  test.each(["inviter", "acceptor"] as const)(
    "the %s's registration keeps its default under a longer peer wait",
    async (side) => {
      stubAppLocation();
      const { flows, options } = registrationBoundFlows();

      await begin(side, generateSharedSecret(), exchangeFile(), {
        flows,
        peerWaitTimeoutMs: 90_000,
      });

      expect(options[0]?.registrationTimeoutMs).toBe(
        BROKER_REGISTRATION_TIMEOUT_MS,
      );
    },
  );

  test.each(["inviter", "acceptor"] as const)(
    "the %s's registration bound is left to the flow with no peer wait",
    async (side) => {
      stubAppLocation();
      const { flows, options } = registrationBoundFlows();

      await begin(side, generateSharedSecret(), exchangeFile(), { flows });

      expect(options[0]).not.toHaveProperty("registrationTimeoutMs");
    },
  );
});

describe("a saved signaling address that fails validation", () => {
  /** A record whose saved `connection.server` is `server`, as storage could
   * hold it past the type. */
  function withSavedServer(server: Record<string, unknown>): ExchangeSpec {
    const file = exchangeFile();
    return {
      ...file,
      connection: { ...file.connection, server },
    } as unknown as ExchangeSpec;
  }

  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "a host holding @",
      { host: "partner.example@attacker.example", port: 443, path: "/api/" },
      /names a host that is not a host name or IP address alone/,
    ],
    [
      "a host holding /",
      { host: "attacker.example/x", path: "/api/" },
      /names a host that is not a host name or IP address alone/,
    ],
    [
      "a path not starting with /",
      { host: "signaling.example.org", path: "api/" },
      /names a path that could move the connection/,
    ],
    [
      "a path holding ?",
      { host: "signaling.example.org", path: "/api/?x=" },
      /names a path that could move the connection/,
    ],
    [
      "port 0",
      { host: "signaling.example.org", port: 0 },
      /is not a complete host, port, and path/,
    ],
    [
      "an empty path",
      { host: "signaling.example.org", path: "" },
      /is not a complete host, port, and path/,
    ],
    ["no host", { path: "/api/" }, /is not a complete host, port, and path/],
  ];

  const sides = ["acceptor", "inviter"] as const;

  test.each(
    sides.flatMap((side) =>
      refused.map(
        ([name, server, reason]) => [side, name, server, reason] as const,
      ),
    ),
  )(
    "an %s's %s refuses the re-run, naming the exchange, before any flow runs",
    async (side, _name, server, reason) => {
      const { flows, inviterCalls, acceptorCalls } = recordingFlows();
      const file = withSavedServer(server);

      const rejection: unknown = await begin(
        side,
        generateSharedSecret(),
        file,
        { flows },
      ).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ManagedSignalingEndpointRefusedError);
      const message = (rejection as Error).message;
      expect(message).toMatch(/^The saved exchange "Riverbend quarterly"/);
      expect(message).toMatch(reason);
      if (typeof server.host === "string")
        expect(message).not.toContain(server.host);
      expect(acceptorCalls).toHaveLength(0);
      expect(inviterCalls).toHaveLength(0);
      expect(() =>
        assertManagedRendezvousPossible({
          side,
          exchangeFile: file,
          label: LABEL,
        }),
      ).toThrow(ManagedSignalingEndpointRefusedError);
    },
  );

  test("an unlabelled exchange is named as this saved exchange", () => {
    expect(() =>
      managedSignalingEndpoint({
        side: "acceptor",
        exchangeFile: withSavedServer({ host: "a@b" }),
        label: " ",
      }),
    ).toThrow(/^This saved exchange cannot run/);
  });

  test.each([
    ["acceptor", "Ask your partner for a new invitation and accept it."],
    [
      "inviter",
      "Re-invite your partner with the same terms to name this browser's current coordination server. If relay settings cannot read your coordination server, set it again or clear it there first.",
    ],
  ] as const)("an %s's refusal ends on its own remedy", (side, remedy) => {
    expect(() =>
      managedSignalingEndpoint({
        side,
        exchangeFile: withSavedServer({ host: "a@b" }),
        label: LABEL,
      }),
    ).toThrow(remedy);
  });
});

describe("assertManagedRerunDispatchable", () => {
  test("accepts a webrtc record and rejects any other channel", () => {
    expect(() => assertManagedRerunDispatchable(exchangeFile())).not.toThrow();
    const notWebrtc = {
      ...exchangeFile(),
      connection: { channel: "sftp" },
    } as unknown as ExchangeSpec;
    expect(() => assertManagedRerunDispatchable(notWebrtc)).toThrow(/sftp/);
  });
});

// --- Per-run peer-id derivation from the CURRENT secret (real listenAsInviter) --

class FakePeer extends EventEmitter {
  destroy = vi.fn();
  disconnect = vi.fn();
}

describe("per-run peer id derives fresh from the current secret", () => {
  test("the inviter registers on deriveRendezvousPeerId(currentSecret, inviter)", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", port: "3000", protocol: "http:" },
    });
    const secret = generateSharedSecret();
    const expected = await deriveRendezvousPeerId(secret, "inviter");

    // The real listenAsInviter with an injected peer factory: capture the id it
    // registers, which must be the derivation over THIS secret (never a stored id).
    let constructedId: string | undefined;
    const { listenAsInviter } = await import("@psi/transport/rendezvous");
    const flows: ManagedRendezvousFlows = {
      listenAsInviter: (s, endpoint, options) =>
        listenAsInviter(s, endpoint, {
          ...options,
          peerFactory: (id) => {
            constructedId = id;
            const peer = new FakePeer();
            queueMicrotask(() => peer.emit("open"));
            return peer as unknown as Peer;
          },
        }),
      dialAsAcceptor: () => {
        throw new Error("acceptor flow must not run for side inviter");
      },
    };

    await begin("inviter", secret, exchangeFile(), { flows });
    expect(constructedId).toBe(expected);

    // A different secret derives a different id: the id is not read from storage.
    const otherSecret = generateSharedSecret();
    const otherExpected = await deriveRendezvousPeerId(otherSecret, "inviter");
    expect(otherExpected).not.toBe(expected);
  });
});

describe("beginManagedRendezvous: relay", () => {
  const ownRelay = {
    turn: ["turns:relay.example.org:443?transport=tcp"],
    stun: [],
  };

  function stubOwnRelay(): void {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "alcove-own-relay"
          ? JSON.stringify({ version: 1, ...ownRelay })
          : null,
    });
  }

  test.each(["inviter", "acceptor"] as const)(
    "the %s's flow gathers against this browser's own relay",
    async (side) => {
      stubAppLocation();
      stubOwnRelay();
      const relays: Array<unknown> = [];
      const flows: ManagedRendezvousFlows = {
        listenAsInviter: (_secret, _endpoint, options) => {
          relays.push(options?.relay);
          return Promise.resolve(fakePeer("inviter"));
        },
        dialAsAcceptor: (_secret, _endpoint, options) => {
          relays.push(options?.relay);
          return Promise.resolve([fakePeer("acceptor"), fakeConn()]);
        },
      };

      await begin(side, generateSharedSecret(), exchangeFile(), {
        flows,
      });

      expect(relays).toEqual([ownRelay]);
    },
  );

  test("an acceptor's record lists this browser's own relay, then the one its invitation named", async () => {
    stubAppLocation();
    stubOwnRelay();
    const named = {
      turn: ["turns:partner-relay.example.org:443?transport=tcp"],
      stun: ["stun:partner-relay.example.org:3478"],
    };
    const { flows, acceptorCalls } = recordingFlows();

    await begin(
      "acceptor",
      generateSharedSecret(),
      exchangeFile({ ...webrtcLocator, relay: named }),
      { flows },
    );

    expect(acceptorCalls[0].options?.relay).toEqual({
      turn: [...ownRelay.turn, ...named.turn],
      stun: named.stun,
    });
  });

  test("an acceptor's record lists the build's default relay last once this run enrolled there", async () => {
    stubAppLocation();
    stubOwnRelay();
    const defaultTurnUrl = "turns:turn.example.org:443?transport=tcp";
    const named = {
      turn: [
        "turns:partner-relay.example.org:443?transport=tcp",
        defaultTurnUrl,
      ],
    };
    const { flows, acceptorCalls } = recordingFlows();
    const onRunNotice = vi.fn();

    await begin(
      "acceptor",
      generateSharedSecret(),
      exchangeFile({ ...webrtcLocator, relay: named }),
      {
        flows,
        onRunNotice,
        defaultRelay: {
          setting: () => ({
            turnUrl: defaultTurnUrl,
            registrarUrl: "https://registrar.example.org",
          }),
          enroll: () => Promise.resolve({ kind: "enrolled", lapsesAt: null }),
        },
      },
    );

    expect(acceptorCalls[0].options?.relay).toEqual({
      turn: [...ownRelay.turn, named.turn[0], defaultTurnUrl],
      stun: [],
    });
    expect(onRunNotice).not.toHaveBeenCalled();
  });

  test("an acceptor's record lists only the relays its own allowed relays keep, and says which", async () => {
    stubAppLocation();
    stubOwnRelay();
    const named = {
      turn: ["turns:partner-relay.example.org:443?transport=tcp"],
    };
    const { flows, acceptorCalls } = recordingFlows();
    const onRunNotice = vi.fn();

    await begin(
      "acceptor",
      generateSharedSecret(),
      composeManagedExchangeFile({
        connection: { ...webrtcLocator, relay: named },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
        allowedRelays: ["partner-relay.example.org"],
      }),
      { flows, onRunNotice },
    );

    expect(acceptorCalls[0].options?.relay).toEqual({
      turn: named.turn,
      stun: [],
    });
    expect(acceptorCalls[0].options?.relaysLeftOut).toEqual(ownRelay.turn);
    expect(onRunNotice).toHaveBeenCalledWith(
      expect.stringContaining(`leave out ${ownRelay.turn[0]}`),
    );
  });

  test("this browser's stored allowed relays do not narrow a record's run", async () => {
    stubAppLocation();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === "alcove-own-relay")
          return JSON.stringify({ version: 1, ...ownRelay });
        if (key === "alcove-relay-restriction")
          return JSON.stringify({
            version: 1,
            allowedRelays: ["elsewhere.example.org"],
          });
        return null;
      },
    });
    const { flows, acceptorCalls } = recordingFlows();

    await begin("acceptor", generateSharedSecret(), exchangeFile(), { flows });

    expect(acceptorCalls[0].options?.relay).toEqual(ownRelay);
    expect(acceptorCalls[0].options?.relaysLeftOut).toEqual([]);
  });

  test("a record's run lists the STUN urls this browser's setting names when the run starts and the invitation's, in place of the default", async () => {
    stubAppLocation();
    const ownStun = "stun:own-stun.example.org:3478";
    const named = { stun: ["stun:partner-relay.example.org:3478"] };
    let stored: object = { ...ownRelay, stun: [ownStun] };
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "alcove-own-relay"
          ? JSON.stringify({ version: 1, ...stored })
          : null,
    });
    const { flows, acceptorCalls } = recordingFlows();
    const file = exchangeFile({ ...webrtcLocator, relay: named });
    const stunListed = async (call: number) => {
      const [stun] = await buildIceServers(
        acceptorCalls[call].options?.relay,
        generateSharedSecret(),
        new Date(),
      );
      return stun.urls;
    };

    await begin("acceptor", generateSharedSecret(), file, { flows });
    stored = ownRelay;
    await begin("acceptor", generateSharedSecret(), file, { flows });
    await begin("acceptor", generateSharedSecret(), exchangeFile(), { flows });

    expect(await stunListed(0)).toEqual([ownStun, ...named.stun]);
    expect(await stunListed(1)).toEqual(named.stun);
    expect(await stunListed(2)).toEqual(["stun:stun.l.google.com:19302"]);
  });

  test("with no own relay the flows get none", async () => {
    stubAppLocation();
    const { flows, acceptorCalls } = recordingFlows();

    await begin("acceptor", generateSharedSecret(), exchangeFile(), { flows });

    expect(acceptorCalls[0].options?.relay).toBeUndefined();
  });

  test.each(["inviter", "acceptor"] as const)(
    "the %s's run says once, before its flow starts, that the default relay could not be set up when its registrar never answers",
    async (side) => {
      stubAppLocation();
      const events: Array<unknown> = [];
      const flows: ManagedRendezvousFlows = {
        listenAsInviter: (_secret, _endpoint, options) => {
          events.push({ relay: options?.relay });
          return Promise.resolve(fakePeer("inviter"));
        },
        dialAsAcceptor: (_secret, _endpoint, options) => {
          events.push({ relay: options?.relay });
          return Promise.resolve([fakePeer("acceptor"), fakeConn()]);
        },
      };

      await begin(side, generateSharedSecret(), exchangeFile(), {
        flows,
        onRunNotice: (message) => events.push(message),
        defaultRelay: {
          setting: () => ({
            turnUrl: "turns:turn.example.org:443?transport=tcp",
            registrarUrl: "https://registrar.example.org",
          }),
          enroll: (params, options) =>
            enrollRelayKeyWithinWait(params, {
              ...options,
              fetch: (_input, init) =>
                new Promise<never>((_resolve, reject) => {
                  init?.signal?.addEventListener("abort", () =>
                    reject(init.signal?.reason as Error),
                  );
                }),
            }),
          dialWaitMs: 50,
        },
      });

      expect(events).toEqual([
        DEFAULT_RELAY_NOT_ENROLLED_NOTICE,
        { relay: undefined },
      ]);
    },
  );
});

describe("managedRendezvousPreviousSecret", () => {
  const NOW = Date.parse("2026-07-14T12:00:00.000Z");
  const current = generateSharedSecret();
  const previous = generateSharedSecret();

  test("an acceptor offers the previous secret it holds while it is in force", () => {
    expect(
      managedRendezvousPreviousSecret(
        {
          side: "acceptor",
          sharedSecret: current,
          previousSharedSecret: previous,
          previousExpires: "2026-08-01T00:00:00.000Z",
        },
        NOW,
      ),
    ).toBe(previous);
  });

  test("offers none for an inviter, a record holding none, an expired previous secret, or one equal to the current", () => {
    expect(
      managedRendezvousPreviousSecret(
        {
          side: "inviter",
          sharedSecret: current,
          previousSharedSecret: previous,
        },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      managedRendezvousPreviousSecret(
        { side: "acceptor", sharedSecret: current },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      managedRendezvousPreviousSecret(
        {
          side: "acceptor",
          sharedSecret: current,
          previousSharedSecret: previous,
          previousExpires: "2026-07-01T00:00:00.000Z",
        },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      managedRendezvousPreviousSecret(
        {
          side: "acceptor",
          sharedSecret: current,
          previousSharedSecret: current,
        },
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("beginManagedRendezvous: an acceptor holding a previous secret", () => {
  /** A peer whose `destroy` a test can watch. */
  function destroyablePeer(tag: string): Peer {
    return { tag, destroy: vi.fn() } as unknown as Peer;
  }

  /** Acceptor flows whose dial under each secret ends as `outcomes` says,
   * once its signal is checked: `"open"` resolves at once, `"hold"` waits for
   * the leg's signal to abort, a `PartnerNoShowError` or another error after a
   * tick. */
  function legFlows(outcomes: Record<string, "open" | "hold" | Error>): {
    flows: ManagedRendezvousFlows;
    calls: Array<{ secret: string; relaySecret: string | undefined }>;
    peers: Record<string, Peer>;
    aborted: Array<string>;
  } {
    const calls: Array<{ secret: string; relaySecret: string | undefined }> =
      [];
    const peers: Record<string, Peer> = {};
    const aborted: Array<string> = [];
    const flows: ManagedRendezvousFlows = {
      listenAsInviter: () => Promise.reject(new Error("not the inviter")),
      dialAsAcceptor: (secret, _endpoint, options) => {
        calls.push({ secret, relaySecret: options?.relaySecret });
        const peer = destroyablePeer(secret);
        peers[secret] = peer;
        const outcome = outcomes[secret];
        const signal = options?.signal;
        signal?.addEventListener("abort", () => aborted.push(secret));
        if (outcome === "open") return Promise.resolve([peer, fakeConn()]);
        if (outcome === "hold")
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () =>
              resolve([peer, fakeConn()]),
            );
          });
        return new Promise((_resolve, reject) =>
          setTimeout(() => reject(outcome), 0),
        );
      },
    };
    return { flows, calls, peers, aborted };
  }

  test("dials under both secrets at once, minting the relay credential from the current one", async () => {
    stubAppLocation();
    const current = generateSharedSecret();
    const previous = generateSharedSecret();
    const { flows, calls } = legFlows({
      [current]: "hold",
      [previous]: "open",
    });

    const acquisition = await begin("acceptor", current, exchangeFile(), {
      flows,
      previousSharedSecret: previous,
    });

    expect(calls).toEqual([
      { secret: current, relaySecret: current },
      { secret: previous, relaySecret: current },
    ]);
    expect(acquisition.side === "acceptor" && acquisition.peer).toMatchObject({
      tag: previous,
    });
  });

  test("the first channel to open is the run's, and the other dial is stopped and its peer destroyed", async () => {
    stubAppLocation();
    const current = generateSharedSecret();
    const previous = generateSharedSecret();
    const { flows, peers, aborted } = legFlows({
      [current]: "open",
      [previous]: "hold",
    });

    const acquisition = await begin("acceptor", current, exchangeFile(), {
      flows,
      previousSharedSecret: previous,
    });

    expect(acquisition.side === "acceptor" && acquisition.peer).toBe(
      peers[current],
    );
    expect(aborted).toEqual([previous]);
    expect(peers[previous].destroy).toHaveBeenCalledOnce();
    expect(peers[current].destroy).not.toHaveBeenCalled();
  });

  test("a partner that does not arrive under one secret leaves the outcome to the other", async () => {
    stubAppLocation();
    const current = generateSharedSecret();
    const previous = generateSharedSecret();
    const opened = legFlows({
      [current]: new PartnerNoShowError("nobody arrived"),
      [previous]: "open",
    });
    const acquisition = await begin("acceptor", current, exchangeFile(), {
      flows: opened.flows,
      previousSharedSecret: previous,
    });
    expect(acquisition.side === "acceptor" && acquisition.peer).toBe(
      opened.peers[previous],
    );

    const noShow = new PartnerNoShowError("nobody arrived");
    const neither = legFlows({ [current]: noShow, [previous]: noShow });
    await expect(
      begin("acceptor", current, exchangeFile(), {
        flows: neither.flows,
        previousSharedSecret: previous,
      }),
    ).rejects.toBe(noShow);
  });

  test("any other failure ends both dials", async () => {
    stubAppLocation();
    const current = generateSharedSecret();
    const previous = generateSharedSecret();
    const failure = new Error("the signaling server refused the dial");
    const { flows, peers, aborted } = legFlows({
      [current]: "hold",
      [previous]: failure,
    });

    await expect(
      begin("acceptor", current, exchangeFile(), {
        flows,
        previousSharedSecret: previous,
      }),
    ).rejects.toBe(failure);
    expect(aborted).toEqual([current]);
    expect(peers[current].destroy).toHaveBeenCalledOnce();
  });

  test("a run's cancel reaches both dials", async () => {
    stubAppLocation();
    const current = generateSharedSecret();
    const previous = generateSharedSecret();
    const { flows, aborted } = legFlows({
      [current]: "hold",
      [previous]: "hold",
    });
    const run = new AbortController();

    const begun = begin("acceptor", current, exchangeFile(), {
      flows,
      previousSharedSecret: previous,
      signal: run.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    run.abort();
    await begun;

    expect(aborted.sort()).toEqual([current, previous].sort());
  });

  test("an inviter registers under its current secret alone", async () => {
    const current = generateSharedSecret();
    const { flows, inviterCalls, acceptorCalls } = recordingFlows();
    await begin("inviter", current, exchangeFile(), {
      flows,
      previousSharedSecret: generateSharedSecret(),
    });
    expect(inviterCalls.map((call) => call.secret)).toEqual([current]);
    expect(acceptorCalls).toHaveLength(0);
  });
});
