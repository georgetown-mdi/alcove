import {
  RelayRegistrarSchema,
  deriveRelayKey,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import { relayRegistrarAuthorization } from "@alcove/core/testing";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  ManagedRelayRegistrarStaleError,
  NO_STANDING_CONDITION,
  applyManagedExchangeReinviteRotation,
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
  managedRelayReinviteKeyLostMessage,
  registerReinvitedManagedRelayKey,
  registerRotatedManagedRelayKey,
  relayRegistrarExchangeIdProblems,
  relayRegistrarUrlProblems,
  retryPendingManagedRelayRegistration,
  stopManagedRelayRegistration,
} from "@psi/managed/managedRelayRegistration";
import {
  benignRerunOutcome,
  rerunFailureLastRun,
  runManagedRerun,
} from "@psi/managed/managedRun";
import { ManagedExchangeLockUnavailableError } from "@psi/managed/managedExchangeLock";
import { persistManagedExchangeRotation } from "@psi/managed/managedExchangeStore";

import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedRelayRegistrationStore } from "@psi/managed/managedRelayRegistration";
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

function recordingStore(): ManagedRelayRegistrationStore & {
  cleared: Array<[string, string]>;
} {
  const cleared: Array<[string, string]> = [];
  return {
    cleared,
    clearPending: (id, secret) => {
      cleared.push([id, secret]);
      return Promise.resolve(record({ id, sharedSecret: secret }));
    },
  };
}

const ownRelay =
  (turn: Array<string>): (() => OwnRelayRead) =>
  () => ({ kind: "set", relay: { turn, stun: [] } });

/** An exchange accepted from an invitation that named the partner's relay. */
const partnerRelayedExchange = () =>
  composeManagedExchangeFile({
    connection: {
      channel: "webrtc",
      host: "signaling.example.org",
      relay: { turn: ["turns:partner.example.org:443"] },
    },
    linkageTerms: getDefaultLinkageTerms("County Health Dept"),
  });

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
  test("stores the pending registration beside the rotated secret on a record that names a registrar, whether or not the run registers", async () => {
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

  test("stores none on an exchange relaying through its partner's relay, which is never enrolled here", async () => {
    stubGrantingWebLocks();
    storedRecord.value = record({
      relayRegistrar: REGISTRAR,
      side: "acceptor",
      exchangeFile: partnerRelayedExchange(),
    });
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

  test("keeps a re-invite's reason beside the marker it sets, since no rotation recovers the key the registrar holds", () => {
    const stored = record({
      relayRegistrar: REGISTRAR,
      relayRegistrationPendingSince: PENDING_SINCE,
      relayRegistrationPendingReason: "reinvite",
    });
    const rotated = applyManagedExchangeRotation(stored, {
      sharedSecret: generateSharedSecret(),
      expires: null,
      relayRegistrationPendingSince: NOW.toISOString(),
    });
    expect(rotated.relayRegistrationPendingSince).toBe(NOW.toISOString());
    expect(rotated.relayRegistrationPendingReason).toBe("reinvite");
  });

  test("stores none on a record that names no registrar", async () => {
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

  test("a rotation sets the pending registration it is given", () => {
    const stored = record({
      relayRegistrar: REGISTRAR,
      relayRegistrationPendingSince: PENDING_SINCE,
    });
    expect(
      applyManagedExchangeRotation(stored, {
        sharedSecret: generateSharedSecret(),
        expires: null,
        relayRegistrationPendingSince: NOW.toISOString(),
      }).relayRegistrationPendingSince,
    ).toBe(NOW.toISOString());
  });

  test("a rotation that states none keeps the pending registration of a record naming a registrar", () => {
    const stored = record({
      relayRegistrar: REGISTRAR,
      relayRegistrationPendingSince: PENDING_SINCE,
    });
    const rotation = { sharedSecret: generateSharedSecret(), expires: null };
    expect(
      applyManagedExchangeRotation(stored, rotation)
        .relayRegistrationPendingSince,
    ).toBe(PENDING_SINCE);
    expect(
      applyManagedExchangeReinviteRotation(stored, rotation)
        .relayRegistrationPendingSince,
    ).toBe(PENDING_SINCE);
  });

  test("a rotation that states none keeps the pending registration on a record naming no registrar", () => {
    const stored = record({ relayRegistrationPendingSince: PENDING_SINCE });
    const rotation = { sharedSecret: generateSharedSecret(), expires: null };
    for (const rotated of [
      applyManagedExchangeRotation(stored, rotation),
      applyManagedExchangeReinviteRotation(stored, rotation),
    ]) {
      expect(rotated.relayRegistrar).toBeUndefined();
      expect(rotated.relayRegistrationPendingSince).toBe(PENDING_SINCE);
    }
  });

  test("a rotation that states none keeps the pending registration's reason", () => {
    const stored = record({
      relayRegistrar: REGISTRAR,
      relayRegistrationPendingSince: PENDING_SINCE,
      relayRegistrationPendingReason: "reinvite",
    });
    const rotation = { sharedSecret: generateSharedSecret(), expires: null };
    for (const rotated of [
      applyManagedExchangeRotation(stored, rotation),
      applyManagedExchangeReinviteRotation(stored, rotation),
    ]) {
      expect(rotated.relayRegistrationPendingSince).toBe(PENDING_SINCE);
      expect(rotated.relayRegistrationPendingReason).toBe("reinvite");
    }
  });

  test("a record holding a pending registration's reason without a registrar is refused", () => {
    expect(() =>
      record({
        relayRegistrationPendingSince: PENDING_SINCE,
        relayRegistrationPendingReason: "reinvite",
      }),
    ).toThrow(
      "relayRegistrationPendingReason is held only beside " +
        "relayRegistrationPendingSince and relayRegistrar",
    );
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

describe("the registration a re-invite makes", () => {
  function reinvited(): {
    replaced: RunnableManagedExchangeRecord;
    written: RunnableManagedExchangeRecord;
  } {
    const replaced = record({ relayRegistrar: REGISTRAR, tokenMaxAgeDays: 30 });
    const written = applyManagedExchangeReinviteRotation(replaced, {
      sharedSecret: generateSharedSecret(),
      expires: null,
      relayRegistrationPendingSince: NOW.toISOString(),
      relayRegistrationPendingReason: "reinvite",
    });
    return { replaced, written };
  }

  test("registers the fresh secret's key signed with the replaced secret's, and a confirmation drops the pending registration", async () => {
    const { replaced, written } = reinvited();
    const registrar = fakeRegistrar([REGISTERED]);
    const store = recordingStore();

    const result = await registerReinvitedManagedRelayKey(
      replaced,
      written,
      { fetch: registrar.fetch, now: () => NOW },
      store,
    );

    const [request] = registrar.sent;
    expect(request.url).toBe(REQUEST_URL);
    expect(request.method).toBe("PUT");
    expect(JSON.parse(request.body)).toEqual({
      key: await deriveRelayKey(written.sharedSecret),
      maxAgeDays: 30,
    });
    expect(request.authorization).toBe(
      await relayRegistrarAuthorization({
        relayKey: await deriveRelayKey(replaced.sharedSecret),
        method: "PUT",
        exchangeId: REGISTRAR.exchangeId,
        body: request.body,
        now: NOW,
      }),
    );
    expect(store.cleared).toEqual([
      ["record-under-test", written.sharedSecret],
    ]);
    expect(result.sharedSecret).toBe(written.sharedSecret);
  });

  test("an unanswered registration leaves the re-invite's reason, and the next run sends nothing and names owner-token re-enrollment", async () => {
    const { replaced, written } = reinvited();
    const registrar = fakeRegistrar([]);
    const store = recordingStore();

    const result = await registerReinvitedManagedRelayKey(
      replaced,
      written,
      { fetch: registrar.fetch, sleep: () => Promise.resolve() },
      store,
    );

    expect(registrar.sent).toHaveLength(3);
    expect(store.cleared).toEqual([]);
    expect(result).toBe(written);
    expect(result.relayRegistrationPendingReason).toBe("reinvite");

    const nextRun = fakeRegistrar([REGISTERED]);
    const error = await retryPendingManagedRelayRegistration(
      result,
      REGISTRAR,
      { fetch: nextRun.fetch },
      store,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(nextRun.sent).toEqual([]);
    expect(error).toBeInstanceOf(ManagedRelayRegistrationError);
    expect((error as ManagedRelayRegistrationError).outcome.kind).toBe(
      "key-lost",
    );
    const message = (error as Error).message;
    expect(message).toBe(managedRelayReinviteKeyLostMessage(REGISTRAR));
    expect(message).toContain("Nothing was sent to your partner");
    expect(message).toContain(MANAGED_RELAY_REENROLLMENT_STEP);
    expect(rerunFailureLastRun(error, NOW.getTime(), false, false)).toBe(
      undefined,
    );
    expect(benignRerunOutcome(error, false)).toBe("relay-registration");
  });

  test("a refused registration leaves the pending registration and its reason", async () => {
    const { replaced, written } = reinvited();
    const registrar = fakeRegistrar([[409, { error: "another key is held" }]]);
    const store = recordingStore();

    const result = await registerReinvitedManagedRelayKey(
      replaced,
      written,
      { fetch: registrar.fetch },
      store,
    );

    expect(registrar.sent).toHaveLength(1);
    expect(store.cleared).toEqual([]);
    expect(result.relayRegistrationPendingSince).toBe(NOW.toISOString());
    expect(result.relayRegistrationPendingReason).toBe("reinvite");
  });

  test("a re-invite's rotation keeps the reason it is given beside the marker", () => {
    expect(reinvited().written.relayRegistrationPendingReason).toBe("reinvite");
  });

  test("a reason without the marker is not a valid record", () => {
    expect(() =>
      record({
        relayRegistrar: REGISTRAR,
        relayRegistrationPendingReason: "reinvite",
      }),
    ).toThrow(/relayRegistrationPendingReason/);
  });
});

describe("a cancelled run's registration", () => {
  /** A registrar that never answers: each request waits until its signal
   * aborts and rejects with the signal's reason, as a real fetch does, at once
   * for a signal already aborted. `onRequest` runs once the request is under
   * way. */
  function neverAnswering(onRequest: () => void = () => {}): {
    fetch: typeof globalThis.fetch;
    requests: () => number;
  } {
    let requests = 0;
    const fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      requests++;
      const answer = new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(signal.reason);
        });
      });
      onRequest();
      return answer;
    }) as typeof globalThis.fetch;
    return { fetch, requests: () => requests };
  }

  test("the retry before connecting stops at the cancel and leaves the registration pending", async () => {
    // Cancelled from inside the request, not after a delay: a cancel landing
    // before the relay keys are derived correctly makes no request at all.
    const cancel = new AbortController();
    const cancelled = new Error("the operator cancelled the run");
    const registrar = neverAnswering(() => cancel.abort(cancelled));
    const store = recordingStore();

    const error = await retryPendingManagedRelayRegistration(
      record({
        relayRegistrar: REGISTRAR,
        relayRegistrationPendingSince: PENDING_SINCE,
      }),
      REGISTRAR,
      { fetch: registrar.fetch, timeoutMs: 600_000, signal: cancel.signal },
      store,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBe(cancelled);
    expect(registrar.requests()).toBe(1);
    expect(store.cleared).toEqual([]);
  });

  const rotation = () => ({
    id: "record-under-test",
    registrar: REGISTRAR,
    preRotationSecret: generateSharedSecret(),
    rotatedSecret: generateSharedSecret(),
    maxAgeDays: null,
  });

  test("the registration after a cancelled run makes one attempt to its timeout and leaves it pending", async () => {
    const registrar = neverAnswering();
    const store = recordingStore();
    const cancel = new AbortController();
    cancel.abort();

    const result = await registerRotatedManagedRelayKey(
      rotation(),
      {
        fetch: registrar.fetch,
        timeoutMs: 20,
        retryDelaysMs: [600_000, 600_000],
        cancel: cancel.signal,
      },
      store,
    );

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.message).toContain(
      "no answer within 20 ms",
    );
    expect(registrar.requests()).toBe(1);
    expect(store.cleared).toEqual([]);
  });

  test("a cancel during the registration after the run does not cut it: its answer confirms", async () => {
    const store = recordingStore();
    const cancel = new AbortController();
    const params = rotation();
    let requests = 0;
    const fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      requests++;
      cancel.abort();
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify(REGISTERED[1]), { status: 200 }),
            ),
          10,
        );
      });
    }) as typeof globalThis.fetch;

    const result = await registerRotatedManagedRelayKey(
      params,
      { fetch, cancel: cancel.signal },
      store,
    );

    expect(result).toEqual({ kind: "registered" });
    expect(requests).toBe(1);
    expect(store.cleared).toEqual([
      ["record-under-test", params.rotatedSecret],
    ]);
  });
});

describe("stopping registration", () => {
  test("drops the registrar under the run lock", async () => {
    const steps: Array<string> = [];
    await stopManagedRelayRegistration("record-under-test", {
      withLock: async <T>(_id: string, step: () => Promise<T>) => {
        steps.push("locked");
        const result = await step();
        steps.push("released");
        return result;
      },
      removeRegistrar: (id) => {
        steps.push(`removed ${id}`);
        return Promise.resolve(record());
      },
    });
    expect(steps).toEqual(["locked", "removed record-under-test", "released"]);
  });

  test("is refused, and writes nothing, while a run holds the exchange", async () => {
    const removeRegistrar = vi.fn(() => Promise.resolve(record()));
    await expect(
      stopManagedRelayRegistration("record-under-test", {
        withLock: () =>
          Promise.reject(
            new ManagedExchangeLockUnavailableError("record-under-test"),
          ),
        removeRegistrar,
      }),
    ).rejects.toBeInstanceOf(ManagedExchangeLockUnavailableError);
    expect(removeRegistrar).not.toHaveBeenCalled();
  });
});

describe("the enrollment form's address problems", () => {
  test.each([
    ["relay.example.org", "is not a url"],
    ["http://relay.example.org", "must be an https:// url"],
    ["https://relay.example.org/register", "no path, query, or fragment"],
  ])("%s is refused in the schema's own words", (url, rule) => {
    const parsed = RelayRegistrarSchema.safeParse({
      url,
      exchangeId: REGISTRAR.exchangeId,
    });
    expect(parsed.success).toBe(false);
    const problems = relayRegistrarUrlProblems(
      parsed.success ? [] : parsed.error.issues,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^The registrar address /);
    expect(problems[0]).toContain(rule);
    expect(problems[0]).not.toContain("relay_registrar");
  });
});

describe("the enrollment form's exchange-id problems", () => {
  test.each([
    [".", "must not be '.' or '..'"],
    ["..", "must not be '.' or '..'"],
    ["a".repeat(3) + "0123456789abcdef".repeat(4), "64 hex characters"],
    ["alcove-verify-x", "must not start with alcove-verify-"],
  ])("%s is refused in the schema's own words", (exchangeId, rule) => {
    const parsed = RelayRegistrarSchema.safeParse({
      url: REGISTRAR.url,
      exchangeId,
    });
    expect(parsed.success).toBe(false);
    const problems = relayRegistrarExchangeIdProblems(
      parsed.success ? [] : parsed.error.issues,
    );
    expect(problems.some((problem) => problem.includes(rule))).toBe(true);
    for (const problem of problems) {
      expect(problem).toMatch(/^The exchange id /);
      expect(problem).not.toContain("relay_registrar");
    }
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
