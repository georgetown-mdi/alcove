import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_DB_NAME,
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_RESULTS_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  ManagedExchangeSecretChangedError,
  ManagedReinviteWithheldError,
  clearManagedExchangeRelayRegistrationPending,
  clearManagedExchangeRotationInFlight,
  clearManagedExchangeStandingCondition,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  dropManagedExchangePreviousSecret,
  getManagedExchange,
  listManagedExchanges,
  listManagedExchangesDiagnostic,
  listReadableManagedExchanges,
  markManagedBackupIfCurrent,
  markManagedExchangeRotationInFlight,
  persistManagedExchangeReinvite,
  persistManagedExchangeRelayRegistrar,
  persistManagedExchangeRotation,
  persistManagedExchangeScheduleAdvance,
  persistManagedExchangeSentColumns,
  persistManagedExchangeTermsChange,
  persistManagedExchangeWorkingDirectory,
  persistManagedRunPayloadReceiveFill,
  persistManagedRunTermsChange,
  putManagedExchange,
  readRecordAndMarkBackedUp,
  reconcileManagedBackupImport,
  reconcileManagedCommandLinePair,
  recordManagedExchangeCompromiseResponse,
  recordManagedExchangeLastRun,
  replaceManagedExchangeFromImport,
  updateManagedExchangeLocalFields,
} from "@psi/managed/managedExchangeStore";
import {
  ManagedRelayRegistrarStaleError,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  appendDisclosureRecordToStore,
  readDisclosureAccounting,
  resetDisclosureAccounting,
} from "@psi/disclosureAccountingStore";
import {
  clearManagedExchangeTermsProposal,
  getManagedLocalState,
  listManagedLocalState,
  listReadableManagedLocalState,
  markManagedExchangeBackedUp,
  markManagedExchangeImported,
  markManagedExchangeKeyImported,
} from "@psi/managed/managedLocalState";
import {
  clearParkedResults,
  readParkedResults,
  recordParkedResultsRefusal,
} from "@psi/parkedResultsStore";
import {
  fileUnfiledDisclosures,
  noteUnfiledDisclosureRun,
  readUnfiledDisclosures,
} from "@psi/unfiledDisclosureStore";

import { createFakeIndexedDb } from "../../utils/fakeIndexedDb";
import { disclosureRecord } from "../../utils/disclosureFixtures";

import type {
  FakeIndexedDb,
  FakeRequestTarget,
} from "../../utils/fakeIndexedDb";
import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { RelayRegistrar } from "@alcove/core";

/**
 * The transaction mechanics every managed and psi/ store function shares --
 * which error a failed request rejects with, the durability a readwrite
 * transaction asks for, the abort a throw makes, the connection each call
 * closes, and the point inside the transaction each secret refusal is made
 * at -- over the in-memory model in test/utils/fakeIndexedDb.ts. The browser
 * suite, test/browser/managedExchangeStore.test.ts, drives the same calls
 * against Chromium's IndexedDB.
 */

const linkageTerms = getDefaultLinkageTerms("County Health Dept");
const AT = "2026-03-07T14:00:00.000Z";

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
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

async function createRunnable(): Promise<RunnableManagedExchangeRecord> {
  return runnableManagedExchangeOrRefuse(
    await createManagedExchange(newExchange()),
  );
}

async function createConfigurationOnly(): Promise<ManagedExchangeRecord> {
  const { sharedSecret: _sharedSecret, ...fields } = newExchange();
  return createManagedExchange(fields);
}

const reinvite = (sharedSecret: string) => ({
  sharedSecret,
  expires: null,
  signalingServer: { host: "signaling.example.org" },
});

let fake: FakeIndexedDb;

beforeEach(() => {
  fake = createFakeIndexedDb();
  vi.stubGlobal("indexedDB", fake.factory);
  const local = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function storedRecord(id: string): unknown {
  return fake.stored(MANAGED_EXCHANGE_DB_NAME, MANAGED_EXCHANGE_STORE_NAME, id);
}

function storedLocal(id: string): unknown {
  return fake.stored(
    MANAGED_EXCHANGE_DB_NAME,
    MANAGED_EXCHANGE_LOCAL_STORE_NAME,
    id,
  );
}

const on =
  (store: string, ...operations: Array<FakeRequestTarget["operation"]>) =>
  (target: FakeRequestTarget) =>
    target.store === store && operations.includes(target.operation);

const RECORDS = MANAGED_EXCHANGE_STORE_NAME;
const LOCAL = MANAGED_EXCHANGE_LOCAL_STORE_NAME;
const DISCLOSURES = MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME;
const RESULTS = MANAGED_EXCHANGE_RESULTS_STORE_NAME;

/** A store call, the request of it that is refused, and the arguments it is
 * called with over a stored runnable record. */
interface FailingSite {
  name: string;
  refused: (target: FakeRequestTarget) => boolean;
  act: (record: RunnableManagedExchangeRecord) => Promise<unknown>;
}

const FAILING_SITES: ReadonlyArray<FailingSite> = [
  {
    name: "putManagedExchange",
    refused: on(RECORDS, "put"),
    act: (record) => putManagedExchange(record),
  },
  {
    name: "getManagedExchange",
    refused: on(RECORDS, "get"),
    act: (record) => getManagedExchange(record.id),
  },
  {
    name: "listManagedExchanges",
    refused: on(RECORDS, "getAll"),
    act: () => listManagedExchanges(),
  },
  {
    name: "listReadableManagedExchanges",
    refused: on(RECORDS, "getAll"),
    act: () => listReadableManagedExchanges(),
  },
  {
    name: "listManagedExchangesDiagnostic",
    refused: on(LOCAL, "getAll"),
    act: () => listManagedExchangesDiagnostic(),
  },
  {
    name: "updateManagedExchangeLocalFields",
    refused: on(RECORDS, "put"),
    act: (record) =>
      updateManagedExchangeLocalFields(record.id, { label: "edited" }),
  },
  {
    name: "persistManagedExchangeRotation",
    refused: on(RECORDS, "put"),
    act: (record) =>
      persistManagedExchangeRotation(record.id, record.sharedSecret, {
        sharedSecret: generateSharedSecret(),
        expires: null,
      }),
  },
  {
    name: "persistManagedExchangeReinvite",
    refused: on(RECORDS, "put"),
    act: (record) =>
      persistManagedExchangeReinvite(
        record.id,
        record.sharedSecret,
        reinvite(generateSharedSecret()),
      ),
  },
  {
    name: "dropManagedExchangePreviousSecret",
    refused: on(RECORDS, "get"),
    act: (record) =>
      dropManagedExchangePreviousSecret(record.id, record.sharedSecret),
  },
  {
    name: "markManagedExchangeRotationInFlight",
    refused: on(RECORDS, "put"),
    act: (record) => markManagedExchangeRotationInFlight(record.id, AT),
  },
  {
    name: "clearManagedExchangeRotationInFlight",
    refused: on(RECORDS, "get"),
    act: (record) =>
      clearManagedExchangeRotationInFlight(record.id, record.sharedSecret),
  },
  {
    name: "persistManagedExchangeRelayRegistrar",
    refused: on(RECORDS, "put"),
    act: (record) => persistManagedExchangeRelayRegistrar(record.id, undefined),
  },
  {
    name: "clearManagedExchangeRelayRegistrationPending",
    refused: on(RECORDS, "put"),
    act: (record) =>
      clearManagedExchangeRelayRegistrationPending(
        record.id,
        record.sharedSecret,
      ),
  },
  {
    name: "persistManagedExchangeTermsChange",
    refused: on(RECORDS, "get"),
    act: (record) =>
      persistManagedExchangeTermsChange(record.id, {
        scope: "apply",
        partnerTerms: linkageTerms,
      }),
  },
  {
    name: "persistManagedRunTermsChange",
    refused: on(RECORDS, "get"),
    act: (record) =>
      persistManagedRunTermsChange(
        { id: record.id, linkageTerms: record.exchangeFile.linkageTerms },
        {
          scope: "run",
          adoptedTerms: linkageTerms,
          partnerTerms: linkageTerms,
        },
      ),
  },
  {
    name: "persistManagedExchangeSentColumns",
    refused: on(RECORDS, "get"),
    act: (record) => persistManagedExchangeSentColumns(record.id, []),
  },
  {
    name: "recordManagedExchangeLastRun",
    refused: on(RECORDS, "put"),
    act: (record) =>
      recordManagedExchangeLastRun(
        record.id,
        { at: AT, outcome: "succeeded" },
        Date.parse(AT),
      ),
  },
  {
    name: "persistManagedRunPayloadReceiveFill",
    refused: on(RECORDS, "get"),
    act: (record) =>
      persistManagedRunPayloadReceiveFill(
        { id: record.id, linkageTerms: record.exchangeFile.linkageTerms },
        [],
      ),
  },
  {
    name: "clearManagedExchangeStandingCondition",
    refused: on(RECORDS, "put"),
    act: (record) => clearManagedExchangeStandingCondition(record.id),
  },
  {
    name: "recordManagedExchangeCompromiseResponse",
    refused: on(RECORDS, "put"),
    act: (record) => recordManagedExchangeCompromiseResponse(record.id, AT),
  },
  {
    name: "persistManagedExchangeScheduleAdvance",
    refused: on(RECORDS, "get"),
    act: (record) =>
      persistManagedExchangeScheduleAdvance(
        record.id,
        {} as Parameters<typeof persistManagedExchangeScheduleAdvance>[1],
      ),
  },
  {
    name: "persistManagedExchangeWorkingDirectory",
    refused: on(RECORDS, "put"),
    act: (record) => persistManagedExchangeWorkingDirectory(record.id, null),
  },
  {
    name: "readRecordAndMarkBackedUp",
    refused: on(LOCAL, "put"),
    act: (record) =>
      readRecordAndMarkBackedUp(record.id, AT, () => ({
        kind: "downloaded",
        fileName: "backup.alcove",
      })),
  },
  {
    name: "markManagedBackupIfCurrent",
    refused: on(LOCAL, "put"),
    act: (record) =>
      markManagedBackupIfCurrent(record.id, record.sharedSecret, AT),
  },
  {
    name: "reconcileManagedBackupImport",
    refused: on(RECORDS, "getAll"),
    act: (record) => reconcileManagedBackupImport(record),
  },
  {
    name: "reconcileManagedCommandLinePair",
    refused: on(RECORDS, "getAll"),
    act: (record) => reconcileManagedCommandLinePair(record, AT),
  },
  {
    name: "replaceManagedExchangeFromImport",
    refused: on(RECORDS, "get"),
    act: (record) =>
      replaceManagedExchangeFromImport(
        record.id,
        record.sharedSecret,
        AT,
        record,
        "backup",
      ),
  },
  {
    name: "deleteManagedExchange",
    refused: on(RECORDS, "delete"),
    act: (record) => deleteManagedExchange(record.id),
  },
  {
    name: "clearManagedExchanges",
    refused: on(RECORDS, "clear"),
    act: () => clearManagedExchanges(),
  },
  {
    name: "getManagedLocalState",
    refused: on(LOCAL, "get"),
    act: (record) => getManagedLocalState(record.id),
  },
  {
    name: "listManagedLocalState",
    refused: on(LOCAL, "getAll"),
    act: () => listManagedLocalState(),
  },
  {
    name: "listReadableManagedLocalState",
    refused: on(LOCAL, "getAll"),
    act: () => listReadableManagedLocalState(),
  },
  {
    name: "markManagedExchangeBackedUp",
    refused: on(LOCAL, "put"),
    act: (record) => markManagedExchangeBackedUp(record.id, AT),
  },
  {
    name: "markManagedExchangeImported",
    refused: on(LOCAL, "put"),
    act: (record) => markManagedExchangeImported(record.id, AT),
  },
  {
    name: "markManagedExchangeKeyImported",
    refused: on(LOCAL, "get"),
    act: (record) => markManagedExchangeKeyImported(record.id, AT),
  },
  {
    name: "clearManagedExchangeTermsProposal",
    refused: on(LOCAL, "get"),
    act: (record) => clearManagedExchangeTermsProposal(record.id),
  },
  {
    name: "recordParkedResultsRefusal",
    refused: on(RESULTS, "put"),
    act: (record) => recordParkedResultsRefusal(record.id, AT),
  },
  {
    name: "clearParkedResults",
    refused: on(RESULTS, "delete"),
    act: (record) => clearParkedResults(record.id),
  },
  {
    name: "appendDisclosureRecordToStore",
    refused: on(DISCLOSURES, "put"),
    act: async (record) =>
      appendDisclosureRecordToStore(record.id, await disclosureRecord()),
  },
  {
    name: "resetDisclosureAccounting",
    refused: on(DISCLOSURES, "delete"),
    act: (record) => resetDisclosureAccounting(record.id),
  },
  {
    name: "fileUnfiledDisclosures",
    refused: on(DISCLOSURES, "get"),
    act: (record) => fileUnfiledDisclosures(record.id),
  },
];

describe("a failed request rejects with that request's error", () => {
  test("a create over a key already stored rejects with the constraint error", async () => {
    const stored = await createRunnable();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      stored.id as ReturnType<typeof crypto.randomUUID>,
    );

    const rejection = await createManagedExchange(newExchange()).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(DOMException);
    expect((rejection as DOMException).name).toBe("ConstraintError");
    expect(fake.openConnections()).toBe(0);
  });

  test.each(FAILING_SITES)("$name", async ({ refused, act }) => {
    const record = await createRunnable();
    const quota = new DOMException("the disk is full", "QuotaExceededError");
    fake.failRequests(refused, quota);

    await expect(act(record)).rejects.toBe(quota);
    expect(fake.openConnections()).toBe(0);
  });
});

describe("every transaction asks the durability its mode needs and closes", () => {
  test("each readwrite transaction is strict, each readonly one asks nothing, and every connection closes", async () => {
    const record = await createRunnable();
    const configuration = await createConfigurationOnly();
    await putManagedExchange(record);
    await getManagedExchange(record.id);
    await listManagedExchanges();
    await listReadableManagedExchanges();
    await listManagedExchangesDiagnostic();
    await updateManagedExchangeLocalFields(record.id, { label: "edited" });
    await markManagedExchangeRotationInFlight(record.id, AT);
    await clearManagedExchangeRotationInFlight(record.id, record.sharedSecret);
    const rotated = generateSharedSecret();
    await persistManagedExchangeRotation(record.id, record.sharedSecret, {
      sharedSecret: rotated,
      expires: null,
    });
    await dropManagedExchangePreviousSecret(record.id, rotated);
    const reinvited = generateSharedSecret();
    await persistManagedExchangeReinvite(
      record.id,
      rotated,
      reinvite(reinvited),
    );
    await persistManagedExchangeRelayRegistrar(record.id, undefined);
    await clearManagedExchangeRelayRegistrationPending(record.id, reinvited);
    await recordManagedExchangeLastRun(
      record.id,
      { at: AT, outcome: "succeeded" },
      Date.parse(AT),
    );
    await recordManagedExchangeCompromiseResponse(record.id, AT);
    await clearManagedExchangeStandingCondition(record.id);
    await persistManagedExchangeWorkingDirectory(record.id, null);
    await readRecordAndMarkBackedUp(record.id, AT, () => ({
      kind: "downloaded",
      fileName: "backup.alcove",
    }));
    await markManagedBackupIfCurrent(record.id, reinvited, AT);
    await reconcileManagedBackupImport(
      buildManagedExchangeRecord(newExchange()),
    );
    await getManagedLocalState(record.id);
    await listManagedLocalState();
    await listReadableManagedLocalState();
    await markManagedExchangeBackedUp(configuration.id, AT);
    await markManagedExchangeImported(configuration.id, AT);
    await markManagedExchangeKeyImported(configuration.id, AT);
    await clearManagedExchangeTermsProposal(configuration.id);
    await recordParkedResultsRefusal(record.id, AT);
    await readParkedResults(record.id);
    await clearParkedResults(record.id);
    await appendDisclosureRecordToStore(record.id, await disclosureRecord());
    await readDisclosureAccounting(record.id);
    await resetDisclosureAccounting(record.id);
    await noteUnfiledDisclosureRun(record.id, await disclosureRecord(), AT);
    await readUnfiledDisclosures(record.id);
    await fileUnfiledDisclosures(record.id);
    await deleteManagedExchange(record.id);
    await clearManagedExchanges();

    // One transaction for each of the forty calls above.
    expect(fake.transactions).toHaveLength(40);
    for (const { mode, options, outcome, storeNames } of fake.transactions) {
      expect(outcome, storeNames.join()).toBe("complete");
      expect(options, `${mode} over ${storeNames.join()}`).toEqual(
        mode === "readwrite" ? { durability: "strict" } : undefined,
      );
    }
    expect(fake.openConnections()).toBe(0);
  });
});

describe("a throw inside a transaction aborts it", () => {
  test("a local edit the schema refuses aborts and leaves the record", async () => {
    const record = await createRunnable();
    const before = storedRecord(record.id);

    await expect(
      updateManagedExchangeLocalFields(record.id, { label: "x".repeat(5000) }),
    ).rejects.toThrow();

    expect(fake.transactions.at(-1)?.outcome).toBe("abort");
    expect(storedRecord(record.id)).toEqual(before);
    expect(fake.openConnections()).toBe(0);
  });

  test("a rotation to a malformed secret aborts and clears no sibling entry", async () => {
    const record = await createRunnable();
    await markManagedExchangeBackedUp(record.id, AT);
    const before = storedRecord(record.id);

    await expect(
      persistManagedExchangeRotation(record.id, record.sharedSecret, {
        sharedSecret: "not-a-secret",
        expires: null,
      }),
    ).rejects.toThrow();

    expect(fake.transactions.at(-1)?.outcome).toBe("abort");
    expect(storedRecord(record.id)).toEqual(before);
    expect(storedLocal(record.id)).toBeDefined();
  });

  test("an export that refuses the record it read rejects with its own error and stamps no marker", async () => {
    const record = await createRunnable();
    const refusal = new Error("the export refused this record");

    await expect(
      readRecordAndMarkBackedUp(record.id, AT, () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);

    expect(fake.transactions.at(-1)?.outcome).toBe("abort");
    expect(storedLocal(record.id)).toBeUndefined();
    expect(fake.openConnections()).toBe(0);
  });

  test("a write to a missing record rejects naming it and aborts", async () => {
    await expect(
      recordManagedExchangeCompromiseResponse("no-such-id", AT),
    ).rejects.toThrow("no managed exchange with id no-such-id");
    expect(fake.transactions.at(-1)?.outcome).toBe("abort");
    expect(storedRecord("no-such-id")).toBeUndefined();
  });

  test("a disclosure record the reader refuses aborts the append", async () => {
    const record = await createRunnable();

    await expect(
      appendDisclosureRecordToStore(record.id, {
        ...(await disclosureRecord()),
        bindingNonce: 7,
      } as unknown as Awaited<ReturnType<typeof disclosureRecord>>),
    ).rejects.toThrow();

    expect(fake.transactions.at(-1)?.outcome).toBe("abort");
    expect(
      fake.stored(MANAGED_EXCHANGE_DB_NAME, DISCLOSURES, record.id),
    ).toBeUndefined();
  });
});

describe("the secret refusals are made inside the transaction, in their order", () => {
  test("a rotation narrows the record before it compares the secret", async () => {
    const configuration = await createConfigurationOnly();

    await expect(
      persistManagedExchangeRotation(configuration.id, generateSharedSecret(), {
        sharedSecret: generateSharedSecret(),
        expires: null,
      }),
    ).rejects.toThrow(/configuration only/);
    expect(storedRecord(configuration.id)).not.toHaveProperty("sharedSecret");
  });

  test("a rotation over a secret that moved refuses and writes nothing", async () => {
    const record = await createRunnable();
    const before = storedRecord(record.id);

    await expect(
      persistManagedExchangeRotation(record.id, generateSharedSecret(), {
        sharedSecret: generateSharedSecret(),
        expires: null,
      }),
    ).rejects.toBeInstanceOf(ManagedExchangeSecretChangedError);
    expect(storedRecord(record.id)).toEqual(before);
  });

  test("a re-invite refuses a standing response before it compares the secret", async () => {
    const record = await createRunnable();
    await recordManagedExchangeCompromiseResponse(record.id, AT);
    const before = storedRecord(record.id);

    await expect(
      persistManagedExchangeReinvite(
        record.id,
        generateSharedSecret(),
        reinvite(generateSharedSecret()),
      ),
    ).rejects.toBeInstanceOf(ManagedReinviteWithheldError);
    expect(storedRecord(record.id)).toEqual(before);
  });

  test("a re-invite narrows the record before it reads the response", async () => {
    const configuration = await createConfigurationOnly();
    await recordManagedExchangeCompromiseResponse(configuration.id, AT);

    await expect(
      persistManagedExchangeReinvite(
        configuration.id,
        generateSharedSecret(),
        reinvite(generateSharedSecret()),
      ),
    ).rejects.toThrow(/configuration only/);
  });

  test("a registrar confirmed under another secret is refused after the narrowing", async () => {
    const record = await createRunnable();
    const configuration = await createConfigurationOnly();
    const before = storedRecord(record.id);
    const configurationBefore = storedRecord(configuration.id);
    const registrar: RelayRegistrar = {
      url: "https://relay.example.org/",
      exchangeId: "riverbend",
    };

    await expect(
      persistManagedExchangeRelayRegistrar(
        record.id,
        registrar,
        generateSharedSecret(),
      ),
    ).rejects.toBeInstanceOf(ManagedRelayRegistrarStaleError);
    await expect(
      persistManagedExchangeRelayRegistrar(
        configuration.id,
        registrar,
        generateSharedSecret(),
      ),
    ).rejects.toThrow(/configuration only/);
    expect(storedRecord(record.id)).toEqual(before);
    expect(storedRecord(configuration.id)).toEqual(configurationBefore);
  });

  test("a terms change checked under a secret that moved refuses", async () => {
    const record = await createRunnable();
    const before = storedRecord(record.id);

    await expect(
      persistManagedExchangeTermsChange(
        record.id,
        { scope: "apply", partnerTerms: linkageTerms },
        generateSharedSecret(),
      ),
    ).rejects.toBeInstanceOf(ManagedExchangeSecretChangedError);
    expect(storedRecord(record.id)).toEqual(before);
  });

  test("a run's outcome over a secret that moved is not stamped", async () => {
    const record = await createRunnable();
    const before = storedRecord(record.id);

    const read = await recordManagedExchangeLastRun(
      record.id,
      { at: AT, outcome: "succeeded" },
      Date.parse(AT),
      generateSharedSecret(),
    );

    expect(read).toEqual(before);
    expect(storedRecord(record.id)).toEqual(before);
  });

  test("dropping the previous secret under a secret that moved writes nothing", async () => {
    const record = await createRunnable();
    const before = storedRecord(record.id);

    await dropManagedExchangePreviousSecret(record.id, generateSharedSecret());

    expect(storedRecord(record.id)).toEqual(before);
  });
});
