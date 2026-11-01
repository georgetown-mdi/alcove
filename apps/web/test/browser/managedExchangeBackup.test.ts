/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_LOCAL_STORE_NAME,
  MANAGED_EXCHANGE_STORE_NAME,
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  getManagedExchange,
  listManagedExchanges,
  listManagedExchangesDiagnostic,
  markManagedBackupIfCurrent,
  openManagedExchangeDatabase,
  persistManagedExchangeReinvite,
  persistManagedExchangeRotation,
  putManagedExchange,
  readRecordAndMarkBackedUp,
  recordManagedExchangeLastRun,
  replaceManagedExchangeFromImport,
} from "@psi/managed/managedExchangeStore";
import {
  ManagedImportChosenCopyError,
  ManagedImportLiveCopyError,
  importManagedExchange,
} from "@psi/managed/managedExchangeImport";
import {
  appendDisclosureRecordToStore,
  readDisclosureAccounting,
} from "@psi/disclosureAccountingStore";
import {
  composeManagedExchangeFile,
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  importManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import {
  getManagedLocalState,
  listManagedLocalState,
  markManagedExchangeBackedUp,
  markManagedExchangeImported,
  markManagedExchangeKeyImported,
} from "@psi/managed/managedLocalState";
import { deriveManagedFailureTier } from "@psi/managed/managedFailureTiers";
import { exportManagedBackup } from "@psi/managed/managedExchangeExport";
import { failedRun } from "@psi/managed/managedRunRotate";
import { managedRunFailureFromRecord } from "@recurring/managedRunLaunchModel";
import { savedExchangeRows } from "@recurring/savedExchangesModel";
import { withManagedExchangeLock } from "@psi/managed/managedExchangeLock";

import { disclosureRecord } from "../utils/disclosureFixtures";

import type {
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedExportDeps } from "@psi/managed/managedExchangeExport";
import type { WebRTCExchangeLocator } from "@alcove/core";

/** A stored record narrowed to the runnable shape these fixtures all have: every
 * record here is created with a shared secret, and the export, hand-off, and run
 * paths take the record type that holds one. */
async function createRunnableExchange(
  fields: Parameters<typeof createManagedExchange>[0],
): Promise<RunnableManagedExchangeRecord> {
  return runnableManagedExchangeOrRefuse(await createManagedExchange(fields));
}

// The store-backed export/import and local sibling state, exercised against real
// Chromium (real IndexedDB and the sibling object store). The pure encode/parse and
// derivation are unit-tested without a database; this suite proves an export/import
// round-trip installs against the real store, a backup export writes the marker
// alone, the backup and import markers persist beside the record, a record this
// build cannot parse is skipped rather than failing an import (as is a sibling
// entry it cannot parse), and a delete leaves no sibling entry behind.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

/** A record's document as minting writes it, stating its format version. */
function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: {
      formatVersion: 1,
      ...composeManagedExchangeFile({
        connection: webrtcLocator,
        linkageTerms,
      }),
    },
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
});

describe("export/import round-trip against the real store", () => {
  test("an import installs a new owner minus the handle", async () => {
    const source = await createRunnableExchange(
      newExchange({ tokenMaxAgeDays: 90 }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );

    // Simulate an eviction: the source is gone, and the operator imports.
    await deleteManagedExchange(source.id);
    expect(await listManagedExchanges()).toEqual([]);

    const { record: installed } = await importManagedExchange(bytes);
    // A fresh id, the same secret and terms, no handle.
    expect(installed.id).not.toBe(source.id);
    expect(installed.sharedSecret).toBe(source.sharedSecret);
    expect(installed.exchangeFile).toEqual(source.exchangeFile);
    expect(installed).not.toHaveProperty("workingDirectoryHandle");
    // It is the one owner in the store.
    const all = await listManagedExchanges();
    expect(all.map((r) => r.id)).toEqual([installed.id]);
    // The import marks it backed-up, so it shows green immediately.
    const local = await getManagedLocalState(installed.id);
    expect(local?.backup).toBeDefined();
  });

  test("an older record without a format version comes back stating version 1", async () => {
    const older = composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    });
    expect(older).not.toHaveProperty("formatVersion");
    const source = await createRunnableExchange(
      newExchange({ exchangeFile: older }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    await deleteManagedExchange(source.id);

    const { record: installed } = await importManagedExchange(bytes);
    expect(installed.exchangeFile).toEqual({ formatVersion: 1, ...older });
  });

  test("a malformed import leaves the store untouched", async () => {
    const existing = await createRunnableExchange(newExchange());
    await expect(importManagedExchange("not json {{{")).rejects.toThrow();
    // The pre-existing record is untouched and no new record was written.
    const all = await listManagedExchanges();
    expect(all.map((r) => r.id)).toEqual([existing.id]);
  });
});

describe("the backup marker persists beside the record", () => {
  test("marking backed-up flips the list's derived backup state to green", async () => {
    const record = await createRunnableExchange(newExchange());
    const before = savedExchangeRows(
      [record],
      await listManagedLocalState(),
      Date.now(),
    );
    expect(before[0].backup.kind).toBe("backup-needed");

    await markManagedExchangeBackedUp(record.id, new Date().toISOString());
    const after = savedExchangeRows(
      [record],
      await listManagedLocalState(),
      Date.now(),
    );
    expect(after[0].backup.kind).toBe("backed-up");
  });

  test("a marker the reader would reject is refused before it is written", async () => {
    const record = await createRunnableExchange(newExchange());
    await markManagedExchangeImported(record.id, "2026-07-14T12:00:00.000Z");
    const before = await getManagedLocalState(record.id);
    const unreadable = {
      kind: "folder",
      folderName: "",
      fileName: "alcove-backup-Riverbend-quarterly-2026-07-14T130000Z.json",
    } as const;

    await expect(
      markManagedBackupIfCurrent(
        record.id,
        record.sharedSecret,
        "2026-07-14T13:00:00.000Z",
        unreadable,
      ),
    ).rejects.toThrow();

    expect(await getManagedLocalState(record.id)).toEqual(before);
    expect(
      (await listManagedLocalState()).get(record.id)?.imported,
    ).toBeDefined();
  });
});

describe("the import marker is the restore evidence the desync tiering reads", () => {
  test("an import stamps importedAt beside the record, out of the artifact", async () => {
    const source = await createRunnableExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    // The artifact contains no import marker (a sibling, never in the export).
    expect(bytes).not.toMatch(/importedAt/);

    await deleteManagedExchange(source.id);
    const { record: installed } = await importManagedExchange(bytes);
    const local = await getManagedLocalState(installed.id);
    // Both markers are stamped: the restore evidence and the current-backup marker.
    expect(local?.imported).toBeDefined();
    expect(local?.backup).toBeDefined();
  });

  test("a rotation consumes the import marker (a completed handshake proves sync)", async () => {
    const record = await createRunnableExchange(newExchange());
    await markManagedExchangeImported(record.id, new Date().toISOString());
    expect((await getManagedLocalState(record.id))?.imported).toBeDefined();

    // A successful run rotates the secret, clearing the import (and backup) marker in
    // the same cross-store transaction.
    await persistManagedExchangeRotation(record.id, record.sharedSecret, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    const local = await getManagedLocalState(record.id);
    expect(local?.imported).toBeUndefined();
    expect(local?.backup).toBeUndefined();
  });

  test("an auth failure on a freshly imported record tiers as imported, not unexplained", async () => {
    const source = await createRunnableExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    await deleteManagedExchange(source.id);
    const { record: installed } = await importManagedExchange(bytes);

    // The first run after the import fails closed. Its bookkeeping is recorded as auth.
    await recordManagedExchangeLastRun(
      installed.id,
      failedRun(Date.now(), "failed", "auth"),
      Date.now(),
    );
    const [record, local] = [
      await getManagedExchange(installed.id),
      await getManagedLocalState(installed.id),
    ];
    // The record's own evidence (an import not yet run-through) explains the failure:
    // the benign imported tier, never the attack path.
    expect(deriveManagedFailureTier(record!, local, Date.now())).toBe(
      "imported",
    );
  });
});

describe("an unattended run's failure shows through the same tiers at the next visit", () => {
  test("a stored auth failure with no benign evidence is treated as the unexplained tier", async () => {
    const record = await createRunnableExchange(newExchange());
    // An unattended run failed closed and recorded auth -- nothing else explains it.
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(Date.now(), "failed", "auth"),
      Date.now(),
    );
    const reloaded = await getManagedExchange(record.id);
    const local = await getManagedLocalState(record.id);
    const failure = managedRunFailureFromRecord(reloaded!, local, Date.now());
    expect(failure?.kind).toBe("unexplained");
    expect(failure?.recovery).toBe("confirm");
  });

  test("a stored storage failure is treated as the benign storage tier at the next visit", async () => {
    const record = await createRunnableExchange(newExchange());
    await recordManagedExchangeLastRun(
      record.id,
      failedRun(Date.now(), "failed", "storage"),
      Date.now(),
    );
    const reloaded = await getManagedExchange(record.id);
    const local = await getManagedLocalState(record.id);
    const failure = managedRunFailureFromRecord(reloaded!, local, Date.now());
    expect(failure?.kind).toBe("storage");
    expect(failure?.recovery).toBe("reinvite");
  });
});

describe("the export binds the marker to the bytes it serialized", () => {
  // The call sites a real export drives against the live store: read-and-mark
  // atomically, then download the bytes read. The download is captured so the
  // test can inspect the exact bytes the marker attests.
  function exportDeps(): ManagedExportDeps & { downloaded: Array<string> } {
    const downloaded: Array<string> = [];
    return {
      downloaded,
      readAndMark: readRecordAndMarkBackedUp,
      download: (_fileName, content) => downloaded.push(content),
      now: () => new Date(),
    };
  }

  test("the post-run completion export contains the ROTATED secret, not the mount-time one", async () => {
    const record = await createRunnableExchange(newExchange());
    const original = record.sharedSecret;
    // Simulate a run: the rotation persist advances the stored secret (and clears any
    // marker) exactly as runManagedExchange's persist-before-success write does.
    const rotated = generateSharedSecret();
    await persistManagedExchangeRotation(record.id, record.sharedSecret, {
      sharedSecret: rotated,
      expires: null,
    });

    // The completion surface exports by id (never a stale React snapshot of the
    // pre-rotation record), so it serializes the rotated secret the store now holds.
    const deps = exportDeps();
    await exportManagedBackup(record.id, deps);
    const { record: restored } = importManagedExchangeArtifact(
      deps.downloaded[0],
    );
    expect(restored.sharedSecret).toBe(rotated);
    expect(restored.sharedSecret).not.toBe(original);

    // And the exchange shows green against the rotated store.
    const rows = savedExchangeRows(
      await listManagedExchanges(),
      await listManagedLocalState(),
      Date.now(),
    );
    expect(rows[0].backup.kind).toBe("backed-up");
  });

  test("a rotation stales the marker even when the run then fails in the data exchange", async () => {
    const record = await createRunnableExchange(newExchange());
    // Take a backup: green.
    await exportManagedBackup(record.id, exportDeps());
    expect(
      savedExchangeRows(
        await listManagedExchanges(),
        await listManagedLocalState(),
        Date.now(),
      )[0].backup.kind,
    ).toBe("backed-up");

    // A run rotates and persists, THEN the data exchange fails: the rotation cleared
    // the marker in its own transaction, and a failed lastRun does not restore it.
    await persistManagedExchangeRotation(record.id, record.sharedSecret, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    await recordManagedExchangeLastRun(
      record.id,
      {
        at: new Date().toISOString(),
        outcome: "failed",
        failureKind: "transport",
      },
      Date.now(),
    );

    expect(await getManagedLocalState(record.id)).toBeUndefined();
    expect(
      savedExchangeRows(
        await listManagedExchanges(),
        await listManagedLocalState(),
        Date.now(),
      )[0].backup.kind,
    ).toBe("backup-needed");
  });

  test("a stale-tab export cannot mark green over a newer rotation", async () => {
    const record = await createRunnableExchange(newExchange());
    // Another context rotates the secret (and clears the marker).
    const rotated = generateSharedSecret();
    await persistManagedExchangeRotation(record.id, record.sharedSecret, {
      sharedSecret: rotated,
      expires: null,
    });

    // A stale tab holding the pre-rotation record exports. Because the export reads
    // and marks atomically by id, it serializes the ROTATED secret and marks that --
    // it structurally cannot stamp a marker over a secret it did not serialize.
    const deps = exportDeps();
    await exportManagedBackup(record.id, deps);
    const { record: restored } = importManagedExchangeArtifact(
      deps.downloaded[0],
    );
    expect(restored.sharedSecret).toBe(rotated);
    expect(await getManagedExchange(record.id)).toMatchObject({
      sharedSecret: rotated,
    });
  });

  test("a backup export marks green, writes only its backup marker, and leaves the record runnable", async () => {
    const record = await createRunnableExchange(newExchange());
    const before = await getManagedExchange(record.id);

    await exportManagedBackup(record.id, exportDeps());

    const local = await getManagedLocalState(record.id);
    expect(local?.backup).toBeDefined();
    expect(Object.keys(local ?? {})).toEqual(["backup"]);
    const stored = await getManagedExchange(record.id);
    expect(stored).toEqual(before);
    expect(
      stored === undefined
        ? undefined
        : runnableManagedExchangeOrRefuse(stored).sharedSecret,
    ).toBe(record.sharedSecret);
  });

  test("a backup export while a run holds the lock marks the secret it read, and the run's rotation clears that marker", async () => {
    const record = await createRunnableExchange(newExchange());
    const deps = exportDeps();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await new Promise<void>((granted) => {
      void withManagedExchangeLock(record.id, () => {
        granted();
        return held;
      });
    });
    try {
      await exportManagedBackup(record.id, deps);
      expect(
        importManagedExchangeArtifact(deps.downloaded[0]).record.sharedSecret,
      ).toBe(record.sharedSecret);
      expect((await getManagedLocalState(record.id))?.backup).toBeDefined();

      await persistManagedExchangeRotation(record.id, record.sharedSecret, {
        sharedSecret: generateSharedSecret(),
        expires: null,
      });
      expect(await getManagedLocalState(record.id)).toBeUndefined();
    } finally {
      release();
    }
  });
});

describe("a backup restores the exchange it holds", () => {
  test("a backup export marks the record and its file restores the exchange", async () => {
    // The export the indicator is about, end to end against the real store: it marks
    // the record green, and the bytes it wrote bring the exchange back after the
    // eviction the marker promises they cover.
    const source = await createRunnableExchange(newExchange());
    const deps = {
      downloaded: [] as Array<string>,
      fileNames: [] as Array<string>,
      readAndMark: readRecordAndMarkBackedUp,
      download: (fileName: string, content: string) => {
        deps.fileNames.push(fileName);
        deps.downloaded.push(content);
      },
      now: () => new Date(),
    };
    await exportManagedBackup(source.id, deps);
    expect((await getManagedLocalState(source.id))?.backup?.savedAs).toEqual({
      kind: "downloaded",
      fileName: deps.fileNames[0],
    });

    await deleteManagedExchange(source.id);
    const { record: restored } = await importManagedExchange(
      deps.downloaded[0],
    );
    expect(restored.sharedSecret).toBe(source.sharedSecret);
    expect(restored.exchangeFile).toEqual(source.exchangeFile);
  });

  test("importing over a LIVE secret-match refuses, writing nothing", async () => {
    const source = await createRunnableExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportAlreadyHeldError",
      label: source.label,
    });
    expect(await listManagedExchanges()).toEqual([source]);
    expect(await getManagedLocalState(source.id)).toBeUndefined();
  });
});

describe("a backup reconciles per exchange, whatever else is listed", () => {
  /** A backup of `record` taken now, before any later rotation. */
  function backupOf(record: RunnableManagedExchangeRecord): string {
    return serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(record),
    );
  }

  test("an exchange this browser does not hold is added as new beside the others", async () => {
    const listed = await createRunnableExchange(newExchange());
    const other = runnableManagedExchangeOrRefuse({
      ...listed,
      side: "acceptor",
      sharedSecret: generateSharedSecret(),
    });

    const { record } = await importManagedExchange(backupOf(other));

    expect(record.id).not.toBe(listed.id);
    expect((await listManagedExchanges()).map((r) => r.id).sort()).toEqual(
      [listed.id, record.id].sort(),
    );
  });

  test("a live copy rotated past the backup is named, and nothing is written", async () => {
    const live = await createRunnableExchange(newExchange());
    const bytes = backupOf(live);
    await persistManagedExchangeRotation(live.id, live.sharedSecret, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    const before = await listManagedExchanges();

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportLiveCopyError",
      copies: [{ id: live.id, label: live.label }],
    });
    expect(await listManagedExchanges()).toEqual(before);
    expect(await getManagedLocalState(live.id)).toBeUndefined();
  });

  test("confirmed, the backup installs beside the copy it named", async () => {
    const live = await createRunnableExchange(newExchange());
    const bytes = backupOf(live);
    await persistManagedExchangeRotation(live.id, live.sharedSecret, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    const before = await getManagedExchange(live.id);

    const { record } = await importManagedExchange(bytes, undefined, {
      besideIds: [live.id],
    });

    expect(record.id).not.toBe(live.id);
    expect(await getManagedExchange(live.id)).toEqual(before);
    expect(await listManagedExchanges()).toHaveLength(2);
  });

  test("two copies are named together, and one confirm installs beside both", async () => {
    const live = await createRunnableExchange(newExchange());
    const second = await createRunnableExchange(
      newExchange({ label: "Riverbend again" }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(
        runnableManagedExchangeOrRefuse({
          ...live,
          sharedSecret: generateSharedSecret(),
        }),
      ),
    );

    const asked: unknown = await importManagedExchange(bytes).catch(
      (error: unknown) => error,
    );
    expect(asked).toBeInstanceOf(ManagedImportLiveCopyError);
    expect((asked as ManagedImportLiveCopyError).copies).toHaveLength(2);
    expect((asked as ManagedImportLiveCopyError).copies).toEqual(
      expect.arrayContaining([
        { id: live.id, label: live.label, state: "runs-here" },
        { id: second.id, label: second.label, state: "runs-here" },
      ]),
    );
    expect(await listManagedExchanges()).toHaveLength(2);

    const { record } = await importManagedExchange(bytes, undefined, {
      besideIds: [live.id, second.id],
    });

    expect((await listManagedExchanges()).map(({ id }) => id).sort()).toEqual(
      [live.id, second.id, record.id].sort(),
    );
  });

  test("a confirm naming one copy does not pass over a second", async () => {
    const live = await createRunnableExchange(newExchange());
    const second = await createRunnableExchange(
      newExchange({ label: "Riverbend again" }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(
        runnableManagedExchangeOrRefuse({
          ...live,
          sharedSecret: generateSharedSecret(),
        }),
      ),
    );

    await expect(
      importManagedExchange(bytes, undefined, { besideIds: [live.id] }),
    ).rejects.toMatchObject({
      name: "ManagedImportLiveCopyError",
      copies: [{ id: second.id, label: second.label }],
    });
    expect(await listManagedExchanges()).toHaveLength(2);
  });
});

describe("a backup replaces the saved copy it is chosen for", () => {
  const RAN_HERE = "2026-07-01T09:00:00.000Z";
  const RAN_ELSEWHERE = "2026-07-08T09:00:00.000Z";

  /** A saved copy that last ran here, holding an accounting entry, and a
   * backup of the same exchange that ran on another device since: its secret
   * rotated there, and its last run is the later one. */
  async function staleCopyAndNewerBackup(): Promise<{
    stale: RunnableManagedExchangeRecord;
    newer: RunnableManagedExchangeRecord;
    bytes: string;
  }> {
    const created = await createRunnableExchange(newExchange());
    await recordManagedExchangeLastRun(
      created.id,
      { at: RAN_HERE, outcome: "succeeded" },
      Date.parse(RAN_HERE),
    );
    await appendDisclosureRecordToStore(created.id, await disclosureRecord());
    const ran = await getManagedExchange(created.id);
    if (ran === undefined) throw new Error("the saved copy was not stored");
    const stale = runnableManagedExchangeOrRefuse(ran);
    const newer = runnableManagedExchangeOrRefuse({
      ...stale,
      sharedSecret: generateSharedSecret(),
      lastRun: { at: RAN_ELSEWHERE, outcome: "succeeded" },
      recentRuns: [
        { at: RAN_ELSEWHERE, outcome: "succeeded" },
        { at: RAN_HERE, outcome: "succeeded" },
      ],
    });
    return {
      stale,
      newer,
      bytes: serializeManagedExchangeArtifact(
        encodeManagedExchangeArtifact(newer),
      ),
    };
  }

  test("a stale copy is replaced in place: one entry, runnable, its history and accounting kept", async () => {
    const { stale, newer, bytes } = await staleCopyAndNewerBackup();
    const accountingBefore = await readDisclosureAccounting(stale.id);

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportLiveCopyError",
      copies: [{ id: stale.id, label: stale.label }],
    });
    const { record } = await importManagedExchange(bytes, undefined, {
      into: stale.id,
    });

    expect(record.id).toBe(stale.id);
    expect(record.sharedSecret).toBe(newer.sharedSecret);
    expect(runnableManagedExchange(record)).toBe(true);
    expect(await listManagedExchanges()).toEqual([record]);
    expect(record.lastRun?.at).toBe(RAN_ELSEWHERE);
    expect(record.recentRuns?.map(({ at }) => at)).toEqual([
      RAN_ELSEWHERE,
      RAN_HERE,
    ]);
    expect(await readDisclosureAccounting(stale.id)).toEqual(accountingBefore);
    const local = await getManagedLocalState(stale.id);
    expect(local?.backup).toBeDefined();
    expect(local?.imported).toBeDefined();
  });

  test("a configuration-only copy is named as one, and replaced leaves one runnable entry", async () => {
    const configured = await createManagedExchange(
      newExchange({ sharedSecret: undefined }),
    );
    const backup = runnableManagedExchangeOrRefuse({
      ...configured,
      sharedSecret: generateSharedSecret(),
    });
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(backup),
    );

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportLiveCopyError",
      copies: [
        {
          id: configured.id,
          label: configured.label,
          state: "configuration-only",
        },
      ],
    });
    const { record } = await importManagedExchange(bytes, undefined, {
      into: configured.id,
    });

    expect(record.id).toBe(configured.id);
    expect(record.sharedSecret).toBe(backup.sharedSecret);
    expect(runnableManagedExchange(record)).toBe(true);
    expect(await listManagedExchanges()).toEqual([record]);
  });

  test("the same backup imported again is refused as held, and nothing changes", async () => {
    const { stale, bytes } = await staleCopyAndNewerBackup();
    await importManagedExchange(bytes, undefined, { into: stale.id });
    const after = await listManagedExchanges();

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportAlreadyHeldError",
      label: stale.label,
    });
    await expect(
      importManagedExchange(bytes, undefined, { into: stale.id }),
    ).rejects.toMatchObject({ name: "ManagedImportAlreadyHeldError" });
    expect(await listManagedExchanges()).toEqual(after);
  });

  test("an older backup is asked about as the older one when the saved copy's history holds its secret", async () => {
    const { stale: live, bytes: newer } = await staleCopyAndNewerBackup();
    // A backup taken before the saved copy rotated here: the older one.
    const older = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(live),
    );
    await persistManagedExchangeRotation(live.id, live.sharedSecret, {
      sharedSecret: generateSharedSecret(),
      expires: null,
    });
    const kept = await getManagedExchange(live.id);

    const olderAsked = await importManagedExchange(older).catch(
      (error: unknown) => error,
    );
    const newerAsked = await importManagedExchange(newer).catch(
      (error: unknown) => error,
    );
    expect(olderAsked).toBeInstanceOf(ManagedImportLiveCopyError);
    expect(newerAsked).toBeInstanceOf(ManagedImportLiveCopyError);
    expect((olderAsked as ManagedImportLiveCopyError).copies).toEqual([
      expect.objectContaining({ id: live.id, order: "import-older" }),
    ]);
    // The newer backup's secret is one the saved copy never held, so the
    // record cannot order it.
    const newerCopies = (newerAsked as ManagedImportLiveCopyError).copies;
    expect(newerCopies).toEqual([expect.objectContaining({ id: live.id })]);
    expect(newerCopies[0]).not.toHaveProperty("order");

    // Keeping the saved copy is answering nothing: it stands as it was.
    expect(await getManagedExchange(live.id)).toEqual(kept);
    expect(await getManagedLocalState(live.id)).toBeUndefined();
  });

  test("a backup neither copy's history can order against the saved one is asked about with no order", async () => {
    const { stale: live, bytes: unrelated } = await staleCopyAndNewerBackup();
    const asked = await importManagedExchange(unrelated).catch(
      (error: unknown) => error,
    );

    expect(asked).toBeInstanceOf(ManagedImportLiveCopyError);
    const copies = (asked as ManagedImportLiveCopyError).copies;
    expect(copies).toEqual([expect.objectContaining({ id: live.id })]);
    expect(copies[0]).not.toHaveProperty("order");
  });

  test("a replace while the exchange's run holds its lock writes nothing", async () => {
    const { stale, bytes } = await staleCopyAndNewerBackup();

    let refusal: unknown;
    await withManagedExchangeLock(stale.id, async () => {
      refusal = await importManagedExchange(bytes, undefined, {
        into: stale.id,
      }).catch((error: unknown) => error);
    });

    expect(refusal).toBeInstanceOf(ManagedImportChosenCopyError);
    expect((refusal as ManagedImportChosenCopyError).reason).toBe(
      "run-in-flight",
    );
    expect(await listManagedExchanges()).toEqual([stale]);
    expect(await getManagedLocalState(stale.id)).toBeUndefined();
  });

  test("a chosen copy deleted or moved to other terms since is refused as changed", async () => {
    const { stale, bytes } = await staleCopyAndNewerBackup();
    await putManagedExchange({ ...stale, side: "acceptor" });

    await expect(
      importManagedExchange(bytes, undefined, { into: stale.id }),
    ).rejects.toMatchObject({
      name: "ManagedImportChosenCopyError",
      reason: "changed",
    });

    await deleteManagedExchange(stale.id);
    await expect(
      importManagedExchange(bytes, undefined, { into: stale.id }),
    ).rejects.toMatchObject({
      name: "ManagedImportChosenCopyError",
      reason: "changed",
    });
    expect(await listManagedExchanges()).toEqual([]);
  });

  test("the store's replace re-checks terms and side inside its transaction", async () => {
    const { stale, newer } = await staleCopyAndNewerBackup();
    const elsewhere = runnableManagedExchangeOrRefuse({
      ...newer,
      side: "acceptor",
    });

    expect(
      await replaceManagedExchangeFromImport(
        stale.id,
        stale.sharedSecret,
        new Date().toISOString(),
        elsewhere,
        "backup",
      ),
    ).toEqual({ kind: "changed" });
    expect(await getManagedExchange(stale.id)).toEqual(stale);
  });

  test("the store's replace re-checks the secret it writes over inside its transaction", async () => {
    // The secret the chosen copy held when the import decided to replace it: a
    // re-invite landing since stored another, and the replace writes nothing.
    const { stale, newer } = await staleCopyAndNewerBackup();
    const reinvited = generateSharedSecret();
    await persistManagedExchangeReinvite(stale.id, stale.sharedSecret, {
      sharedSecret: reinvited,
      expires: null,
      signalingServer: { host: "signaling.example.org" },
    });
    const before = await getManagedExchange(stale.id);

    expect(
      await replaceManagedExchangeFromImport(
        stale.id,
        stale.sharedSecret,
        new Date().toISOString(),
        newer,
        "backup",
      ),
    ).toEqual({ kind: "changed" });
    expect(await getManagedExchange(stale.id)).toEqual(before);
    expect(await getManagedExchange(stale.id)).toMatchObject({
      sharedSecret: reinvited,
    });
  });
});

/** Plant an invalid record under `id`, keeping every other field of `fields`, so a
 * test stages a damaged record. Bypasses the validating
 * write, as no supported path stores one. */
async function plantUnreadable(id: string, fields: object): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_STORE_NAME,
        "readwrite",
      );
      transaction
        .objectStore(MANAGED_EXCHANGE_STORE_NAME)
        .put({
          ...fields,
          id,
          schemaVersion: "alcove-managed-exchange/damaged",
        });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Plant a sibling entry this build's schema refuses under `id`: a handed-off
 * state an earlier version wrote, which the current shape no longer names.
 * Bypasses the validating write, as no supported path stores one. */
async function plantUnreadableSibling(id: string): Promise<void> {
  const db = await openManagedExchangeDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        MANAGED_EXCHANGE_LOCAL_STORE_NAME,
        "readwrite",
      );
      transaction.objectStore(MANAGED_EXCHANGE_LOCAL_STORE_NAME).put(
        {
          spent: {
            spentAt: "2026-07-14T13:00:00.000Z",
            handoff: "command-line",
          },
        },
        id,
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

describe("a record this build cannot parse is skipped, not fatal to the import", () => {
  /** The stored keys the diagnostic read reports as unreadable -- what an operator
   * still has to discard after an import from the read-failed state. */
  async function unreadableIds(): Promise<Array<string>> {
    const entries = await listManagedExchangesDiagnostic();
    return entries.flatMap((entry) =>
      entry.kind === "unreadable" ? [entry.id] : [],
    );
  }

  test("an unrelated import lands beside an invalid record and a valid one", async () => {
    // The read-failed state an operator meets: one record this build cannot parse,
    // beside a valid record. The artifact is a third exchange's, so the import has
    // nothing to reconcile -- and the invalid record must not refuse it, which is
    // the way forward the surface offers.
    const other = await createRunnableExchange(
      newExchange({ label: "Other partnership", side: "acceptor" }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(other),
    );
    await deleteManagedExchange(other.id);
    const listed = await createRunnableExchange(
      newExchange({ label: "Listed partnership" }),
    );
    await plantUnreadable("zzz-bad-record", {
      ...listed,
      sharedSecret: generateSharedSecret(),
    });
    // Precondition: the attended list read rejects wholesale, so this is the state
    // the read-failed recovery surface renders from.
    await expect(listManagedExchanges()).rejects.toThrow();

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.sharedSecret).toBe(other.sharedSecret);
    expect(installed.label).toBe("Other partnership");
    // The invalid record is left in place and still reported, for the operator to
    // discard from the recovery listing.
    expect(await unreadableIds()).toEqual(["zzz-bad-record"]);
    // The valid record is untouched by the import beside it.
    expect(await getManagedExchange(listed.id)).toEqual(listed);
    expect(await getManagedLocalState(listed.id)).toBeUndefined();
  });

  test("a skipped record holding the artifact's secret matches nothing, and the import lands", async () => {
    // A secret match needs a record this build can parse: the skipped one takes no
    // part in the reconciliation, so it is left for the operator to discard.
    const stored = await createRunnableExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(stored),
    );
    await plantUnreadable(stored.id, stored);

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.id).not.toBe(stored.id);
    expect(installed.sharedSecret).toBe(stored.sharedSecret);
    expect(await unreadableIds()).toEqual([stored.id]);
  });
});

describe("a local-state entry this build cannot parse is skipped too", () => {
  test("an unrelated import lands beside one", async () => {
    // The second way into the read-failed surface: one sibling entry this build
    // cannot parse. The artifact is another exchange's, so nothing stored holds
    // its secret and the import must land -- which is the way forward that
    // surface offers.
    const other = await createRunnableExchange(
      newExchange({ label: "Other partnership", side: "acceptor" }),
    );
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(other),
    );
    await deleteManagedExchange(other.id);
    const stranded = await createRunnableExchange(
      newExchange({ label: "Saved state unreadable" }),
    );
    await plantUnreadableSibling(stranded.id);
    // Precondition: the attended load joins the sibling state and rejects wholesale
    // on that entry, so this is the state the read-failed surface renders from.
    await expect(listManagedLocalState()).rejects.toThrow();

    const { record: installed } = await importManagedExchange(bytes);

    expect(installed.sharedSecret).toBe(other.sharedSecret);
    expect(installed.label).toBe("Other partnership");
    // The stored record is untouched, and the unreadable entry is left for the
    // operator to discard.
    expect(await getManagedExchange(stranded.id)).toEqual(stranded);
    await expect(listManagedLocalState()).rejects.toThrow();
  });

  test("a record holding the artifact's secret refuses as held, naming its unreadable state", async () => {
    // The entry does not decide the refusal: the record holds the secret, so it
    // is the same exchange. It decides the copy, since that page cannot open.
    const stored = await createRunnableExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(stored),
    );
    await plantUnreadableSibling(stored.id);

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportAlreadyHeldError",
      label: "Riverbend quarterly",
      stateUnreadable: true,
    });

    // Nothing was written: the stored record stands alone, with no second copy,
    // listed with its essentials and its state marked unreadable.
    expect(await listManagedExchangesDiagnostic()).toEqual([
      {
        kind: "readable",
        essentials: {
          id: stored.id,
          label: "Riverbend quarterly",
          side: "inviter",
        },
        backedUp: true,
        stateUnreadable: true,
      },
    ]);
  });

  test("a record holding the artifact's secret beside a readable entry refuses as plainly held", async () => {
    const stored = await createRunnableExchange(newExchange());
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(stored),
    );
    await markManagedExchangeBackedUp(stored.id, new Date().toISOString());

    await expect(importManagedExchange(bytes)).rejects.toMatchObject({
      name: "ManagedImportAlreadyHeldError",
      stateUnreadable: false,
    });
  });
});

describe("delete leaves no sibling state behind", () => {
  test("deleting a record removes its backup and import markers", async () => {
    const record = await createRunnableExchange(newExchange());
    await markManagedExchangeBackedUp(record.id, new Date().toISOString());
    await markManagedExchangeKeyImported(record.id, new Date().toISOString());
    expect(await getManagedLocalState(record.id)).toBeDefined();

    await deleteManagedExchange(record.id);

    expect(await getManagedExchange(record.id)).toBeUndefined();
    expect(await getManagedLocalState(record.id)).toBeUndefined();
    expect((await listManagedLocalState()).size).toBe(0);
  });
});
