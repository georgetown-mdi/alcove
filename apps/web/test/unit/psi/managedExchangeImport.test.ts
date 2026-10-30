import { describe, expect, test, vi } from "vitest";

import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
  snakeizeKeys,
} from "@alcove/core";

import { stringify as stringifyYaml } from "yaml";

import {
  ManagedImportAlreadyHeldError,
  ManagedImportLiveCopyError,
  importManagedExchange,
  importManagedExchangeFile,
  managedInstallFields,
} from "@psi/managed/managedExchangeImport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import { composeManagedCronExport } from "@psi/managed/managedCronExport";

import type {
  ManagedBackupReconcileOutcome,
  ManagedReplaceOutcome,
} from "@psi/managed/managedExchangeStore";
import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedImportDeps } from "@psi/managed/managedExchangeImport";
import type { ManagedStoredCopy } from "@psi/managed/managedPairRecognition";

/** A record built from `fields` and narrowed to the runnable shape: every fixture
 * here is built with a shared secret, and the export paths take the record type
 * that holds one. */
function runnableRecord(
  fields: NewManagedExchange,
): RunnableManagedExchangeRecord {
  return runnableManagedExchangeOrRefuse(buildManagedExchangeRecord(fields));
}

// The backup import, tested in Node with injected dependencies: a valid
// artifact installs and is marked imported-and-backed-up; a stored record
// holding its secret refuses the import; a malformed or tampered file
// is rejected before any install, so the store is left untouched. Each import
// also reports which of the source's device-local grants the imported record
// does not hold. The store-backed install (real IndexedDB) is the browser suite's.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function goodBytes(): string {
  const record = runnableRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
  return serializeManagedExchangeArtifact(
    encodeManagedExchangeArtifact(record),
  );
}

/** A record holding the device-local working-folder grant, or none. */
function recordHolding(grants: {
  workingFolder?: boolean;
}): RunnableManagedExchangeRecord {
  return runnableRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...(grants.workingFolder === true
      ? {
          workingDirectoryHandle: {
            name: "work",
          } as FileSystemDirectoryHandle,
        }
      : {}),
  });
}

/** A backup of a record that held the device-local working folder. */
function grantedBytes(): string {
  return serializeManagedExchangeArtifact(
    encodeManagedExchangeArtifact(recordHolding({ workingFolder: true })),
  );
}

/** A backup of a record that WAS scheduled and did hold a working folder: the
 * artifact holds the schedule, and the handle is a device-local platform
 * object no artifact can hold. */
function scheduledBytes(): string {
  const record = runnableRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    workingDirectoryHandle: {} as FileSystemDirectoryHandle,
    schedule: {
      anchor: "2026-01-06T14:00:00.000Z",
      intervalDays: 7,
      windowSeconds: 10_800,
      nextWindow: "2026-01-06T14:00:00.000Z",
      consecutiveMisses: 0,
    },
  });
  return serializeManagedExchangeArtifact(
    encodeManagedExchangeArtifact(record),
  );
}

function recordingDeps(
  reconciled: ManagedBackupReconcileOutcome = { kind: "no-match" },
  replaced: ManagedReplaceOutcome = { kind: "changed" },
): ManagedImportDeps & {
  installed: Array<ManagedExchangeRecord>;
  reconcile: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  markImported: ReturnType<typeof vi.fn>;
} {
  const installed: Array<ManagedExchangeRecord> = [];
  return {
    installed,
    reconcile: vi.fn(() => Promise.resolve(reconciled)),
    replace: vi.fn(() => Promise.resolve(replaced)),
    install: (record) => {
      installed.push(record);
      return Promise.resolve(record);
    },
    markImported: vi.fn(() => Promise.resolve()),
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  };
}

describe("importManagedExchange", () => {
  test("installs the reconstructed record and marks it imported and backed-up", async () => {
    const deps = recordingDeps();
    const { record: installed } = await importManagedExchange(
      goodBytes(),
      deps,
    );
    expect(deps.reconcile).toHaveBeenCalledOnce();
    expect(deps.installed).toHaveLength(1);
    expect(deps.markImported).toHaveBeenCalledWith(
      installed.id,
      "2026-07-14T12:00:00.000Z",
    );
  });

  test("a marker-write failure after a fresh install still reports success", async () => {
    const deps = recordingDeps();
    deps.markImported.mockRejectedValueOnce(new Error("marker write failed"));
    const { record: installed } = await importManagedExchange(
      goodBytes(),
      deps,
    );
    // The record is durable; a best-effort marker failure must not fail the import
    // (a retry would duplicate it).
    expect(deps.installed).toHaveLength(1);
    expect(installed).toBe(deps.installed[0]);
  });

  test("the installed record has no working-folder handle", async () => {
    const deps = recordingDeps();
    const { record: installed } = await importManagedExchange(
      grantedBytes(),
      deps,
    );
    expect(installed).not.toHaveProperty("workingDirectoryHandle");
  });

  test("has a backed-up schedule but still no handle, so no import can run unattended", async () => {
    // The converse of the deposit path (test/unit/exchange/manageOfferModel.test.ts,
    // which writes no schedule): an import can have a schedule and
    // reconstructs no handle, so neither path on its own assembles the pair the
    // unattended runner fires on. The source record here HELD a handle, so what
    // is asserted is that the round trip drops it rather than that there was
    // nothing to drop.
    const deps = recordingDeps();
    const { record: installed } = await importManagedExchange(
      scheduledBytes(),
      deps,
    );
    expect(installed.schedule).toMatchObject({
      nextWindow: "2026-01-06T14:00:00.000Z",
      intervalDays: 7,
    });
    expect(installed).not.toHaveProperty("workingDirectoryHandle");
  });

  test("a fresh install reports the grants the source held and it does not", async () => {
    const deps = recordingDeps();
    const { missingGrants } = await importManagedExchange(grantedBytes(), deps);
    // The handle does not serialize, so a fresh install holds none: the operator
    // is told at the import rather than by a scheduled run a window later.
    expect(missingGrants).toEqual(["working-folder"]);
  });

  test("an import of a source that held neither grant reports none", async () => {
    const deps = recordingDeps();
    const { missingGrants } = await importManagedExchange(goodBytes(), deps);
    expect(missingGrants).toEqual([]);
  });

  test("a malformed file installs nothing (store left untouched)", async () => {
    const deps = recordingDeps();
    await expect(importManagedExchange("not json {{{", deps)).rejects.toThrow();
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a tampered secret installs nothing", async () => {
    const deps = recordingDeps();
    const artifact = JSON.parse(goodBytes());
    artifact.key.sharedSecret = "not-a-secret";
    await expect(
      importManagedExchange(JSON.stringify(artifact), deps),
    ).rejects.toThrow();
    expect(deps.installed).toHaveLength(0);
  });
});

describe("a fresh install keeps what the backup holds", () => {
  test("a raised standing condition and the operator's response to it survive the install", async () => {
    // A backup restored on a new browser profile installs fresh. The condition
    // withholds the schedule and re-invite until the operator, a re-invite, or a
    // delete clears it, so the install must not be the act that clears it.
    const standingCondition = {
      since: "2026-07-01T14:00:00.000Z",
      kind: "auth",
      response: { kind: "compromise", at: "2026-07-01T15:00:00.000Z" },
    } as const;
    const source = runnableRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
      standingCondition,
    });
    const bytes = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(source),
    );
    const stored: Array<ManagedExchangeRecord> = [];
    const deps: ManagedImportDeps = {
      ...recordingDeps(),
      install: (record) => {
        const created = buildManagedExchangeRecord(
          managedInstallFields(record),
        );
        stored.push(created);
        return Promise.resolve(created);
      },
    };

    const { record } = await importManagedExchange(bytes, deps);

    expect(stored).toEqual([record]);
    expect(record.id).not.toBe(source.id);
    expect(record.standingCondition).toEqual(standingCondition);
  });

  test("a backup holding no condition installs with none", () => {
    const record = runnableRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
    });

    expect(managedInstallFields(record)).not.toHaveProperty(
      "standingCondition",
    );
    expect(
      buildManagedExchangeRecord(managedInstallFields(record))
        .standingCondition,
    ).toEqual(record.standingCondition);
  });
});

describe("importManagedExchangeFile routes by what the file is", () => {
  /** The `alcove.yaml` the app's own command-line export writes, which is the
   * file an operator brings back. */
  function configurationBytes(): string {
    return composeManagedCronExport(
      runnableRecord({
        label: "Riverbend quarterly",
        exchangeFile: composeManagedExchangeFile({
          connection: { channel: "webrtc", host: "signaling.example.org" },
          linkageTerms,
        }),
        side: "acceptor",
        sharedSecret: generateSharedSecret(),
      }),
    ).config.text;
  }

  test("a backup artifact takes the backup leg", async () => {
    const deps = recordingDeps();

    await importManagedExchangeFile(goodBytes(), deps);

    expect(deps.reconcile).toHaveBeenCalledOnce();
    expect(deps.installed).toHaveLength(1);
  });

  test("a command-line configuration installs a record holding no secret", async () => {
    const deps = recordingDeps();

    const { record, missingGrants } = await importManagedExchangeFile(
      configurationBytes(),
      deps,
    );

    expect(record.sharedSecret).toBeUndefined();
    expect(record.side).toBe("acceptor");
    expect(missingGrants).toEqual([]);
    expect(deps.installed).toHaveLength(1);
  });

  test("a configuration reconciles against nothing and marks nothing", async () => {
    // It brings no secret to match a stored record on, and no file it could be
    // restored from: neither the reconciliation nor the import marker has anything to
    // act on.
    const deps = recordingDeps();

    await importManagedExchangeFile(configurationBytes(), deps);

    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a configuration this app cannot hold installs nothing", async () => {
    const deps = recordingDeps();

    await expect(
      importManagedExchangeFile("channel: nonsense\n", deps),
    ).rejects.toThrow();
    expect(deps.installed).toHaveLength(0);
  });
});

describe("a backup reconciles against the exchange it holds", () => {
  test("a live copy holding its secret refuses, installing nothing", async () => {
    const deps = recordingDeps({ kind: "held", label: "Riverbend quarterly" });

    await expect(
      importManagedExchange(goodBytes(), deps),
    ).rejects.toBeInstanceOf(ManagedImportAlreadyHeldError);
    await expect(
      importManagedExchange(goodBytes(), deps),
    ).rejects.toMatchObject({ label: "Riverbend quarterly" });
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("live copies by terms and side are named together, installing nothing", async () => {
    const deps = recordingDeps({
      kind: "live-copy",
      copies: [
        { id: "listed-id", label: "Riverbend quarterly", state: "runs-here" },
        { id: "second-id", label: "", state: "runs-here" },
      ],
    });

    await expect(
      importManagedExchangeFile(goodBytes(), deps),
    ).rejects.toBeInstanceOf(ManagedImportLiveCopyError);
    await expect(
      importManagedExchangeFile(goodBytes(), deps),
    ).rejects.toMatchObject({
      copies: [
        { id: "listed-id", label: "Riverbend quarterly", state: "runs-here" },
        { id: "second-id", label: "", state: "runs-here" },
      ],
    });
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("the live copies carry the order the histories state against the backup", async () => {
    const copies: Array<ManagedStoredCopy> = [
      { id: "listed-id", label: "Riverbend quarterly", state: "runs-here" },
    ];
    const orderCopies = vi.fn((listed: ReadonlyArray<ManagedStoredCopy>) =>
      Promise.resolve(
        listed.map((copy) => ({ ...copy, order: "import-newer" as const })),
      ),
    );
    const deps = {
      ...recordingDeps({ kind: "live-copy", copies }),
      orderCopies,
    };
    const bytes = goodBytes();

    await expect(importManagedExchangeFile(bytes, deps)).rejects.toMatchObject({
      copies: [{ ...copies[0], order: "import-newer" }],
    });
    expect(orderCopies).toHaveBeenCalledWith(
      copies,
      expect.objectContaining({
        sharedSecret: JSON.parse(bytes).key.sharedSecret,
      }),
    );
    expect(deps.installed).toHaveLength(0);
  });

  test("a confirmed import passes the named records on as the ones to go beside", async () => {
    const deps = recordingDeps();

    await importManagedExchangeFile(goodBytes(), deps, {
      besideIds: ["listed-id", "second-id"],
    });

    expect(deps.reconcile).toHaveBeenCalledWith(expect.anything(), {
      besideIds: ["listed-id", "second-id"],
    });
    expect(deps.installed).toHaveLength(1);
  });

  test("a held record whose saved state does not parse is named as such", async () => {
    const deps = recordingDeps({
      kind: "held",
      label: "Riverbend quarterly",
      stateUnreadable: true,
    });

    await expect(
      importManagedExchange(goodBytes(), deps),
    ).rejects.toMatchObject({
      name: "ManagedImportAlreadyHeldError",
      stateUnreadable: true,
    });
    expect(deps.installed).toHaveLength(0);
  });

  test("a chosen record is replaced in place, installing nothing beside it", async () => {
    const stored = runnableRecord({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms,
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
    });
    const deps = recordingDeps(
      { kind: "replace", id: stored.id, sharedSecret: stored.sharedSecret },
      { kind: "replaced", record: stored },
    );

    const { record } = await importManagedExchangeFile(goodBytes(), deps, {
      into: stored.id,
    });

    expect(deps.reconcile).toHaveBeenCalledWith(expect.anything(), {
      into: stored.id,
    });
    expect(deps.replace).toHaveBeenCalledWith(
      stored.id,
      stored.sharedSecret,
      "2026-07-14T12:00:00.000Z",
      expect.anything(),
      "backup",
    );
    expect(record).toBe(stored);
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a replace a run or a change refuses installs nothing and says which", async () => {
    for (const reason of ["run-in-flight", "changed"] as const) {
      const deps = recordingDeps(
        { kind: "replace", id: "listed-id", sharedSecret: "listed-secret" },
        { kind: reason },
      );
      await expect(
        importManagedExchange(goodBytes(), deps, { into: "listed-id" }),
      ).rejects.toMatchObject({ name: "ManagedImportChosenCopyError", reason });
      expect(deps.installed).toHaveLength(0);
    }
    const gone = recordingDeps({ kind: "chosen-copy-changed" });
    await expect(
      importManagedExchange(goodBytes(), gone, { into: "listed-id" }),
    ).rejects.toMatchObject({
      name: "ManagedImportChosenCopyError",
      reason: "changed",
    });
    expect(gone.replace).not.toHaveBeenCalled();
    expect(gone.installed).toHaveLength(0);
  });

  test("a configuration on a channel this app does not run installs, reconciling nothing", async () => {
    const deps = recordingDeps();

    const { record } = await importManagedExchangeFile(
      stringifyYaml(
        snakeizeKeys(
          assembleExchangeSpec({
            connection: connectionFromLocator({
              channel: "filedrop",
              inboundPath: "/srv/exchange/inbound",
              outboundPath: "/srv/exchange/outbound",
              options: {
                retainFiles: true,
                timestampInFilename: true,
                locklessRendezvous: true,
              },
            }),
            linkageTerms,
          }),
        ),
      ),
      deps,
    );

    expect(record.exchangeFile.connection.channel).toBe("filedrop");
    expect(record.sharedSecret).toBeUndefined();
    expect(deps.reconcile).not.toHaveBeenCalled();
  });
});
