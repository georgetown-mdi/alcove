/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  listManagedExchanges,
  openManagedExchangeDatabase,
  reconcileManagedCommandLinePair,
} from "@psi/managed/managedExchangeStore";
import {
  ManagedImportAlreadyHeldError,
  ManagedImportChosenCopyError,
  ManagedImportStoredCopyError,
  importManagedCommandLinePair,
  importManagedExchange,
} from "@psi/managed/managedExchangeImport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import {
  getManagedLocalState,
  markManagedExchangeBackedUp,
} from "@psi/managed/managedLocalState";
import { ManagedKeyFileRefusedError } from "@psi/managed/managedCommandLineImport";
import { composeManagedCronExport } from "@psi/managed/managedCronExport";
import { withManagedExchangeLock } from "@psi/managed/managedExchangeLock";

import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

// The command-line pair import against the real store (real IndexedDB): a pair
// installs a runnable record, a matching stored exchange is reconciled on the
// backup import's rule, a stored record of the pair's terms and side that its
// secret misses is offered and taken into only on the operator's answer, and
// the imported secret is stored in the record's secret field and in no other
// place this browser keeps anything.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const schedule: ManagedExchangeSchedule = {
  anchor: "2026-01-06T14:00:00.000Z",
  intervalDays: 7,
  windowSeconds: 10_800,
  nextWindow: "2026-01-13T14:00:00.000Z",
  consecutiveMisses: 0,
};

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** The two files the app's own command-line export writes for `record`. */
function pairOf(record: RunnableManagedExchangeRecord): {
  configuration: string;
  key: string;
} {
  const exported = composeManagedCronExport(record);
  return { configuration: exported.config.text, key: exported.key.text };
}

async function createRunnableExchange(
  fields: NewManagedExchange,
): Promise<RunnableManagedExchangeRecord> {
  return runnableManagedExchangeOrRefuse(await createManagedExchange(fields));
}

/** Every place under `value` holding `needle` as a whole string or a part of
 * one, as a dotted path from `at`. */
function pathsHolding(
  value: unknown,
  needle: string,
  at: string,
): Array<string> {
  if (typeof value === "string") return value.includes(needle) ? [at] : [];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key.includes(needle) ? [`${at}.<key>`] : []),
    ...pathsHolding(child, needle, `${at}.${key}`),
  ]);
}

/** Every place this browser's origin keeps something that holds `needle`: each
 * object store of the managed-exchange database, by store name and key, and
 * localStorage and sessionStorage. */
async function everywhereStored(needle: string): Promise<Array<string>> {
  const db = await openManagedExchangeDatabase();
  const found: Array<string> = [];
  try {
    for (const storeName of Array.from(db.objectStoreNames)) {
      const [keys, values] = await new Promise<
        [Array<IDBValidKey>, Array<unknown>]
      >((resolve, reject) => {
        const store = db
          .transaction(storeName, "readonly")
          .objectStore(storeName);
        const readKeys = store.getAllKeys();
        const readValues = store.getAll();
        readValues.onsuccess = () =>
          resolve([readKeys.result, readValues.result]);
        readValues.onerror = () => reject(readValues.error);
      });
      keys.forEach((key, index) => {
        found.push(
          ...pathsHolding(
            values[index],
            needle,
            `${storeName}[${String(key)}]`,
          ),
        );
      });
    }
  } finally {
    db.close();
  }
  for (const [name, storage] of [
    ["localStorage", localStorage],
    ["sessionStorage", sessionStorage],
  ] as const)
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? "";
      found.push(
        ...pathsHolding({ [key]: storage.getItem(key) }, needle, name),
      );
    }
  return found;
}

beforeEach(async () => {
  await clearManagedExchanges();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("a command-line pair installs a runnable exchange", () => {
  test("with no stored match, installs fresh and stamps only the import marker", async () => {
    const source = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange()),
    );
    const { configuration, key } = pairOf(source);

    const { record } = await importManagedCommandLinePair(configuration, key);

    expect(runnableManagedExchange(record)).toBe(true);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id)).toEqual([record.id]);
    expect(stored[0].sharedSecret).toBe(source.sharedSecret);
    const local = await getManagedLocalState(record.id);
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
    expect(local?.backup).toBeUndefined();
  });

  test("the secret is stored in the record's secret field and nowhere else", async () => {
    const source = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange()),
    );
    const { configuration, key } = pairOf(source);

    const { record } = await importManagedCommandLinePair(configuration, key);

    expect(await everywhereStored(source.sharedSecret)).toEqual([
      `${MANAGED_EXCHANGE_STORE_NAME}[${record.id}].sharedSecret`,
    ]);
  });

  test("a key file field the app does not keep is dropped and named", async () => {
    const source = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange()),
    );
    const { configuration } = pairOf(source);
    const previousExpires = "2030-01-01T00:00:00.000Z";

    const { record, unreadKeyFileFields } = await importManagedCommandLinePair(
      configuration,
      JSON.stringify({ sharedSecret: source.sharedSecret, previousExpires }),
    );

    expect(unreadKeyFileFields).toEqual(["previousExpires"]);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id)).toEqual([record.id]);
    expect(stored[0].sharedSecret).toBe(source.sharedSecret);
    expect(JSON.stringify(stored[0])).not.toContain(previousExpires);
  });

  test("a key file field no Alcove version this app knows writes is refused, writing nothing", async () => {
    const source = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(newExchange()),
    );
    const { configuration } = pairOf(source);

    await expect(
      importManagedCommandLinePair(
        configuration,
        JSON.stringify({ sharedSecret: source.sharedSecret, stray: 1 }),
      ),
    ).rejects.toBeInstanceOf(ManagedKeyFileRefusedError);
    expect(await listManagedExchanges()).toEqual([]);
  });
});

describe("a stored exchange holding the pair's secret", () => {
  test("a live one refuses the pair, writing nothing", async () => {
    const live = await createRunnableExchange(newExchange());
    const { configuration, key } = pairOf(live);

    await expect(
      importManagedCommandLinePair(configuration, key),
    ).rejects.toBeInstanceOf(ManagedImportAlreadyHeldError);

    const stored = await listManagedExchanges();
    expect(stored).toEqual([live]);
    expect(await getManagedLocalState(live.id)).toBeUndefined();
  });

  test("one whose sibling entry does not parse refuses, naming its unreadable state", async () => {
    const live = await createRunnableExchange(newExchange());
    const { configuration, key } = pairOf(live);
    const db = await openManagedExchangeDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(
          MANAGED_EXCHANGE_LOCAL_STORE_NAME,
          "readwrite",
        );
        transaction
          .objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME)
          .put({ backup: { backedUpAt: "not-an-instant" } }, live.id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }

    await expect(
      importManagedCommandLinePair(configuration, key),
    ).rejects.toMatchObject({
      name: "ManagedImportAlreadyHeldError",
      stateUnreadable: true,
    });
    expect(await listManagedExchanges()).toEqual([live]);
  });

  test("the backup import refuses a live match on the same rule", async () => {
    const live = await createRunnableExchange(newExchange());
    const outcome = await reconcileManagedCommandLinePair(
      live,
      "2026-07-14T12:00:00.000Z",
    );
    expect(outcome).toEqual({ kind: "held", label: live.label });
    await expect(
      importManagedExchange(
        serializeManagedExchangeArtifact(encodeManagedExchangeArtifact(live)),
      ),
    ).rejects.toBeInstanceOf(ManagedImportAlreadyHeldError);
    expect(await listManagedExchanges()).toEqual([live]);
  });
});

describe("a stored record of the pair's terms and side that its secret misses", () => {
  // The scheduled command-line runs rotated the secret past the one stored
  // here, so only the agreed terms and side find the record. The import stops
  // to ask, writing nothing, and the operator's answer decides where it lands.

  /** A pair of `record`'s terms and side holding a secret it does not. */
  function rotatedPairOf(record: ManagedExchangeRecord): {
    configuration: string;
    key: string;
    sharedSecret: string;
  } {
    const sharedSecret = generateSharedSecret();
    const onTheCommandLine = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(
        newExchange({ label: "", side: record.side, sharedSecret }),
      ),
    );
    return { ...pairOf(onTheCommandLine), sharedSecret };
  }

  async function configurationOnly(): Promise<ManagedExchangeRecord> {
    return createManagedExchange(newExchange({ sharedSecret: undefined }));
  }

  async function storedCopyOffer(
    configuration: string,
    key: string,
  ): Promise<ManagedImportStoredCopyError> {
    const error: unknown = await importManagedCommandLinePair(
      configuration,
      key,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManagedImportStoredCopyError);
    return error as ManagedImportStoredCopyError;
  }

  test("a configuration-only record and a live one are each offered, and nothing is written", async () => {
    const live = await createRunnableExchange(newExchange({ schedule }));
    await markManagedExchangeBackedUp(live.id, "2026-07-10T09:00:00.000Z");
    const configured = await configurationOnly();
    const storedBefore = await listManagedExchanges();
    const { configuration, key, sharedSecret } = rotatedPairOf(live);

    const offer = await storedCopyOffer(configuration, key);

    expect(offer.copies).toEqual(
      expect.arrayContaining([
        { id: live.id, label: live.label, state: "runs-here" },
        {
          id: configured.id,
          label: configured.label,
          state: "configuration-only",
        },
      ]),
    );
    expect(offer.copies).toHaveLength(2);
    expect(await listManagedExchanges()).toEqual(storedBefore);
    expect(await getManagedLocalState(live.id)).toEqual({
      backup: { backedUpAt: "2026-07-10T09:00:00.000Z" },
    });
    expect(await getManagedLocalState(configured.id)).toBeUndefined();
    expect(await everywhereStored(sharedSecret)).toEqual([]);
  });

  test("taken into a configuration-only record, it completes that record in place", async () => {
    const configured = await configurationOnly();
    const { configuration, key, sharedSecret } = rotatedPairOf(configured);
    await storedCopyOffer(configuration, key);

    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { into: configured.id },
    );

    expect(record.id).toBe(configured.id);
    expect(runnableManagedExchange(record)).toBe(true);
    const stored = await listManagedExchanges();
    expect(stored.map((entry) => entry.id)).toEqual([configured.id]);
    expect(stored[0].sharedSecret).toBe(sharedSecret);
    expect(stored[0].label).toBe(configured.label);
    const local = await getManagedLocalState(configured.id);
    expect(local?.backup).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
  });

  test("a chosen record deleted since the offer refuses, writing nothing", async () => {
    const configured = await configurationOnly();
    const { configuration, key, sharedSecret } = rotatedPairOf(configured);
    await storedCopyOffer(configuration, key);
    await deleteManagedExchange(configured.id);

    const error: unknown = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { into: configured.id },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManagedImportChosenCopyError);
    expect(await listManagedExchanges()).toEqual([]);
    expect(await everywhereStored(sharedSecret)).toEqual([]);
  });

  test("taken into a live record, it replaces that record in place, keeping its schedule", async () => {
    const live = await createRunnableExchange(newExchange({ schedule }));
    await markManagedExchangeBackedUp(live.id, "2026-07-10T09:00:00.000Z");
    const { configuration, key, sharedSecret } = rotatedPairOf(live);
    await storedCopyOffer(configuration, key);

    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      undefined,
      { into: live.id },
    );

    expect(record.id).toBe(live.id);
    expect(runnableManagedExchange(record)).toBe(true);
    const stored = await listManagedExchanges();
    expect(stored).toEqual([record]);
    expect(record.sharedSecret).toBe(sharedSecret);
    expect(record.label).toBe(live.label);
    expect(record.schedule).toEqual(live.schedule);
    // The backup marker belonged to the replaced secret: no backup holds this one.
    const local = await getManagedLocalState(live.id);
    expect(local?.backup).toBeUndefined();
    expect(local?.imported?.importedAt).toEqual(expect.any(String));
    expect(await everywhereStored(sharedSecret)).toEqual([
      `${MANAGED_EXCHANGE_STORE_NAME}[${live.id}].sharedSecret`,
    ]);

    // The same files again are the same exchange now, so nothing changes.
    await expect(
      importManagedCommandLinePair(configuration, key),
    ).rejects.toBeInstanceOf(ManagedImportAlreadyHeldError);
    expect(await listManagedExchanges()).toEqual(stored);
  });

  test("a live record whose run holds its lock refuses the replace, writing nothing", async () => {
    const live = await createRunnableExchange(newExchange({ schedule }));
    const { configuration, key, sharedSecret } = rotatedPairOf(live);

    let error: unknown;
    await withManagedExchangeLock(live.id, async () => {
      error = await importManagedCommandLinePair(
        configuration,
        key,
        undefined,
        { into: live.id },
      ).catch((caught: unknown) => caught);
    });

    expect(error).toBeInstanceOf(ManagedImportChosenCopyError);
    expect((error as ManagedImportChosenCopyError).reason).toBe(
      "run-in-flight",
    );
    expect(await listManagedExchanges()).toEqual([live]);
    expect(await everywhereStored(sharedSecret)).toEqual([]);
  });
});
