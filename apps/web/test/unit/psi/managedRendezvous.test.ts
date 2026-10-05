import { afterEach, describe, expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";

import {
  deriveRendezvousPeerId,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  ManagedSignalingEndpointRefusedError,
  assertManagedRendezvousPossible,
  assertManagedRerunDispatchable,
  beginManagedRendezvous,
  managedAcceptorSignalingEndpoint,
} from "@psi/managed/managedRendezvous";
import { BROKER_REGISTRATION_TIMEOUT_MS } from "@psi/transport/rendezvous";
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
// from storage), and the acceptor dials the signaling server its record saved,
// never the app's own location.

const LABEL = "Riverbend quarterly";

/** Begin the rendezvous for a record of `side` holding `sharedSecret` and
 * `exchangeFile`. */
function begin(
  side: ManagedExchangeSide,
  sharedSecret: string,
  file: ExchangeSpec,
  options?: Parameters<typeof beginManagedRendezvous>[1],
) {
  return beginManagedRendezvous(
    { side, sharedSecret, exchangeFile: file, label: LABEL },
    options,
  );
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
  inviterCalls: Array<{ secret: string }>;
  acceptorCalls: Array<{
    secret: string;
    endpoint: WebRTCEndpoint;
    options: Parameters<ManagedRendezvousFlows["dialAsAcceptor"]>[2];
  }>;
} {
  const inviterCalls: Array<{ secret: string }> = [];
  const acceptorCalls: Array<{
    secret: string;
    endpoint: WebRTCEndpoint;
    options: Parameters<ManagedRendezvousFlows["dialAsAcceptor"]>[2];
  }> = [];
  const flows: ManagedRendezvousFlows = {
    listenAsInviter: (secret) => {
      inviterCalls.push({ secret });
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
    expect(inviterCalls).toEqual([{ secret }]);
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
      listenAsInviter: (_secret, flowOptions) => {
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

describe("an acceptor's saved signaling address that fails validation", () => {
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
      /names a host that could move the connection/,
    ],
    [
      "a host holding /",
      { host: "attacker.example/x", path: "/api/" },
      /names a host that could move the connection/,
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
      /is not a complete host, port and path/,
    ],
    [
      "an empty path",
      { host: "signaling.example.org", path: "" },
      /is not a complete host, port and path/,
    ],
    ["no host", { path: "/api/" }, /is not a complete host, port and path/],
  ];

  test.each(refused)(
    "%s refuses the re-run, naming the exchange, before any flow runs",
    async (_name, server, reason) => {
      const { flows, inviterCalls, acceptorCalls } = recordingFlows();
      const file = withSavedServer(server);

      const rejection: unknown = await begin(
        "acceptor",
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
          side: "acceptor",
          exchangeFile: file,
          label: LABEL,
        }),
      ).toThrow(ManagedSignalingEndpointRefusedError);
    },
  );

  test("an unlabelled exchange is named as this saved exchange", () => {
    expect(() =>
      managedAcceptorSignalingEndpoint({
        exchangeFile: withSavedServer({ host: "a@b" }),
        label: " ",
      }),
    ).toThrow(/^This saved exchange cannot run/);
  });

  test("the inviter registers at its own server whatever its record saved", async () => {
    const { flows, inviterCalls } = recordingFlows();
    const file = withSavedServer({ host: "a@b" });

    expect(() =>
      assertManagedRendezvousPossible({
        side: "inviter",
        exchangeFile: file,
        label: LABEL,
      }),
    ).not.toThrow();
    await begin("inviter", generateSharedSecret(), file, { flows });
    expect(inviterCalls).toHaveLength(1);
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
      listenAsInviter: (s, options) =>
        listenAsInviter(s, {
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
        listenAsInviter: (_secret, options) => {
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

  test("an acceptor's record passes the relay its invitation named", async () => {
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

    expect(acceptorCalls[0].options?.relay).toEqual(named);
  });

  test("with no own relay the flows get none", async () => {
    stubAppLocation();
    const { flows, acceptorCalls } = recordingFlows();

    await begin("acceptor", generateSharedSecret(), exchangeFile(), { flows });

    expect(acceptorCalls[0].options?.relay).toBeUndefined();
  });
});
