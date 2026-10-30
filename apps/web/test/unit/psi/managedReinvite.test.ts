import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  decodeInvitation,
  deriveAcceptedLinkageTerms,
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  applyManagedExchangeReinviteRotation,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  ManagedSignalingEndpointRefusedError,
  assertManagedRendezvousPossible,
  beginManagedRendezvous,
} from "@psi/managed/managedRendezvous";
import {
  canReinviteFromRecord,
  composeManagedReinvite,
} from "@psi/managed/managedReinvite";
import { NoSignalingAddressError } from "@psi/invitation";
import { reinviteLocation } from "@psi/invitationLocation";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";
import { writeCoordinationServerSetting } from "@psi/transport/coordinationServerSetting";

import type { InvitationToken, WebRTCEndpoint } from "@alcove/core";
import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { InvitationLocation } from "@psi/invitation";
import type Peer from "peerjs";

const TEST_RETIRED = { verifier: "A".repeat(43), at: 0 };

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
    {
      isConsoleBuild: () => false,
      signalingServerSetting: () => ({
        secure: true,
        host: "signaling.example.org",
        path: "/api/",
      }),
    },
  ),
);

// Fast re-invite from a stored record, tested in Node: the fresh invitation is
// composed from the record's OWN document (terms + committed send set), mints a
// fresh secret, and names this browser's coordination server setting, the
// build's server where none is set, or the record's own where the setting
// cannot be read, which its rotation stores on the record -- so the partner's
// accept re-derives its perspective, receiving the same send set, and saves the
// server this party's re-runs register at, and the operator re-authors nothing.
// Only the inviter side re-mints.

// `encodeInvitation` re-checks the token's `expires` against the real wall clock, so
// NOW must be ahead of it for the setup lifetime to encode; anchored to the actual run
// instant rather than a fixed past date.
const NOW = Date.now() + 60_000;
const STORED_SECRET = generateSharedSecret();
// A fresh secret distinct from the stored one (regenerate until it differs -- the odds
// of a collision are negligible, but the loop makes the "fresh, not stored" assertion
// deterministic).
function freshDistinctSecret(): string {
  let secret = generateSharedSecret();
  while (secret === STORED_SECRET) secret = generateSharedSecret();
  return secret;
}
const FRESH_SECRET = freshDistinctSecret();

const location: InvitationLocation = {
  origin: "https://example.org:3000",
  signaling: {
    host: "example.org",
    port: 3000,
    path: "/api/",
    secure: true,
  },
};

function inviterRecord(
  overrides: Partial<ManagedExchangeRecord> = {},
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse({
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "saved-signaling.example.org",
        port: 9999,
        path: "/signal/",
      },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: STORED_SECRET,
    standingCondition: NO_STANDING_CONDITION,
    ...overrides,
  });
}

const seams = {
  generateSecret: () => FRESH_SECRET,
  encode: encodeInvitation,
  now: () => NOW,
  ownRelay: undefined,
  defaultRelay: undefined,
};

const DEFAULT_RELAY_TURN_URL = "turns:turn.example.org:443?transport=tcp";
const DEFAULT_RELAY_REGISTRAR_URL = "https://turn.example.org";
const DEFAULT_RELAY = {
  turnUrl: DEFAULT_RELAY_TURN_URL,
  registrarUrl: DEFAULT_RELAY_REGISTRAR_URL,
};

describe("composeManagedReinvite", () => {
  test("mints a fresh secret and reuses the stored document's terms verbatim", async () => {
    const record = inviterRecord();
    const reinvite = await composeManagedReinvite(record, location, seams);

    expect(reinvite.sharedSecret).toBe(FRESH_SECRET);
    expect(reinvite.sharedSecret).not.toBe(record.sharedSecret);

    const token = await decodeInvitation(reinvite.encoded);
    expect(token.sharedSecret).toBe(FRESH_SECRET);
    // The document's terms ride verbatim: the partner adopts the same set.
    expect(token.linkageTerms).toEqual(record.exchangeFile.linkageTerms);
  });

  test("the partner's accept re-derives its perspective from the token's terms", async () => {
    const record = inviterRecord();
    const reinvite = await composeManagedReinvite(record, location, seams);
    const token = await decodeInvitation(reinvite.encoded);

    // The accept re-derives the acceptor's perspective from the same terms it did
    // originally, without error -- the round-trip is consistent.
    expect(() =>
      deriveAcceptedLinkageTerms(token.linkageTerms, "Partner Org"),
    ).not.toThrow();
  });

  test("the endpoint names the location's coordination server, not the one the record saved, and the rotation stores it", async () => {
    const record = inviterRecord();
    const reinvite = await composeManagedReinvite(record, location, seams);
    const token = await decodeInvitation(reinvite.encoded);

    expect(token.connectionEndpoint).toStrictEqual({
      channel: "webrtc",
      host: "example.org",
      port: 3000,
      path: "/api/",
    });
    expect(reinvite.rotation.signalingServer).toStrictEqual({
      host: "example.org",
      port: 3000,
      path: "/api/",
    });
    expect(reinvite.deepLink.startsWith(`${location.origin}/`)).toBe(true);
  });

  test("a record whose saved server fails validation is repointed, not refused", async () => {
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "a@b", path: "/api/" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
    });
    const reinvite = await composeManagedReinvite(record, location, seams);

    expect(reinvite.rotation.signalingServer.host).toBe("example.org");
    const repointed = applyManagedExchangeReinviteRotation(
      record,
      reinvite.rotation,
      TEST_RETIRED,
    );
    expect(() => assertManagedRendezvousPossible(repointed)).not.toThrow();
  });

  test("a location naming no coordination server mints nothing", async () => {
    await expect(
      composeManagedReinvite(
        inviterRecord(),
        { origin: location.origin, signaling: undefined },
        seams,
      ),
    ).rejects.toThrow(NoSignalingAddressError);
  });

  test("names the inviter's own relay urls and no credential", async () => {
    const ownRelay = {
      turn: ["turns:relay.example.org:443?transport=tcp"],
      stun: ["stun:relay.example.org:3478"],
    };
    const reinvite = await composeManagedReinvite(inviterRecord(), location, {
      ...seams,
      ownRelay,
    });
    const token = await decodeInvitation(reinvite.encoded);
    expect(token.connectionEndpoint).toStrictEqual({
      channel: "webrtc",
      host: "example.org",
      port: 3000,
      path: "/api/",
      relay: ownRelay,
    });
  });

  test("names the record's registrar's exchange id beside this browser's own WebSocket relay only", async () => {
    const relayRegistrar = {
      url: "https://registrar.example.org",
      exchangeId: "riverbend-quarterly",
    };
    const ownRelay = { websocket: "wss://wsrelay.example.org/relay" };
    const withId = await decodeInvitation(
      (
        await composeManagedReinvite(
          inviterRecord({ relayRegistrar }),
          location,
          {
            ...seams,
            ownRelay,
          },
        )
      ).encoded,
    );
    expect(withId.connectionEndpoint).toMatchObject({
      relay: { ...ownRelay, websocketExchangeId: relayRegistrar.exchangeId },
    });
    const withoutRegistrar = await decodeInvitation(
      (
        await composeManagedReinvite(inviterRecord(), location, {
          ...seams,
          ownRelay,
        })
      ).encoded,
    );
    expect(withoutRegistrar.connectionEndpoint).toMatchObject({
      relay: ownRelay,
    });
    expect(withoutRegistrar.connectionEndpoint).not.toHaveProperty(
      "relay.websocketExchangeId",
    );
    const defaultWebSocket = await decodeInvitation(
      (
        await composeManagedReinvite(
          inviterRecord({ relayRegistrar }),
          location,
          {
            ...seams,
            defaultRelay: {
              ...DEFAULT_RELAY,
              websocketUrl: "wss://default-wsrelay.example.org/relay",
            },
          },
        )
      ).encoded,
    );
    expect(defaultWebSocket.connectionEndpoint).toMatchObject({
      relay: { websocket: "wss://default-wsrelay.example.org/relay" },
    });
    expect(defaultWebSocket.connectionEndpoint).not.toHaveProperty(
      "relay.websocketExchangeId",
    );
  });

  test("with no own relay the invitation names none", async () => {
    const token = await decodeInvitation(
      (await composeManagedReinvite(inviterRecord(), location, seams)).encoded,
    );
    expect(token.connectionEndpoint).not.toHaveProperty("relay");
  });

  test("names the build's default relay after the own relay", async () => {
    const ownRelay = { turn: ["turns:relay.example.org:443?transport=tcp"] };
    const reinvite = await composeManagedReinvite(inviterRecord(), location, {
      ...seams,
      ownRelay,
      defaultRelay: DEFAULT_RELAY,
    });
    const token = await decodeInvitation(reinvite.encoded);
    expect(token.connectionEndpoint).toMatchObject({
      relay: {
        turn: [...ownRelay.turn, DEFAULT_RELAY_TURN_URL],
        registrar: DEFAULT_RELAY_REGISTRAR_URL,
      },
    });
  });

  test("names the build's default relay alone when this browser has no relay", async () => {
    const reinvite = await composeManagedReinvite(inviterRecord(), location, {
      ...seams,
      defaultRelay: DEFAULT_RELAY,
    });
    const token = await decodeInvitation(reinvite.encoded);
    expect(token.connectionEndpoint).toMatchObject({
      relay: {
        turn: [DEFAULT_RELAY_TURN_URL],
        registrar: DEFAULT_RELAY_REGISTRAR_URL,
      },
    });
  });

  test("leaves the build's default relay out where the record's allowed relays do", async () => {
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
        allowedRelays: ["relay.example.org"],
      }),
    });
    const reinvite = await composeManagedReinvite(record, location, {
      ...seams,
      defaultRelay: DEFAULT_RELAY,
    });
    const token = await decodeInvitation(reinvite.encoded);
    expect(token.connectionEndpoint).not.toHaveProperty("relay");
  });

  test("keeps the build's default relay where the record's allowed relays name it", async () => {
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
        allowedRelays: ["turn.example.org"],
      }),
    });
    const reinvite = await composeManagedReinvite(record, location, {
      ...seams,
      defaultRelay: DEFAULT_RELAY,
    });
    const token = await decodeInvitation(reinvite.encoded);
    expect(token.connectionEndpoint).toMatchObject({
      relay: { turn: [DEFAULT_RELAY_TURN_URL] },
    });
  });

  test("the deep link contains the encoded token in its fragment", async () => {
    const reinvite = await composeManagedReinvite(
      inviterRecord(),
      location,
      seams,
    );
    expect(reinvite.deepLink).toBe(
      `https://example.org:3000/accept#${reinvite.encoded}`,
    );
  });

  test("a document with no metadata re-mints its terms as stored", async () => {
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
    });
    const token = await decodeInvitation(
      (await composeManagedReinvite(record, location, seams)).encoded,
    );
    expect(token.linkageTerms.payload).toBeUndefined();
  });

  test("a document whose metadata discloses nothing states an empty send, so the acceptor receives nothing", async () => {
    const terms = getDefaultLinkageTerms("County Health Dept");
    expect(terms.payload).toBeUndefined();
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: terms,
        metadata: inferMetadata(["first_name", "last_name", "dob"], []),
      }),
    });
    const token = await decodeInvitation(
      (await composeManagedReinvite(record, location, seams)).encoded,
    );
    expect(token.linkageTerms.payload?.send).toEqual([]);
    expect(
      deriveAcceptedLinkageTerms(token.linkageTerms, "Partner Org").payload
        ?.receive,
    ).toEqual([]);
  });

  test("a document whose metadata discloses a column states it as the send", async () => {
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
        metadata: inferMetadata(
          ["first_name", "last_name", "dob", "id"],
          [],
        ).map((column) =>
          column.name === "id" ? { ...column, isPayload: true } : column,
        ),
      }),
    });
    const token = await decodeInvitation(
      (await composeManagedReinvite(record, location, seams)).encoded,
    );
    expect(token.linkageTerms.payload?.send).toEqual([{ name: "id" }]);
    expect(
      deriveAcceptedLinkageTerms(token.linkageTerms, "Partner Org").payload
        ?.receive,
    ).toEqual([{ name: "id" }]);
  });

  test("the acceptor side cannot re-mint from its mirrored document", async () => {
    const record = inviterRecord({ side: "acceptor" });
    expect(canReinviteFromRecord(record)).toBe(false);
    await expect(
      composeManagedReinvite(record, location, seams),
    ).rejects.toThrow(/only the inviter/i);
  });
});

describe("the coordination server a re-invite names", () => {
  const SETTING_SERVER = "wss://coordination.agency.example/signal/";
  const SETTING_ENDPOINT = {
    host: "coordination.agency.example",
    port: 443,
    path: "/signal/",
  };
  const SAVED_ENDPOINT = {
    host: "saved-signaling.example.org",
    port: 9999,
    path: "/signal/",
  };
  const relayPlan = { relaysLeftOut: [], websocketRelays: [] };

  /** Begin a run of `record` and return the endpoint its inviter registered at. */
  async function registeredAt(
    record: RunnableManagedExchangeRecord,
  ): Promise<WebRTCEndpoint> {
    const endpoints: Array<WebRTCEndpoint> = [];
    await beginManagedRendezvous(record, {
      relayPlan,
      flows: {
        listenAsInviter: (_secret, endpoint) => {
          endpoints.push(endpoint);
          return Promise.resolve({} as Peer);
        },
        dialAsAcceptor: () => Promise.reject(new Error("not the acceptor")),
      },
    });
    expect(endpoints).toHaveLength(1);
    return endpoints[0];
  }

  /** The build's own server, as the `@utils/clientConfig` mock names it. */
  const BUILD_ENDPOINT = {
    host: "signaling.example.org",
    port: 443,
    path: "/api/",
  };

  /** This browser's storage, as the stand-in holds it. */
  let stored: Map<string, string>;

  /** Re-invite from `record` at this page's re-invite location, and return
   * the server the invitation names and the record the rotation leaves. */
  async function reinviteFrom(record: RunnableManagedExchangeRecord) {
    const reinvite = await composeManagedReinvite(
      record,
      reinviteLocation(),
      seams,
    );
    const token = await decodeInvitation(reinvite.encoded);
    return {
      named: token.connectionEndpoint,
      reinvited: applyManagedExchangeReinviteRotation(
        record,
        reinvite.rotation,
        TEST_RETIRED,
      ),
    };
  }

  beforeEach(() => {
    stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
    vi.stubGlobal("window", {
      location: {
        origin: "https://app.example.org",
        protocol: "https:",
        hostname: "app.example.org",
        port: "",
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a record at server A with the setting naming B: the re-invite names B, the record then holds B, and its runs register where the record says", async () => {
    writeCoordinationServerSetting(SETTING_SERVER);
    const record = inviterRecord();
    expect(await registeredAt(record)).toStrictEqual({
      channel: "webrtc",
      ...SAVED_ENDPOINT,
    });

    const { named, reinvited } = await reinviteFrom(record);
    expect(named).toStrictEqual({ channel: "webrtc", ...SETTING_ENDPOINT });
    expect(reinvited.exchangeFile.connection).toMatchObject({
      channel: "webrtc",
      server: SETTING_ENDPOINT,
    });
    expect(reinvited.sharedSecret).toBe(FRESH_SECRET);
    expect(await registeredAt(reinvited)).toStrictEqual({
      channel: "webrtc",
      ...SETTING_ENDPOINT,
    });
  });

  test("with no setting, the re-invite names the build's server and the record then holds it", async () => {
    const { named, reinvited } = await reinviteFrom(inviterRecord());
    expect(named).toStrictEqual({ channel: "webrtc", ...BUILD_ENDPOINT });
    expect(await registeredAt(reinvited)).toStrictEqual({
      channel: "webrtc",
      ...BUILD_ENDPOINT,
    });
  });

  test("with a stored setting this page cannot read, the re-invite names the server the record holds, and the record keeps it", async () => {
    stored.set(
      "alcove-own-coordination-server",
      JSON.stringify({ version: 1, url: "ws://coordination.agency.example/" }),
    );
    const { named, reinvited } = await reinviteFrom(inviterRecord());
    expect(named).toStrictEqual({ channel: "webrtc", ...SAVED_ENDPOINT });
    expect(reinvited.exchangeFile.connection).toMatchObject({
      channel: "webrtc",
      server: SAVED_ENDPOINT,
    });
    expect(await registeredAt(reinvited)).toStrictEqual({
      channel: "webrtc",
      ...SAVED_ENDPOINT,
    });
  });

  test("with storage that refuses the read, the re-invite names the server the record holds", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("The operation is insecure.");
      },
    });
    const { named } = await reinviteFrom(inviterRecord());
    expect(named).toStrictEqual({ channel: "webrtc", ...SAVED_ENDPOINT });
  });

  test("with an unreadable setting and a saved server a run refuses, the re-invite refuses and mints nothing", async () => {
    stored.set("alcove-own-coordination-server", "{");
    const encode = vi.fn(encodeInvitation);
    const record = inviterRecord({
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "a@b", path: "/api/" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
    });
    await expect(
      composeManagedReinvite(record, reinviteLocation(), { ...seams, encode }),
    ).rejects.toThrow(ManagedSignalingEndpointRefusedError);
    expect(encode).not.toHaveBeenCalled();
  });

  test("a run with no re-invite registers at the record's server whatever the setting names", async () => {
    writeCoordinationServerSetting(SETTING_SERVER);
    expect(await registeredAt(inviterRecord())).toStrictEqual({
      channel: "webrtc",
      ...SAVED_ENDPOINT,
    });
  });
});

describe("the re-invite rotation's expires provenance", () => {
  test("the composed re-invite's rotation reflects the record's max-age policy", async () => {
    const record = inviterRecord({ tokenMaxAgeDays: 30 });
    const reinvite = await composeManagedReinvite(record, location, seams);
    expect(reinvite.rotation.expires).toBe(
      new Date(NOW + 30 * 86_400_000).toISOString(),
    );
    // The token's own setup expiry is the short bounded lifetime, distinct from the
    // record's max-age stamp -- the setup lifetime rides the token, not the record.
    const token: InvitationToken = await decodeInvitation(reinvite.encoded);
    expect(token.expires).toBe(reinvite.tokenExpires);
    expect(token.expires).not.toBe(reinvite.rotation.expires);
  });
});

describe("the re-invite driver's relays", () => {
  test("reads this browser's own relay under the record's allowed relays, never this browser's stored ones", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "alcove-relay-restriction"
          ? JSON.stringify({ version: 1, allowedRelays: ["elsewhere.example"] })
          : null,
    });
    try {
      const record = inviterRecord({
        exchangeFile: composeManagedExchangeFile({
          connection: { channel: "webrtc", host: "signaling.example.org" },
          linkageTerms: getDefaultLinkageTerms("County Health Dept"),
          allowedRelays: ["relay.example.org"],
        }),
      });
      const asked: Array<ReadonlyArray<string> | undefined> = [];
      await reinviteManagedExchange(record.id, undefined, {
        ...driverDeps(record),
        ownRelay: (allowedRelays) => {
          asked.push(allowedRelays);
          return undefined;
        },
      });
      expect(asked).toEqual([["relay.example.org"]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the re-invite driver's lock", () => {
  test("reads the record under the lock and writes over the secret that read holds", async () => {
    const stored = inviterRecord();
    const steps: Array<string> = [];
    const persisted: Array<string> = [];
    await reinviteManagedExchange(stored.id, undefined, {
      ...driverDeps(stored),
      withLock: async (_id, step, options) => {
        steps.push(`lock ${JSON.stringify(options)}`);
        const result = await step();
        steps.push("release");
        return result;
      },
      readRecord: () => {
        steps.push("read");
        return Promise.resolve(stored);
      },
      persistRotation: (_id, expectedSecret) => {
        steps.push("persist");
        persisted.push(expectedSecret);
        return Promise.resolve(stored);
      },
    });
    expect(steps).toEqual([
      'lock {"ifAvailable":true}',
      "read",
      "persist",
      "release",
    ]);
    expect(persisted).toEqual([stored.sharedSecret]);
  });

  test("requests the lock queued when asked, as after a stop", async () => {
    const stored = inviterRecord();
    const asked: Array<unknown> = [];
    await reinviteManagedExchange(
      stored.id,
      {},
      {
        ...driverDeps(stored),
        withLock: (_id, step, options) => {
          asked.push(options);
          return step();
        },
      },
    );
    expect(asked).toEqual([{}]);
  });

  test("refuses a record that is gone, writing nothing", async () => {
    const stored = inviterRecord();
    const persist = vi.fn(() => Promise.resolve(stored));
    await expect(
      reinviteManagedExchange(stored.id, undefined, {
        ...driverDeps(stored),
        readRecord: () => Promise.resolve(undefined),
        persistRotation: persist,
      }),
    ).rejects.toThrow(/no managed exchange/);
    expect(persist).not.toHaveBeenCalled();
  });
});

/** The re-invite driver's dependencies over `stored`, with the lock taken at
 * once and every platform read stubbed. */
function driverDeps(
  stored: RunnableManagedExchangeRecord,
): Parameters<typeof reinviteManagedExchange>[2] & object {
  return {
    withLock: (_id, step) => step(),
    readRecord: () => Promise.resolve(stored),
    location: () => location,
    generateSecret: () => FRESH_SECRET,
    encode: encodeInvitation,
    persistRotation: () => Promise.resolve(stored),
    registerRelayKey: (_replaced, written) => Promise.resolve(written),
    now: () => NOW,
    ownRelay: () => undefined,
    defaultRelay: () => undefined,
  };
}
