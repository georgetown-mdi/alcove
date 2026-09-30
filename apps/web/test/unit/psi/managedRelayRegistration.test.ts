import { afterEach, describe, expect, test, vi } from "vitest";
import {
  deriveRelayKey,
  generateSharedSecret,
  getDefaultLinkageTerms,
  relayRegistrarAuthorization,
} from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  ManagedRelayRegistrarStaleError,
  NO_STANDING_CONDITION,
  applyManagedExchangeRelayRegistrar,
  applyManagedExchangeRelayRegistrationConfirmed,
  applyManagedExchangeRotation,
  composeManagedExchangeFile,
  parseManagedExchangeRecord,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  MANAGED_RELAY_REENROLLMENT_STEP,
  ManagedRelayRegistrationError,
  enrollManagedRelayRegistrar,
  managedRelayRegistrarForRun,
  registerRotatedManagedRelayKey,
  retryPendingManagedRelayRegistration,
} from "@psi/managed/managedRelayRegistration";
import {
  benignRerunOutcome,
  rerunFailureLastRun,
  runManagedRerun,
} from "@psi/managed/managedRun";
import { persistManagedExchangeRotation } from "@psi/managed/managedExchangeStore";

import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";
import type { RelayRegistrar } from "@alcove/core";

// The browser's relay key registration: which runs register, the rotation
// write that stores the registration as pending, the registration signed with
// the pre-rotation key after a run, the retry before a run connects, and the
// enrollment whose relay-owner token reaches the one request and no store.

const storedRecord = vi.hoisted(
  (): { value: ManagedExchangeRecord | undefined } => ({ value: undefined }),
);
vi.mock("@psi/managed/managedExchangeStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getManagedExchange: vi.fn(() => Promise.resolve(storedRecord.value)),
  markManagedExchangeRotationInFlight: vi.fn(() => Promise.resolve()),
  persistManagedExchangeRotation: vi.fn(() => Promise.resolve()),
  recordManagedExchangeLastRun: vi.fn(() => Promise.resolve()),
}));
vi.mock("@psi/managed/managedLocalState", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getManagedLocalState: () => Promise.resolve(undefined),
}));

function stubGrantingWebLocks(): void {
  vi.stubGlobal("navigator", {
    locks: {
      request: (
        _name: string,
        _options: unknown,
        critical: (lock: object) => Promise<unknown>,
      ) => critical({}),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(persistManagedExchangeRotation).mockClear();
  storedRecord.value = undefined;
});

const REGISTRAR: RelayRegistrar = {
  url: "https://relay.example.org:8443",
  exchangeId: "riverbend-q3",
};
const REQUEST_URL = "https://relay.example.org:8443/exchanges/riverbend-q3";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const PENDING_SINCE = "2026-09-29T12:00:00.000Z";

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(
    parseManagedExchangeRecord({
      schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
      id: "record-under-test",
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
      standingCondition: NO_STANDING_CONDITION,
      ...overrides,
    }),
  );
}

interface SentRequest {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}

/** A fetch answering each request with the next status and body, recording
 * what was sent; a request past the last answer fails as unreachable. */
function fakeRegistrar(answers: Array<[number, unknown]>): {
  fetch: typeof globalThis.fetch;
  sent: Array<SentRequest>;
} {
  const sent: Array<SentRequest> = [];
  const queue = [...answers];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("Authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new TypeError("unreachable"));
    return Promise.resolve(
      new Response(JSON.stringify(next[1]), {
        status: next[0],
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const REGISTERED: [number, unknown] = [
  200,
  { maxAgeDays: null, lapsesAt: null },
];

function recordingStore(): {
  clearPending: (id: string, secret: string) => Promise<void>;
  cleared: Array<[string, string]>;
} {
  const cleared: Array<[string, string]> = [];
  return {
    cleared,
    clearPending: (id, secret) => {
      cleared.push([id, secret]);
      return Promise.resolve();
    },
  };
}

const ownRelay =
  (turn: Array<string>): (() => OwnRelayRead) =>
  () => ({ kind: "set", relay: { turn, stun: [] } });

describe("which runs register", () => {
  test("a run relaying through this browser's own relay registers at the enrolled registrar", () => {
    expect(
      managedRelayRegistrarForRun(
        record({ relayRegistrar: REGISTRAR }),
        ownRelay(["turns:relay.example.org:443?transport=tcp"]),
      ),
    ).toEqual(REGISTRAR);
  });

  test("a run relaying through the invitation's relay registers nothing", () => {
    const accepted = record({
      relayRegistrar: REGISTRAR,
      side: "acceptor",
      exchangeFile: composeManagedExchangeFile({
        connection: {
          channel: "webrtc",
          host: "signaling.example.org",
          relay: { turn: ["turns:partner.example.org:443"] },
        },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
    });
    expect(
      managedRelayRegistrarForRun(
        accepted,
        ownRelay(["turns:relay.example.org:443"]),
      ),
    ).toBeUndefined();
  });

  test("a browser with no relay of its own, or an exchange not enrolled, registers nothing", () => {
    expect(
      managedRelayRegistrarForRun(
        record({ relayRegistrar: REGISTRAR }),
        () => ({
          kind: "none",
        }),
      ),
    ).toBeUndefined();
    expect(
      managedRelayRegistrarForRun(
        record(),
        ownRelay(["turns:relay.example.org:443"]),
      ),
    ).toBeUndefined();
  });
});

describe("the rotation write", () => {
  test("stores the pending registration beside the rotated secret when a registration follows", async () => {
    stubGrantingWebLocks();
    storedRecord.value = record({ relayRegistrar: REGISTRAR });
    const rotatedSecret = generateSharedSecret();
    await runManagedRerun(
      storedRecord.value,
      {
        acquireInput: () => Promise.resolve("rows"),
        handshake: () =>
          Promise.resolve({ rotatedSecret, handshake: "carried" }),
        dataExchange: () => Promise.resolve("exchanged"),
        relayRegistrationFollows: () => true,
      },
      { now: () => NOW.getTime() },
    );
    expect(persistManagedExchangeRotation).toHaveBeenCalledWith(
      "record-under-test",
      {
        sharedSecret: rotatedSecret,
        expires: null,
        relayRegistrationPendingSince: NOW.toISOString(),
      },
    );
  });

  test("stores none when no registration follows", async () => {
    stubGrantingWebLocks();
    storedRecord.value = record();
    await runManagedRerun(storedRecord.value, {
      acquireInput: () => Promise.resolve("rows"),
      handshake: () =>
        Promise.resolve({
          rotatedSecret: generateSharedSecret(),
          handshake: "carried",
        }),
      dataExchange: () => Promise.resolve("exchanged"),
    });
    const rotation = vi.mocked(persistManagedExchangeRotation).mock
      .calls[0]?.[1];
    expect(rotation).not.toHaveProperty("relayRegistrationPendingSince");
  });

  test("a rotation sets the pending registration it is given and drops one it is not", () => {
    const stored = record({
      relayRegistrar: REGISTRAR,
      relayRegistrationPendingSince: PENDING_SINCE,
    });
    const rotated = generateSharedSecret();
    expect(
      applyManagedExchangeRotation(stored, {
        sharedSecret: rotated,
        expires: null,
        relayRegistrationPendingSince: NOW.toISOString(),
      }).relayRegistrationPendingSince,
    ).toBe(NOW.toISOString());
    expect(
      applyManagedExchangeRotation(stored, {
        sharedSecret: rotated,
        expires: null,
      }),
    ).not.toHaveProperty("relayRegistrationPendingSince");
  });
});

describe("the registration after a run rotates", () => {
  test("registers the rotated key, signed with the pre-rotation key", async () => {
    const preRotationSecret = generateSharedSecret();
    const rotatedSecret = generateSharedSecret();
    const registrar = fakeRegistrar([REGISTERED]);
    const store = recordingStore();

    const result = await registerRotatedManagedRelayKey(
      {
        id: "record-under-test",
        registrar: REGISTRAR,
        preRotationSecret,
        rotatedSecret,
        maxAgeDays: 30,
      },
      { fetch: registrar.fetch, now: () => NOW },
      store,
    );

    expect(result).toEqual({ kind: "registered" });
    expect(registrar.sent).toHaveLength(1);
    const [request] = registrar.sent;
    expect(request.url).toBe(REQUEST_URL);
    expect(request.method).toBe("PUT");
    expect(JSON.parse(request.body)).toEqual({
      key: await deriveRelayKey(rotatedSecret),
      maxAgeDays: 30,
    });
    expect(request.authorization).toBe(
      await relayRegistrarAuthorization({
        relayKey: await deriveRelayKey(preRotationSecret),
        method: "PUT",
        exchangeId: REGISTRAR.exchangeId,
        body: request.body,
        now: NOW,
      }),
    );
    expect(store.cleared).toEqual([["record-under-test", rotatedSecret]]);
  });

  test("a refusal leaves the pending registration and names the registrar and re-enrollment", async () => {
    const registrar = fakeRegistrar([[409, { error: "another key is held" }]]);
    const store = recordingStore();

    const result = await registerRotatedManagedRelayKey(
      {
        id: "record-under-test",
        registrar: REGISTRAR,
        preRotationSecret: generateSharedSecret(),
        rotatedSecret: generateSharedSecret(),
        maxAgeDays: null,
      },
      { fetch: registrar.fetch },
      store,
    );

    expect(result.kind).toBe("failed");
    const message = result.kind === "failed" ? result.message : "";
    expect(message).toContain(
      "the relay registrar at https://relay.example.org:8443",
    );
    expect(message).toContain("another key is held");
    expect(message).toContain(MANAGED_RELAY_REENROLLMENT_STEP);
    expect(store.cleared).toEqual([]);
  });

  test("an unanswered registration is retried, then left for the next run", async () => {
    const registrar = fakeRegistrar([
      [503, {}],
      [503, {}],
      [503, {}],
    ]);
    const store = recordingStore();

    const result = await registerRotatedManagedRelayKey(
      {
        id: "record-under-test",
        registrar: REGISTRAR,
        preRotationSecret: generateSharedSecret(),
        rotatedSecret: generateSharedSecret(),
        maxAgeDays: null,
      },
      { fetch: registrar.fetch, sleep: () => Promise.resolve() },
      store,
    );

    expect(registrar.sent).toHaveLength(3);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.message : "").toContain(
      "The next run retries the registration before it connects",
    );
    expect(store.cleared).toEqual([]);
  });
});

describe("the retry before a run connects", () => {
  test("a record with no pending registration sends nothing", async () => {
    const registrar = fakeRegistrar([]);
    await retryPendingManagedRelayRegistration(
      record({ relayRegistrar: REGISTRAR }),
      REGISTRAR,
      { fetch: registrar.fetch },
      recordingStore(),
    );
    expect(registrar.sent).toEqual([]);
  });

  test("a pending registration is renewed under the current key and dropped once confirmed", async () => {
    const current = record({
      relayRegistrar: REGISTRAR,
      relayRegistrationPendingSince: PENDING_SINCE,
    });
    const registrar = fakeRegistrar([REGISTERED]);
    const store = recordingStore();

    await retryPendingManagedRelayRegistration(
      current,
      REGISTRAR,
      { fetch: registrar.fetch, now: () => NOW },
      store,
    );

    const [request] = registrar.sent;
    const key = await deriveRelayKey(current.sharedSecret);
    expect(JSON.parse(request.body)).toEqual({ key, maxAgeDays: null });
    expect(request.authorization).toBe(
      await relayRegistrarAuthorization({
        relayKey: key,
        method: "PUT",
        exchangeId: REGISTRAR.exchangeId,
        body: request.body,
        now: NOW,
      }),
    );
    expect(store.cleared).toEqual([
      ["record-under-test", current.sharedSecret],
    ]);
  });

  test("a refused retry stops the run with the registrar and the re-enrollment step", async () => {
    const registrar = fakeRegistrar([[401, { error: "proof refused" }]]);
    const store = recordingStore();
    const error = await retryPendingManagedRelayRegistration(
      record({
        relayRegistrar: REGISTRAR,
        relayRegistrationPendingSince: PENDING_SINCE,
      }),
      REGISTRAR,
      { fetch: registrar.fetch },
      store,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ManagedRelayRegistrationError);
    const message = (error as Error).message;
    expect(message).toContain("relay.example.org:8443");
    expect(message).toContain("Nothing was sent to your partner");
    expect(message).toContain(MANAGED_RELAY_REENROLLMENT_STEP);
    expect(store.cleared).toEqual([]);
    // Stopped before connecting: no bookkeeping of a run, and its own state.
    expect(rerunFailureLastRun(error, NOW.getTime(), false, false)).toBe(
      undefined,
    );
    expect(benignRerunOutcome(error, false)).toBe("relay-registration");
  });
});

describe("enrollment", () => {
  const OWNER_TOKEN = "owner-token-for-this-test-only";

  function enrollmentDeps(
    current: RunnableManagedExchangeRecord,
    answers: Array<[number, unknown]>,
  ) {
    const registrar = fakeRegistrar(answers);
    const persisted: Array<Array<unknown>> = [];
    let locked = 0;
    return {
      registrar,
      persisted,
      lockCount: () => locked,
      deps: {
        withLock: <T>(_id: string, step: () => Promise<T>) => {
          locked++;
          return step();
        },
        getRecord: () => Promise.resolve(current),
        persistRegistrar: (
          id: string,
          stored: RelayRegistrar,
          confirmedSecret: string,
        ) => {
          persisted.push([id, stored, confirmedSecret]);
          return Promise.resolve(
            applyManagedExchangeRelayRegistrar(
              current,
              stored,
              confirmedSecret,
            ),
          );
        },
        env: { fetch: registrar.fetch },
      },
    };
  }

  test("the relay-owner token reaches the one request and no store", async () => {
    const current = record({ relayRegistrationPendingSince: PENDING_SINCE });
    const run = enrollmentDeps(current, [
      [201, { maxAgeDays: null, lapsesAt: null }],
    ]);

    const result = await enrollManagedRelayRegistrar(
      { id: current.id, registrar: REGISTRAR, ownerToken: OWNER_TOKEN },
      run.deps,
    );

    expect(run.lockCount()).toBe(1);
    expect(run.registrar.sent).toHaveLength(1);
    expect(run.registrar.sent[0]?.method).toBe("POST");
    expect(run.registrar.sent[0]?.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(run.registrar.sent[0]?.body).not.toContain(OWNER_TOKEN);
    expect(run.persisted).toEqual([
      [current.id, REGISTRAR, current.sharedSecret],
    ]);
    expect(result.kind).toBe("enrolled");
    const enrolled = result.kind === "enrolled" ? result.record : undefined;
    expect(enrolled?.relayRegistrar).toEqual(REGISTRAR);
    expect(enrolled).not.toHaveProperty("relayRegistrationPendingSince");
    expect(JSON.stringify(run.persisted)).not.toContain(OWNER_TOKEN);
    expect(JSON.stringify(enrolled)).not.toContain(OWNER_TOKEN);
  });

  test("replacing the registered key sends the token on a PUT", async () => {
    const current = record();
    const run = enrollmentDeps(current, [REGISTERED]);
    await enrollManagedRelayRegistrar(
      {
        id: current.id,
        registrar: REGISTRAR,
        ownerToken: OWNER_TOKEN,
        replace: true,
      },
      run.deps,
    );
    expect(run.registrar.sent[0]?.method).toBe("PUT");
    expect(run.registrar.sent[0]?.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
  });

  test("a refused enrollment stores nothing and never repeats the token", async () => {
    const current = record();
    const run = enrollmentDeps(current, [
      [401, { error: `bad token Bearer ${OWNER_TOKEN}` }],
    ]);
    const result = await enrollManagedRelayRegistrar(
      { id: current.id, registrar: REGISTRAR, ownerToken: OWNER_TOKEN },
      run.deps,
    );
    expect(result.kind).toBe("failed");
    expect(run.persisted).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(OWNER_TOKEN);
  });

  test("without a token, a registrar already holding the current key is confirmed by a signed renewal", async () => {
    const current = record();
    const run = enrollmentDeps(current, [REGISTERED]);
    const result = await enrollManagedRelayRegistrar(
      { id: current.id, registrar: REGISTRAR },
      run.deps,
    );
    expect(result.kind).toBe("enrolled");
    expect(run.registrar.sent[0]?.method).toBe("PUT");
    expect(run.registrar.sent[0]?.authorization).toMatch(
      /^Alcove-Relay-Proof /,
    );
  });
});

describe("the record's registrar fields", () => {
  test("a confirmation laid over a secret that moved is refused", () => {
    expect(() =>
      applyManagedExchangeRelayRegistrar(
        record(),
        REGISTRAR,
        generateSharedSecret(),
      ),
    ).toThrow(ManagedRelayRegistrarStaleError);
  });

  test("stopping registration drops the registrar and the pending registration", () => {
    const stopped = applyManagedExchangeRelayRegistrar(
      record({
        relayRegistrar: REGISTRAR,
        relayRegistrationPendingSince: PENDING_SINCE,
      }),
      undefined,
    );
    expect(stopped).not.toHaveProperty("relayRegistrar");
    expect(stopped).not.toHaveProperty("relayRegistrationPendingSince");
  });

  test("a confirmation of another secret keeps the pending registration", () => {
    const stored = record({
      relayRegistrar: REGISTRAR,
      relayRegistrationPendingSince: PENDING_SINCE,
    });
    expect(
      applyManagedExchangeRelayRegistrationConfirmed(
        stored,
        generateSharedSecret(),
      ),
    ).toBe(stored);
    expect(
      applyManagedExchangeRelayRegistrationConfirmed(
        stored,
        stored.sharedSecret,
      ),
    ).not.toHaveProperty("relayRegistrationPendingSince");
  });

  test("a configuration-only record holds no registrar", () => {
    const { sharedSecret: _secret, ...configurationOnly } = record();
    expect(() => parseManagedExchangeRecord(configurationOnly)).not.toThrow();
    expect(() =>
      parseManagedExchangeRecord({
        ...configurationOnly,
        relayRegistrar: REGISTRAR,
      }),
    ).toThrow(/relayRegistrar/);
    expect(() =>
      parseManagedExchangeRecord({
        ...configurationOnly,
        relayRegistrationPendingSince: PENDING_SINCE,
      }),
    ).toThrow(/relayRegistrationPendingSince/);
  });
});
