/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import {
  ConnectionError,
  deriveAcceptedLinkageTerms,
  deriveRelayKey,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  relayRegistrarAuthorization,
  validateCompatibility,
} from "@alcove/core/testing";

import {
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  clearManagedExchanges,
  clearManagedRunTermsProposal,
  createManagedExchange,
  getManagedExchange,
  keepManagedRunTermsProposal,
  listReadableManagedExchanges,
  persistManagedExchangeReinvite,
  persistManagedExchangeRelayRegistrar,
  persistManagedExchangeScheduleAdvance,
  persistManagedExchangeTermsChange,
  persistManagedRunPayloadReceiveFill,
  persistManagedRunTermsChange,
} from "@psi/managed/managedExchangeStore";
import {
  enrollManagedRelayRegistrar,
  registerReinvitedManagedRelayKey,
  registerRotatedManagedRelayKey,
  retryPendingManagedRelayRegistration,
  rotatedManagedRelayKeyRegistration,
} from "@psi/managed/managedRelayRegistration";
import {
  getManagedLocalState,
  listReadableManagedLocalState,
} from "@psi/managed/managedLocalState";
import { managedTermsProposalFor } from "@psi/managed/managedTermsProposal";
import { reinviteManagedExchange } from "@psi/managed/managedReinviteDriver";
import { runManagedExchange } from "@psi/managed/managedExchangeRun";
import { runManagedRerun } from "@psi/managed/managedRun";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import type { LinkageTerms, RelayRegistrar } from "@alcove/core";
import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedRunRecordExpectation } from "@psi/managed/managedExchangeStore";
import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";

// A run holds the exchange's lock, and relay enrollment, terms writes, and
// re-invites take none. Each write the run makes after it took the lock reads
// the state it covers inside its own transaction, so whatever one of those
// controls wrote during the run is what the record holds after it.

const NOW = new Date("2026-10-25T12:00:00.000Z");

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

const REGISTRAR_ONE: RelayRegistrar = {
  url: "https://relay-one.example.org:8443",
  exchangeId: "riverbend-q3",
};
const REGISTRAR_TWO: RelayRegistrar = {
  url: "https://relay-two.example.org:8443",
  exchangeId: "riverbend-q3",
};

const OWN_RELAY: () => OwnRelayRead = () => ({
  kind: "set",
  relay: { turn: ["turns:own.example.org:443"], stun: [] },
});

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 3000,
        path: "/api/",
      },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === "string") return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

function answer(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Registrars holding one relay key each, by origin, answering as
 * docs/spec/PROTOCOL.md's registrar does. The relay-owner token enrolls a key
 * (a `POST` only where none is held); a proof-made `PUT` is taken when it
 * names the key held, a renewal, or is signed with that key, and is refused
 * 409 otherwise. `beforeNext` runs once, before the next request is answered.
 */
function registrars() {
  const held = new Map<string, string>();
  let beforeNext: (() => Promise<unknown>) | undefined;
  const fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const pending = beforeNext;
    beforeNext = undefined;
    await pending?.();
    const url = requestUrl(input);
    const body = typeof init?.body === "string" ? init.body : "";
    const { key } = JSON.parse(body) as { key: string };
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    const current = held.get(url.origin);
    const accepted = authorization.startsWith("Bearer ")
      ? init?.method === "PUT" || current === undefined
      : current !== undefined &&
        (key === current ||
          authorization ===
            (await relayRegistrarAuthorization({
              relayKey: current,
              method: "PUT",
              exchangeId: decodeURIComponent(
                url.pathname.slice("/exchanges/".length),
              ),
              body,
              now: NOW,
            })));
    if (!accepted)
      return answer(409, {
        error: "the request is not signed with the key held",
      });
    held.set(url.origin, key);
    return answer(200, { maxAgeDays: null, lapsesAt: null });
  }) as typeof globalThis.fetch;
  const env = { fetch, now: () => NOW, sleep: () => Promise.resolve() };
  return {
    env,
    beforeNextRequest: (step: () => Promise<unknown>) => {
      beforeNext = step;
    },
    holds: (registrar: RelayRegistrar) =>
      held.get(new URL(registrar.url).origin),
    enroll: (id: string, registrar: RelayRegistrar, ownerToken?: string) =>
      enrollManagedRelayRegistrar(
        { id, registrar, ...(ownerToken !== undefined && { ownerToken }) },
        {
          getRecord: getManagedExchange,
          persistRegistrar: persistManagedExchangeRelayRegistrar,
          env,
        },
      ),
  };
}

/**
 * Run the exchange as the run driver does: `during` runs once the run holds
 * the lock and before it rotates, and once the rotation is stored the rotated
 * key is registered from the record the rotation write stored.
 */
async function runAndRegister(
  record: RunnableManagedExchangeRecord,
  fake: ReturnType<typeof registrars>,
  during: () => Promise<unknown>,
) {
  const rotatedSecret = generateSharedSecret();
  let rotated: RunnableManagedExchangeRecord | undefined;
  await runManagedExchange({
    record,
    runStartedAtMs: NOW.getTime(),
    acquireInput: () => Promise.resolve(undefined),
    handshake: async (_input, markRotationInFlight) => {
      await during();
      await markRotationInFlight();
      return { rotatedSecret, handshake: "carried" };
    },
    dataExchange: (_handshake, stored) => {
      rotated = stored;
      return Promise.resolve("exchanged");
    },
  });
  if (rotated === undefined) throw new Error("the run did not rotate");
  const registration = rotatedManagedRelayKeyRegistration(
    rotated,
    record.sharedSecret,
    OWN_RELAY,
  );
  if (registration === undefined)
    throw new Error("the run owes no registration");
  const outcome = await registerRotatedManagedRelayKey(registration, fake.env);
  return { rotatedSecret, registration, outcome };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("a relay enrollment while a run holds the lock", () => {
  test("enrolled before the rotation, the registrar gets the rotated key and the next run's renewal is accepted", async () => {
    const fake = registrars();
    const record = runnableManagedExchangeOrRefuse(
      await createManagedExchange(newExchange()),
    );

    const { rotatedSecret, registration, outcome } = await runAndRegister(
      record,
      fake,
      () => fake.enroll(record.id, REGISTRAR_ONE, "owner-token"),
    );

    expect(registration.registrar).toEqual(REGISTRAR_ONE);
    expect(outcome).toEqual({ kind: "registered" });
    expect(fake.holds(REGISTRAR_ONE)).toBe(await deriveRelayKey(rotatedSecret));
    const stored = await getManagedExchange(record.id);
    expect(stored?.sharedSecret).toBe(rotatedSecret);
    expect(stored).not.toHaveProperty("relayRegistrationPendingSince");

    const renewal = await fake.enroll(record.id, REGISTRAR_ONE);
    expect(renewal.kind).toBe("enrolled");
  });

  test("re-enrolled at another registrar before the rotation, that registrar gets the rotated key", async () => {
    const fake = registrars();
    const created = await createManagedExchange(newExchange());
    await fake.enroll(created.id, REGISTRAR_ONE, "owner-token");
    const record = runnableManagedExchangeOrRefuse(
      (await getManagedExchange(created.id))!,
    );
    expect(record.relayRegistrar).toEqual(REGISTRAR_ONE);

    const { rotatedSecret, outcome } = await runAndRegister(record, fake, () =>
      fake.enroll(record.id, REGISTRAR_TWO, "owner-token"),
    );

    expect(outcome).toEqual({ kind: "registered" });
    expect(fake.holds(REGISTRAR_TWO)).toBe(await deriveRelayKey(rotatedSecret));
    const stored = await getManagedExchange(record.id);
    expect(stored?.relayRegistrar).toEqual(REGISTRAR_TWO);
    expect(stored).not.toHaveProperty("relayRegistrationPendingSince");
  });

  test("re-enrolled at another registrar after the rotation, that registrar holds the rotated key", async () => {
    const fake = registrars();
    const created = await createManagedExchange(newExchange());
    await fake.enroll(created.id, REGISTRAR_ONE, "owner-token");
    const record = runnableManagedExchangeOrRefuse(
      (await getManagedExchange(created.id))!,
    );
    const rotatedSecret = generateSharedSecret();
    let rotated: RunnableManagedExchangeRecord | undefined;

    await runManagedExchange({
      record,
      runStartedAtMs: NOW.getTime(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: async (_input, markRotationInFlight) => {
        await markRotationInFlight();
        return { rotatedSecret, handshake: "carried" };
      },
      dataExchange: async (_handshake, stored) => {
        rotated = stored;
        await fake.enroll(record.id, REGISTRAR_TWO, "owner-token");
        return "exchanged";
      },
    });
    await registerRotatedManagedRelayKey(
      rotatedManagedRelayKeyRegistration(
        rotated!,
        record.sharedSecret,
        OWN_RELAY,
      )!,
      fake.env,
    );

    expect(fake.holds(REGISTRAR_TWO)).toBe(await deriveRelayKey(rotatedSecret));
    const stored = await getManagedExchange(record.id);
    expect(stored?.relayRegistrar).toEqual(REGISTRAR_TWO);
    expect(stored).not.toHaveProperty("relayRegistrationPendingSince");
  });

  test("a registration confirmed at the registrar the run took the lock with keeps the other registrar's pending registration", async () => {
    const fake = registrars();
    const created = await createManagedExchange(newExchange());
    await fake.enroll(created.id, REGISTRAR_ONE, "owner-token");
    const record = runnableManagedExchangeOrRefuse(
      (await getManagedExchange(created.id))!,
    );
    const rotatedSecret = generateSharedSecret();

    await runManagedExchange({
      record,
      runStartedAtMs: NOW.getTime(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: async (_input, markRotationInFlight) => {
        await fake.enroll(record.id, REGISTRAR_TWO, "owner-token");
        await markRotationInFlight();
        return { rotatedSecret, handshake: "carried" };
      },
      dataExchange: () => Promise.resolve("exchanged"),
    });
    const outcome = await registerRotatedManagedRelayKey(
      {
        id: record.id,
        registrar: REGISTRAR_ONE,
        preRotationSecret: record.sharedSecret,
        rotatedSecret,
      },
      fake.env,
    );

    expect(outcome).toEqual({ kind: "registered" });
    expect(fake.holds(REGISTRAR_TWO)).toBe(
      await deriveRelayKey(record.sharedSecret),
    );
    const stored = await getManagedExchange(record.id);
    expect(stored?.relayRegistrar).toEqual(REGISTRAR_TWO);
    expect(stored?.relayRegistrationPendingSince).toBeDefined();
  });
});

describe("a re-invite of an enrolled exchange while a run is in flight", () => {
  function reinviteEnrolled(
    fake: ReturnType<typeof registrars>,
    current: RunnableManagedExchangeRecord,
  ) {
    return persistManagedExchangeReinvite(
      current.id,
      current.sharedSecret,
      {
        sharedSecret: generateSharedSecret(),
        expires: null,
        signalingServer: { host: "signaling.example.org" },
      },
      (replaced, written) =>
        registerReinvitedManagedRelayKey(replaced, written, fake.env),
    );
  }

  async function enrolledRecord(fake: ReturnType<typeof registrars>) {
    const created = await createManagedExchange(newExchange());
    await fake.enroll(created.id, REGISTRAR_ONE, "owner-token");
    return runnableManagedExchangeOrRefuse(
      (await getManagedExchange(created.id))!,
    );
  }

  /** Run the exchange, calling `duringDataExchange` with the record the
   * rotation write stored, then register the rotated key as the run driver
   * does. */
  async function runThenRegister(
    fake: ReturnType<typeof registrars>,
    record: RunnableManagedExchangeRecord,
    duringDataExchange: (
      rotated: RunnableManagedExchangeRecord,
    ) => Promise<unknown>,
  ) {
    let rotated: RunnableManagedExchangeRecord | undefined;
    await runManagedExchange({
      record,
      runStartedAtMs: NOW.getTime(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: async (_input, markRotationInFlight) => {
        await markRotationInFlight();
        return { rotatedSecret: generateSharedSecret(), handshake: "carried" };
      },
      dataExchange: async (_handshake, stored) => {
        rotated = stored;
        await duringDataExchange(stored);
        return "exchanged";
      },
    });
    return registerRotatedManagedRelayKey(
      rotatedManagedRelayKeyRegistration(
        rotated!,
        record.sharedSecret,
        OWN_RELAY,
      )!,
      fake.env,
    );
  }

  /** The registrar holds the key of the secret the record holds, nothing is
   * pending, and the next run's retry and a token-free renewal both go
   * through. */
  async function expectRegistrarHoldsCurrentKey(
    fake: ReturnType<typeof registrars>,
    id: string,
  ) {
    const stored = await getManagedExchange(id);
    expect(fake.holds(REGISTRAR_ONE)).toBe(
      await deriveRelayKey(stored!.sharedSecret!),
    );
    expect(stored).not.toHaveProperty("relayRegistrationPendingSince");
    await retryPendingManagedRelayRegistration(id, fake.env);
    expect((await fake.enroll(id, REGISTRAR_ONE)).kind).toBe("enrolled");
  }

  test("landing during the data exchange, the run registers the re-invite's key the registrar refused the re-invite", async () => {
    const fake = registrars();
    const record = await enrolledRecord(fake);
    let reinvited: ManagedExchangeRecord | undefined;

    const outcome = await runThenRegister(fake, record, async (rotated) => {
      reinvited = await reinviteEnrolled(fake, rotated);
    });

    expect(reinvited?.relayRegistrationPendingReason).toBe("reinvite");
    expect(outcome).toEqual({ kind: "registered" });
    expect((await getManagedExchange(record.id))?.sharedSecret).toBe(
      reinvited?.sharedSecret,
    );
    await expectRegistrarHoldsCurrentKey(fake, record.id);
  });

  test("landing while the run's registration is under way, the run then registers the re-invite's key", async () => {
    const fake = registrars();
    const record = await enrolledRecord(fake);
    let reinvited: ManagedExchangeRecord | undefined;

    const outcome = await runThenRegister(fake, record, (rotated) => {
      fake.beforeNextRequest(async () => {
        reinvited = await reinviteEnrolled(fake, rotated);
      });
      return Promise.resolve();
    });

    expect(reinvited?.relayRegistrationPendingReason).toBe("reinvite");
    expect(outcome).toEqual({ kind: "registered" });
    expect((await getManagedExchange(record.id))?.sharedSecret).toBe(
      reinvited?.sharedSecret,
    );
    await expectRegistrarHoldsCurrentKey(fake, record.id);
  });
});

describe("an operator's terms write while a run holds the lock", () => {
  // Agency A invited Agency B and sends `notes`; B's stored terms do not yet
  // state the list it receives, which B's run fills from A's declared terms.
  const aTerms: LinkageTerms = {
    ...getDefaultLinkageTerms("Agency A", inferMetadata(LINKAGE_COLUMNS, [])),
    payload: { send: [{ name: "notes" }] },
  };
  const partnerTerms: LinkageTerms = {
    ...aTerms,
    payload: { send: [{ name: "notes" }, { name: "county" }] },
  };

  async function acceptorRecord(): Promise<RunnableManagedExchangeRecord> {
    const { payload: _payload, ...terms } = deriveAcceptedLinkageTerms(
      aTerms,
      "Agency B",
    );
    return runnableManagedExchangeOrRefuse(
      await createManagedExchange(
        newExchange({
          side: "acceptor",
          exchangeFile: composeManagedExchangeFile({
            connection: { channel: "webrtc", host: "signaling.example.org" },
            linkageTerms: terms,
          }),
        }),
      ),
    );
  }

  /** Run the exchange with `dataExchange` given what the run driver compares
   * its terms writes with: the rotated secret and the terms read at the lock. */
  function runWithExpectation(
    record: RunnableManagedExchangeRecord,
    dataExchange: (expected: ManagedRunRecordExpectation) => Promise<void>,
  ) {
    let lockedTerms: LinkageTerms | undefined;
    return runManagedExchange({
      record,
      runStartedAtMs: NOW.getTime(),
      acquireInput: () => Promise.resolve(undefined),
      handshake: async (_input, markRotationInFlight, current) => {
        lockedTerms = current.exchangeFile.linkageTerms;
        await markRotationInFlight();
        return { rotatedSecret: generateSharedSecret(), handshake: "carried" };
      },
      dataExchange: async (_handshake, rotated) => {
        await dataExchange({
          id: rotated.id,
          sharedSecret: rotated.sharedSecret,
          linkageTerms: lockedTerms!,
        });
        return "exchanged";
      },
    });
  }

  test("an apply landing before the receive fill is kept, and the run completes", async () => {
    const record = await acceptorRecord();
    let applied: ManagedExchangeRecord | undefined;
    let filled: ManagedExchangeRecord | undefined;

    const result = await runWithExpectation(record, async (expected) => {
      applied = await persistManagedExchangeTermsChange(record.id, {
        scope: "apply",
        partnerTerms,
      });
      filled = await persistManagedRunPayloadReceiveFill(expected, ["notes"]);
    });

    expect(result.lastRun.outcome).toBe("succeeded");
    expect(filled).toBeUndefined();
    const stored = await getManagedExchange(record.id);
    expect(stored?.exchangeFile.linkageTerms).toEqual(
      applied?.exchangeFile.linkageTerms,
    );
  });

  test("an apply landing after the receive fill is kept over the run's later terms write, and the run completes", async () => {
    const record = await acceptorRecord();
    let applied: ManagedExchangeRecord | undefined;
    let takenOn: ManagedExchangeRecord | undefined;

    const result = await runWithExpectation(record, async (expected) => {
      const filled = await persistManagedRunPayloadReceiveFill(expected, [
        "notes",
      ]);
      expect(filled?.exchangeFile.linkageTerms.payload?.receive).toEqual([
        { name: "notes" },
      ]);
      const afterFill = {
        ...expected,
        linkageTerms: filled!.exchangeFile.linkageTerms,
      };
      applied = await persistManagedExchangeTermsChange(record.id, {
        scope: "apply",
        partnerTerms,
      });
      takenOn = await persistManagedRunTermsChange(afterFill, {
        scope: "run",
        adoptedTerms: deriveAcceptedLinkageTerms(aTerms, "Agency B"),
        partnerTerms: aTerms,
      });
    });

    expect(result.lastRun.outcome).toBe("succeeded");
    expect(takenOn).toBeUndefined();
    const stored = await getManagedExchange(record.id);
    expect(stored?.exchangeFile.linkageTerms).toEqual(
      applied?.exchangeFile.linkageTerms,
    );
  });

  test("a terms change the run refused is kept over the secret it stored, and not over the one a re-invite wrote", async () => {
    const record = await acceptorRecord();
    const proposal = managedTermsProposalFor(
      {
        delta: validateCompatibility(
          record.exchangeFile.linkageTerms,
          partnerTerms,
        ).delta,
        partnerTerms,
      },
      NOW,
    );
    const kept: Array<boolean> = [];

    await runWithExpectation(record, async (expected) => {
      kept.push(await keepManagedRunTermsProposal(expected, proposal));
      await persistManagedExchangeReinvite(record.id, expected.sharedSecret, {
        sharedSecret: generateSharedSecret(),
        expires: null,
        signalingServer: { host: "signaling.example.org" },
      });
      kept.push(await keepManagedRunTermsProposal(expected, proposal));
      await clearManagedRunTermsProposal(expected);
    });

    expect(kept).toEqual([true, false]);
    expect(await getManagedLocalState(record.id)).toBeUndefined();
  });
});

describe("a re-invite during a scheduled attempt", () => {
  test("a handshake that then fails closed leaves the re-invite's standing condition, and the window advances", async () => {
    const openedAt = new Date().toISOString();
    const root = await navigator.storage.getDirectory();
    const created = await createManagedExchange(
      newExchange({
        workingDirectoryHandle: await root.getDirectoryHandle(
          "unlocked-writes-folder",
          { create: true },
        ),
        schedule: {
          anchor: openedAt,
          intervalDays: 7,
          windowSeconds: 60 * 60,
          nextWindow: openedAt,
          consecutiveMisses: 0,
        },
      }),
    );
    let reinvited: ManagedExchangeRecord | undefined;

    const [entry] = await tickManagedSchedules({
      now: Date.now,
      listRecords: listReadableManagedExchanges,
      readRecord: getManagedExchange,
      listLocalState: listReadableManagedLocalState,
      persistAdvance: persistManagedExchangeScheduleAdvance,
      delay: () => Promise.resolve(),
      stopped: () => false,
      runAttempt: (scheduled) =>
        runManagedRerun(
          scheduled.record,
          {
            acquireInput: () => Promise.resolve(undefined),
            handshake: async (_input, _markRotationInFlight, current) => {
              reinvited = await persistManagedExchangeReinvite(
                current.id,
                current.sharedSecret,
                {
                  sharedSecret: generateSharedSecret(),
                  expires: null,
                  signalingServer: { host: "signaling.example.org" },
                },
              );
              throw new ConnectionError(
                "could not verify the partner",
                "security",
              );
            },
            dataExchange: () => Promise.resolve("exchanged"),
          },
          {
            lock: { ifAvailable: true },
            onDataExchangeStart: scheduled.onDataExchangeStart,
          },
        ),
    });

    expect(entry.disposition).toBe("failed");
    const stored = await getManagedExchange(created.id);
    expect(stored?.sharedSecret).toBe(reinvited?.sharedSecret);
    expect(stored?.standingCondition).toEqual(NO_STANDING_CONDITION);
    expect(stored).not.toHaveProperty("lastRun");
    expect(Date.parse(stored!.schedule!.nextWindow)).toBeGreaterThan(
      Date.parse(openedAt),
    );
  });
});

describe("a re-invite while a run exchanges data", () => {
  test.each([
    ["a run that completes", () => Promise.resolve("exchanged")],
    [
      "a run that fails",
      () => Promise.reject(new Error("the partner closed the connection")),
    ],
  ])(
    "%s leaves the record the re-invite wrote",
    async (_name, finish: () => Promise<string>) => {
      const record = runnableManagedExchangeOrRefuse(
        await createManagedExchange(newExchange()),
      );
      let reinvited: ManagedExchangeRecord | undefined;

      await runManagedRerun(
        record,
        {
          acquireInput: () => Promise.resolve(undefined),
          handshake: async (_input, markRotationInFlight) => {
            await markRotationInFlight();
            return {
              rotatedSecret: generateSharedSecret(),
              handshake: "carried",
            };
          },
          dataExchange: async (_handshake, rotated) => {
            await reinviteManagedExchange(rotated);
            reinvited = await getManagedExchange(record.id);
            return finish();
          },
        },
        { now: () => NOW.getTime() },
      ).catch(() => undefined);

      expect(reinvited).toBeDefined();
      const stored = await getManagedExchange(record.id);
      expect(stored).toEqual(reinvited);
      expect(stored).not.toHaveProperty("lastRun");
      expect(stored?.standingCondition).toEqual(reinvited?.standingCondition);
    },
  );
});
