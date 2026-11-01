/// <reference types="@vitest/browser-playwright/context" />

import {
  EXCHANGE_RECORD_VERSION,
  FormatMigrationError,
  generateSharedSecret,
  getDefaultLinkageTerms,
  getLogger,
} from "@alcove/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";

import {
  MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  listManagedExchanges,
  openManagedExchangeDatabase,
  updateManagedExchangeLocalFields,
} from "@psi/managed/managedExchangeStore";
import {
  MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION,
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  UNFILED_DISCLOSURE_VERSION,
  unfiledDisclosureKey,
} from "@psi/unfiledDisclosure";
import {
  appendDisclosureRecordToStore,
  readDisclosureAccounting,
} from "@psi/disclosureAccountingStore";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import {
  fileUnfiledDisclosures,
  noteUnfiledDisclosureRun,
  readUnfiledDisclosures,
} from "@psi/unfiledDisclosureStore";
import { DISCLOSURE_ACCOUNTING_VERSION } from "@psi/disclosureAccounting";
import { clearUnfiledExchangeFlag } from "@psi/unfiledDisclosureFlag";
import { importManagedExchange } from "@psi/managed/managedExchangeImport";

import {
  UNMOVABLE_CAUSE,
  UNMOVABLE_FIELD,
  atPreviousVersion,
} from "../utils/storedFormatMigrations";
import { disclosureRecord } from "../utils/disclosureFixtures";

import type * as AlcoveCore from "@alcove/core";
import type * as DisclosureAccountingModule from "@psi/disclosureAccounting";
import type * as ManagedExchangeRecordModule from "@psi/managed/managedExchangeRecord";
import type * as UnfiledDisclosureModule from "@psi/unfiledDisclosure";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

/**
 * Migration on read through the browser stores, against real IndexedDB: a
 * value an earlier version stored is read at the current version with the
 * stored bytes unchanged, is written at the current version by the store's
 * next write, and a failed migration refuses naming its cause with the stored
 * value unchanged.
 *
 * The record, the accounting envelope, the note and the exchange record have
 * no step yet, so each parser the stores import is bound here to a one-step
 * table of the test's own (../utils/storedFormatMigrations.ts). The backup's
 * table is its real one.
 */

vi.mock("@alcove/core", async (importOriginal) => {
  const actual = await importOriginal<typeof AlcoveCore>();
  const { previousVersionMigrations } =
    await import("../utils/storedFormatMigrations");
  const table = previousVersionMigrations(
    "The exchange record",
    "version",
    actual.EXCHANGE_RECORD_VERSION,
  );
  return {
    ...actual,
    parseExchangeRecord: (raw: unknown) =>
      actual.parseExchangeRecord(raw, table),
  };
});

vi.mock("@psi/managed/managedExchangeRecord", async (importOriginal) => {
  const actual = await importOriginal<typeof ManagedExchangeRecordModule>();
  const { previousVersionMigrations } =
    await import("../utils/storedFormatMigrations");
  const table = previousVersionMigrations(
    "A saved exchange",
    "schemaVersion",
    actual.MANAGED_EXCHANGE_SCHEMA_VERSION,
    { field: "label", storedName: "name" },
  );
  return {
    ...actual,
    parseManagedExchangeRecord: (raw: unknown) =>
      actual.parseManagedExchangeRecord(raw, table),
  };
});

vi.mock("@psi/disclosureAccounting", async (importOriginal) => {
  const actual = await importOriginal<typeof DisclosureAccountingModule>();
  const { previousVersionMigrations } =
    await import("../utils/storedFormatMigrations");
  const table = previousVersionMigrations(
    "The accounting of disclosures",
    "version",
    actual.DISCLOSURE_ACCOUNTING_VERSION,
    { field: "entries", storedName: "records" },
  );
  return {
    ...actual,
    parseDisclosureAccounting: (raw: unknown) =>
      actual.parseDisclosureAccounting(raw, table),
    parseStoredDisclosureAccounting: (raw: unknown) =>
      actual.parseStoredDisclosureAccounting(raw, table),
    appendToStoredDisclosureAccounting: (current: unknown, record: unknown) =>
      actual.appendToStoredDisclosureAccounting(current, record, table),
  };
});

vi.mock("@psi/unfiledDisclosure", async (importOriginal) => {
  const actual = await importOriginal<typeof UnfiledDisclosureModule>();
  const { previousVersionMigrations } =
    await import("../utils/storedFormatMigrations");
  const table = previousVersionMigrations(
    "The note",
    "version",
    actual.UNFILED_DISCLOSURE_VERSION,
    { field: "entries", storedName: "runs" },
  );
  return {
    ...actual,
    parseStoredUnfiledDisclosures: (raw: unknown) =>
      actual.parseStoredUnfiledDisclosures(raw, table),
  };
});

const RECORD_RENAME = { field: "label", storedName: "name" };
const ACCOUNTING_RENAME = { field: "entries", storedName: "records" };
const NOTE_RENAME = { field: "entries", storedName: "runs" };
const NOTED_AT = "2026-07-01T09:00:01.000Z";

function newExchange(): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  };
}

/** The value at rest under `key` of `storeName`, past every validating read. */
async function rawStored(
  storeName: string,
  key: IDBValidKey,
): Promise<unknown> {
  const db = await openManagedExchangeDatabase();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Put `value` into `storeName` past every write path, as an earlier build
 * left it. `key` is omitted for the record store, which keys on `id`. */
async function putRawStored(
  storeName: string,
  value: unknown,
  key?: IDBValidKey,
): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      if (key === undefined) store.put(value);
      else store.put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** An exchange record as the record version before this build's stored it. */
async function earlierRecord(): Promise<Record<string, unknown>> {
  return atPreviousVersion({ ...(await disclosureRecord()) }, "version");
}

beforeEach(clearManagedExchanges);
afterEach(clearManagedExchanges);

describe("a managed record an earlier version stored", () => {
  test("is read at the current version, the stored value unchanged", async () => {
    const created = await createManagedExchange(newExchange());
    const earlier = atPreviousVersion(
      { ...created },
      "schemaVersion",
      RECORD_RENAME,
    );
    await putRawStored(MANAGED_EXCHANGE_STORE_NAME, earlier);

    expect(await getManagedExchange(created.id)).toEqual(created);
    expect(await listManagedExchanges()).toEqual([created]);
    expect(await rawStored(MANAGED_EXCHANGE_STORE_NAME, created.id)).toEqual(
      earlier,
    );
  });

  test("is written at the current version by the next store write", async () => {
    const created = await createManagedExchange(newExchange());
    await putRawStored(
      MANAGED_EXCHANGE_STORE_NAME,
      atPreviousVersion({ ...created }, "schemaVersion", RECORD_RENAME),
    );

    await updateManagedExchangeLocalFields(created.id, {
      label: "Riverbend 2027",
    });

    expect(await rawStored(MANAGED_EXCHANGE_STORE_NAME, created.id)).toEqual({
      ...created,
      schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
      label: "Riverbend 2027",
    });
  });

  test("whose migration fails is refused naming the cause, the stored value unchanged", async () => {
    const created = await createManagedExchange(newExchange());
    const earlier = {
      ...atPreviousVersion({ ...created }, "schemaVersion", RECORD_RENAME),
      [UNMOVABLE_FIELD]: true,
    };
    await putRawStored(MANAGED_EXCHANGE_STORE_NAME, earlier);

    const read = getManagedExchange(created.id);
    await expect(read).rejects.toBeInstanceOf(FormatMigrationError);
    await expect(read).rejects.toThrow(UNMOVABLE_CAUSE);
    await expect(
      updateManagedExchangeLocalFields(created.id, { label: "Riverbend" }),
    ).rejects.toThrow(UNMOVABLE_CAUSE);
    expect(await rawStored(MANAGED_EXCHANGE_STORE_NAME, created.id)).toEqual(
      earlier,
    );
  });
});

describe("an accounting an earlier version stored", () => {
  test("is read at the current version, the stored value unchanged", async () => {
    const created = await createManagedExchange(newExchange());
    const entries = [await earlierRecord(), await disclosureRecord()];
    const earlier = atPreviousVersion(
      { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
      "version",
      ACCOUNTING_RENAME,
    );
    await putRawStored(
      MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      earlier,
      created.id,
    );

    const read = await readDisclosureAccounting(created.id);

    expect(read.kind).toBe("accounting");
    if (read.kind !== "accounting") return;
    expect(read.accounting.version).toBe(DISCLOSURE_ACCOUNTING_VERSION);
    expect(read.accounting.entries.map((entry) => entry.version)).toEqual([
      EXCHANGE_RECORD_VERSION,
      EXCHANGE_RECORD_VERSION,
    ]);
    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, created.id),
    ).toEqual(earlier);
  });

  test("is written at the current version by the next append, its entries as stored", async () => {
    const created = await createManagedExchange(newExchange());
    const entries = [await earlierRecord(), await disclosureRecord()];
    await putRawStored(
      MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      atPreviousVersion(
        { version: DISCLOSURE_ACCOUNTING_VERSION, entries },
        "version",
        ACCOUNTING_RENAME,
      ),
      created.id,
    );
    const next = await disclosureRecord();

    await appendDisclosureRecordToStore(created.id, next);

    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, created.id),
    ).toEqual({
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [...entries, next],
    });
  });

  test("whose migration fails is refused naming the cause, the stored value unchanged", async () => {
    const created = await createManagedExchange(newExchange());
    const earlier = {
      ...atPreviousVersion(
        {
          version: DISCLOSURE_ACCOUNTING_VERSION,
          entries: [await disclosureRecord()],
        },
        "version",
        ACCOUNTING_RENAME,
      ),
      [UNMOVABLE_FIELD]: true,
    };
    await putRawStored(
      MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      earlier,
      created.id,
    );

    expect(await readDisclosureAccounting(created.id)).toEqual({
      kind: "unreadable",
      stored: undefined,
    });
    await expect(
      appendDisclosureRecordToStore(created.id, await disclosureRecord()),
    ).rejects.toThrow(UNMOVABLE_CAUSE);
    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, created.id),
    ).toEqual(earlier);
  });

  test("holding an entry whose migration fails offers its entries for export", async () => {
    const created = await createManagedExchange(newExchange());
    const unmovable = { ...(await earlierRecord()), [UNMOVABLE_FIELD]: true };
    const stored = {
      version: DISCLOSURE_ACCOUNTING_VERSION,
      entries: [unmovable],
    };
    await putRawStored(
      MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      stored,
      created.id,
    );

    expect(await readDisclosureAccounting(created.id)).toEqual({
      kind: "unreadable",
      stored,
    });
    await expect(
      appendDisclosureRecordToStore(created.id, await disclosureRecord()),
    ).rejects.toThrow(UNMOVABLE_CAUSE);
    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, created.id),
    ).toEqual(stored);
  });
});

describe("a note of unfiled runs an earlier version stored", () => {
  test("is read at the current version, the stored value unchanged", async () => {
    const created = await createManagedExchange(newExchange());
    const retained = await earlierRecord();
    const earlier = atPreviousVersion(
      {
        version: UNFILED_DISCLOSURE_VERSION,
        entries: [{ at: NOTED_AT, record: retained }],
      },
      "version",
      NOTE_RENAME,
    );
    const key = unfiledDisclosureKey(created.id);
    await putRawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, earlier, key);

    const read = await readUnfiledDisclosures(created.id);

    expect(read.kind).toBe("unfiled");
    if (read.kind !== "unfiled") return;
    expect(read.disclosures.map((run) => run.record?.version)).toEqual([
      EXCHANGE_RECORD_VERSION,
    ]);
    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, key),
    ).toEqual(earlier);
  });

  test("is written at the current version by the next note, its runs as stored", async () => {
    const created = await createManagedExchange(newExchange());
    const noted = { at: NOTED_AT, record: await earlierRecord() };
    const key = unfiledDisclosureKey(created.id);
    await putRawStored(
      MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      atPreviousVersion(
        { version: UNFILED_DISCLOSURE_VERSION, entries: [noted] },
        "version",
        NOTE_RENAME,
      ),
      key,
    );
    const next = await disclosureRecord();

    expect(await noteUnfiledDisclosureRun(created.id, next, NOTED_AT)).toBe(
      "noted",
    );

    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, key),
    ).toEqual({
      version: UNFILED_DISCLOSURE_VERSION,
      entries: [noted, { at: NOTED_AT, record: next }],
    });
  });

  test("files its retained record into the accounting as stored", async () => {
    const created = await createManagedExchange(newExchange());
    const retained = await earlierRecord();
    const key = unfiledDisclosureKey(created.id);
    await putRawStored(
      MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME,
      atPreviousVersion(
        {
          version: UNFILED_DISCLOSURE_VERSION,
          entries: [{ at: NOTED_AT, record: retained }],
        },
        "version",
        NOTE_RENAME,
      ),
      key,
    );

    await fileUnfiledDisclosures(created.id);

    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, created.id),
    ).toEqual({ version: DISCLOSURE_ACCOUNTING_VERSION, entries: [retained] });
    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, key),
    ).toBeUndefined();
  });

  test("whose migration fails is refused naming the cause, the stored value unchanged", async () => {
    const created = await createManagedExchange(newExchange());
    const key = unfiledDisclosureKey(created.id);
    const earlier = {
      ...atPreviousVersion(
        {
          version: UNFILED_DISCLOSURE_VERSION,
          entries: [{ at: NOTED_AT }],
        },
        "version",
        NOTE_RENAME,
      ),
      [UNMOVABLE_FIELD]: true,
    };
    await putRawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, earlier, key);
    const report = vi
      .spyOn(getLogger("unfiledDisclosureStore"), "error")
      .mockImplementation(() => {});
    onTestFinished(async () => {
      report.mockRestore();
      await clearUnfiledExchangeFlag(created.id);
    });

    expect(await readUnfiledDisclosures(created.id)).toEqual({
      kind: "unreadable",
    });
    expect(
      await noteUnfiledDisclosureRun(
        created.id,
        await disclosureRecord(),
        NOTED_AT,
      ),
    ).toBe("flagged");
    const cause = (report.mock.calls[0]?.[1] as Error | undefined)?.cause;
    expect(cause).toBeInstanceOf(FormatMigrationError);
    expect((cause as Error).message).toContain(UNMOVABLE_CAUSE);
    expect(
      await rawStored(MANAGED_EXCHANGE_DISCLOSURE_STORE_NAME, key),
    ).toEqual(earlier);
  });
});

describe("a backup file at the previous artifact version", () => {
  /** A backup of a fresh exchange under the previous tag, and the exchange. */
  async function previousVersionBackup(
    condition?: Record<string, unknown>,
  ): Promise<{ bytes: string; sharedSecret: string }> {
    const source = runnableManagedExchangeOrRefuse(
      await createManagedExchange(newExchange()),
    );
    const document = JSON.parse(
      serializeManagedExchangeArtifact(encodeManagedExchangeArtifact(source)),
    );
    document.artifactVersion = MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION;
    if (condition !== undefined) document.local.standingCondition = condition;
    await clearManagedExchanges();
    return {
      bytes: JSON.stringify(document),
      sharedSecret: source.sharedSecret,
    };
  }

  test("imports as a record at the current version", async () => {
    const raised = { since: "2026-07-10T09:00:00.000Z", kind: "auth" };
    const { bytes, sharedSecret } = await previousVersionBackup(raised);

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.sharedSecret).toBe(sharedSecret);
    expect(installed.standingCondition).toEqual(raised);
    expect(await rawStored(MANAGED_EXCHANGE_STORE_NAME, installed.id)).toEqual(
      expect.objectContaining({
        schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
        sharedSecret,
      }),
    );
  });

  test("whose migration fails installs nothing", async () => {
    const { bytes } = await previousVersionBackup({
      since: "2026-07-10T09:00:00.000Z",
      kind: "auth",
      response: { kind: "compromise", at: "2026-07-11T09:00:00.000Z" },
    });

    await expect(importManagedExchange(bytes)).rejects.toBeInstanceOf(
      FormatMigrationError,
    );
    expect(await listManagedExchanges()).toEqual([]);
  });
});
