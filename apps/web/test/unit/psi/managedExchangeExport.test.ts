import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assembleExchangeSpec,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";

import {
  backUpManagedExchangeToFolder,
  exportManagedBackup,
  exportManagedCronFiles,
  managedBackupFileName,
} from "@psi/managed/managedExchangeExport";
import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import { importManagedExchangeArtifact } from "@psi/managed/managedExchangeArtifact";

import {
  removeBackupFromWorkingFolder,
  writeBackupToWorkingFolder,
} from "@psi/managed/managedWorkingDirectory";
import { automaticBackupOnMarker } from "@psi/managed/managedBackupState";

import type {
  ManagedBackupLocation,
  ManagedBackupMarker,
  ManagedFolderBackupLocation,
} from "@psi/managed/managedBackupState";
import type {
  ManagedCronExportDeps,
  ManagedExportDeps,
  ManagedFolderBackupDeps,
} from "@psi/managed/managedExchangeExport";
import type { HandlePermissionQuery } from "@psi/managed/managedInputHandle";
import type { ManagedBackupMarkOutcome } from "@psi/managed/managedExchangeStore";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { OwnRelayRead } from "@psi/transport/ownRelaySetting";

// The export intents, tested in Node with injected dependencies. Every export
// reads the record fresh rather than trusting a caller's copy. The backup
// export serializes and marks atomically (readAndMark), so what it serializes
// is what the marker attests; the command-line export takes a plain read and
// has no store write to call at all. Neither takes the run lock.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function record(): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
  });
}

/** The name every backup of {@link record} taken at 2026-07-14T12:00:00Z takes,
 * downloaded or written into the working folder. */
const BACKUP_NAME = "alcove-backup-Riverbend-quarterly-2026-07-14T120000Z.json";

function backupDeps(rec: ManagedExchangeRecord): ManagedExportDeps & {
  downloaded: Array<{ fileName: string; content: string }>;
  readAndMark: ReturnType<typeof vi.fn>;
  savedAs: Array<ManagedBackupLocation>;
  order: Array<string>;
} {
  const downloaded: Array<{ fileName: string; content: string }> = [];
  const savedAs: Array<ManagedBackupLocation> = [];
  const order: Array<string> = [];
  return {
    downloaded,
    savedAs,
    order,
    // The atomic read-compose-and-mark: hands the fresh record to the export's own
    // composition, then marks it saved where the composition says, as the store's
    // step does. It is the only write among these deps, and it writes the marker.
    readAndMark: vi.fn(
      (
        _id: string,
        _backedUpAt: string,
        composeExport: (read: ManagedExchangeRecord) => ManagedBackupLocation,
      ) => {
        order.push("readAndMark");
        savedAs.push(composeExport(rec));
        return Promise.resolve(rec);
      },
    ),
    download: (fileName, content) => {
      order.push("download");
      downloaded.push({ fileName, content });
    },
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  };
}

describe("managedBackupFileName", () => {
  test("names the file by the exchange's label and the UTC instant to the second", () => {
    expect(
      managedBackupFileName(
        "Riverbend quarterly",
        new Date("2026-07-14T09:05:03.250Z"),
      ),
    ).toBe("alcove-backup-Riverbend-quarterly-2026-07-14T090503Z.json");
  });

  test("reduces the label as the results file name does", () => {
    expect(
      managedBackupFileName(
        "  County/Health: Q3 (draft)  ",
        new Date("2026-07-14T09:05:03.000Z"),
      ),
    ).toBe("alcove-backup-County-Health-Q3-draft-2026-07-14T090503Z.json");
  });

  test("leaves out a label that reduces to nothing, with its hyphen", () => {
    expect(
      managedBackupFileName("***", new Date("2026-07-14T09:05:03.000Z")),
    ).toBe("alcove-backup-2026-07-14T090503Z.json");
  });
});

describe("exportManagedBackup", () => {
  test("reads-and-marks the record and downloads exactly those bytes", async () => {
    const rec = record();
    const deps = backupDeps(rec);
    const result = await exportManagedBackup(rec.id, deps);

    expect(deps.downloaded).toHaveLength(1);
    expect(deps.readAndMark).toHaveBeenCalledWith(
      rec.id,
      "2026-07-14T12:00:00.000Z",
      expect.any(Function),
    );
    // The marker records the name the file was downloaded under, which states
    // the label of the record read.
    expect(deps.savedAs).toEqual([
      { kind: "downloaded", fileName: BACKUP_NAME },
    ]);
    expect(deps.downloaded[0].fileName).toBe(BACKUP_NAME);
    // The result threads the one clock read, the name, and the record exported.
    expect(result.backedUpAt.toISOString()).toBe("2026-07-14T12:00:00.000Z");
    expect(result.fileName).toBe(BACKUP_NAME);
    expect(result.record).toBe(rec);
  });

  test("the marker attests the secret the downloaded file has", async () => {
    const rec = record();
    const deps = backupDeps(rec);
    await exportManagedBackup(rec.id, deps);
    // The bytes downloaded re-import to the secret readAndMark returned -- the same
    // secret the marker was stamped against, not a stale React snapshot.
    const { record: restored } = importManagedExchangeArtifact(
      deps.downloaded[0].content,
    );
    expect(restored.sharedSecret).toBe(rec.sharedSecret);
  });

  test("a step that marks without serializing is refused, not downloaded", async () => {
    // The binding is only as good as the step honoring it, so a dependency that
    // resolves having skipped the serialization fails the export rather than
    // downloading bytes no marker attests.
    const rec = record();
    const deps = {
      ...backupDeps(rec),
      readAndMark: () => Promise.resolve(rec),
    };

    await expect(exportManagedBackup(rec.id, deps)).rejects.toThrow(
      /without serializing the export/,
    );
    expect(deps.downloaded).toEqual([]);
  });

  test("leaves the stored record unchanged and runnable", async () => {
    const rec = record();
    const before = structuredClone(rec);
    const deps = backupDeps(rec);

    await exportManagedBackup(rec.id, deps);

    expect(rec).toEqual(before);
    expect(runnableManagedExchangeOrRefuse(rec).sharedSecret).toBe(
      before.sharedSecret,
    );
    // The one write is the backup marker; nothing records a hand-off.
    expect(deps.savedAs).toEqual([
      { kind: "downloaded", fileName: BACKUP_NAME },
    ]);
  });

  test("reads and marks, then downloads", async () => {
    const rec = record();
    const deps = backupDeps(rec);
    await exportManagedBackup(rec.id, deps);
    expect(deps.order).toEqual(["readAndMark", "download"]);
  });
});

describe("exportManagedCronFiles", () => {
  /** The record shapes the command-line composition refuses, each with the part of
   * its refusal this dispatch must propagate. None is composable through the app --
   * they reach a record by importing a hand-crafted artifact, which the composer's
   * own suite pins -- so what is measured here is the export's effect on the
   * record when the composition throws. */
  const refusedRecords: Array<[string, () => ManagedExchangeRecord, RegExp]> = [
    [
      "a connection field outside the locator subset",
      () =>
        buildManagedExchangeRecord({
          label: "Riverbend quarterly",
          exchangeFile: assembleExchangeSpec({
            connection: {
              channel: "webrtc",
              server: { host: "signaling.example.org" },
              turn: [
                {
                  url: "turn:relay.example.org:3478",
                  username: "operator",
                  credential: "@/home/other/turn-credential",
                },
              ],
            },
            linkageTerms,
          }),
          side: "inviter",
          sharedSecret: generateSharedSecret(),
        }),
      /to the command line: turn\./,
    ],
    [
      "an authentication block on the stored document",
      () => {
        const rec = record();
        return {
          ...rec,
          exchangeFile: {
            ...rec.exchangeFile,
            authentication: {
              sharedSecret: generateSharedSecret(),
              expires: "2026-04-06T14:00:00.000Z",
            },
          },
        };
      },
      /authentication block/,
    ],
  ];

  function cronDeps(rec: ManagedExchangeRecord): ManagedCronExportDeps & {
    downloaded: Array<{ fileName: string; content: string; mimeType: string }>;
    order: Array<string>;
    readRecord: ReturnType<typeof vi.fn>;
  } {
    const order: Array<string> = [];
    const downloaded: Array<{
      fileName: string;
      content: string;
      mimeType: string;
    }> = [];
    return {
      downloaded,
      order,
      // The plain read this export takes: the deps hold no store write, so
      // nothing in this export can mark, spend, or otherwise change the record.
      readRecord: vi.fn((_id: string) => {
        order.push("read");
        return Promise.resolve<ManagedExchangeRecord | undefined>(rec);
      }),
      download: (fileName, content, mimeType) => {
        order.push("download");
        downloaded.push({ fileName, content, mimeType });
      },
      readOwn: () => ({ kind: "none" }),
    };
  }

  test("downloads both CLI files from a fresh read", async () => {
    const rec = record();
    const deps = cronDeps(rec);
    const composed = await exportManagedCronFiles(rec.id, deps);

    expect(deps.downloaded.map((file) => file.fileName)).toEqual([
      "alcove.yaml",
      ".alcove.key",
    ]);
    expect(deps.readRecord).toHaveBeenCalledWith(rec.id);
    expect(composed.command).toBe(
      "alcove exchange --log-file=exchange.log input.csv ./",
    );
  });

  test("leaves the stored record unchanged and runnable", async () => {
    const rec = record();
    const before = structuredClone(rec);
    const deps = cronDeps(rec);

    const composed = await exportManagedCronFiles(rec.id, deps);

    expect(rec).toEqual(before);
    expect(runnableManagedExchangeOrRefuse(rec).sharedSecret).toBe(
      before.sharedSecret,
    );
    // The key file holds the secret the stored record still holds.
    expect(composed.key.text).toContain(before.sharedSecret);
  });

  test("composes against the relay settings read it is given, the one the panel composed with", async () => {
    const ownTurn = "turns:relay.example.org:443?transport=tcp";
    const rec = {
      ...record(),
      relayRegistrar: {
        url: "https://relay.example.org:8443",
        exchangeId: "riverbend-q3",
      },
    };
    const panelRead: OwnRelayRead = {
      kind: "set",
      relay: { turn: [ownTurn], stun: [] },
    };
    const deps = { ...cronDeps(rec), readOwn: () => panelRead };

    const composed = await exportManagedCronFiles(rec.id, deps);

    expect(composed.config.text).toContain(`url: ${ownTurn}`);
    expect(deps.downloaded[0].content).toBe(composed.config.text);
  });

  test("reads, then downloads both files", async () => {
    const rec = record();
    const deps = cronDeps(rec);
    await exportManagedCronFiles(rec.id, deps);
    expect(deps.order).toEqual(["read", "download", "download"]);
  });

  test("a record gone from the store downloads nothing", async () => {
    const rec = record();
    const deps = {
      ...cronDeps(rec),
      readRecord: () =>
        Promise.resolve<ManagedExchangeRecord | undefined>(undefined),
    };

    await expect(exportManagedCronFiles(rec.id, deps)).rejects.toThrow(
      /no managed exchange with id/,
    );
    expect(deps.downloaded).toEqual([]);
  });

  test.each(refusedRecords)(
    "a refused record downloads nothing and leaves the record untouched (%s)",
    async (_shape, build, refusal) => {
      const rec = build();
      const before = structuredClone(rec);
      const deps = cronDeps(rec);

      await expect(exportManagedCronFiles(rec.id, deps)).rejects.toThrow(
        refusal,
      );
      // The composition refuses before anything leaves the app: no bytes, and
      // the record the read returned still equals its snapshot.
      expect(deps.downloaded).toEqual([]);
      expect(rec).toEqual(before);
    },
  );
});

describe("backUpManagedExchangeToFolder", () => {
  const BACKED_UP_AT = "2026-07-14T12:00:00.000Z";

  /** A permission layer reporting a fixed state, recording whether it was asked
   * to prompt, which a run with nobody present may never do. */
  function fakePermission(state: "granted" | "denied" | "prompt") {
    const seam = {
      requested: false,
      query: () => Promise.resolve(state),
      request: () => {
        seam.requested = true;
        return Promise.resolve(state);
      },
    };
    return seam as typeof seam & HandlePermissionQuery;
  }

  /** A granted folder built to the calls the write makes: a lookup without
   * `create` for whether the name is held, one with it for the entry written,
   * and the writable the bytes go through. `holding` maps the names it already
   * has to their contents; `failWrite` makes the stream refuse the bytes, and
   * `failRemove` the folder refuse a removal. */
  function fakeFolder(
    options: {
      holding?: Record<string, string>;
      failWrite?: Error;
      failRemove?: Error;
      name?: string;
    } = {},
  ) {
    const files = new Map(Object.entries(options.holding ?? {}));
    const handle = {
      name: options.name ?? "Riverbend exchange",
      getFileHandle: (fileName: string, lookup?: { create?: boolean }) => {
        if (lookup?.create !== true && !files.has(fileName))
          return Promise.reject(
            new DOMException("no such entry", "NotFoundError"),
          );
        if (!files.has(fileName)) files.set(fileName, "");
        return Promise.resolve({
          createWritable: () =>
            Promise.resolve({
              write: async (blob: Blob) => {
                if (options.failWrite !== undefined) throw options.failWrite;
                files.set(fileName, await blob.text());
              },
              close: () => Promise.resolve(),
              abort: () => Promise.resolve(),
            }),
        });
      },
      removeEntry: (fileName: string) => {
        if (options.failRemove !== undefined)
          return Promise.reject(options.failRemove);
        files.delete(fileName);
        return Promise.resolve();
      },
    };
    return { files, handle: handle as unknown as FileSystemDirectoryHandle };
  }

  /** The decision's boundaries over the real folder write and removal: the
   * record the store holds after the run, the folder calls through
   * `permission`, and a checked mark answering `markOutcome`. */
  function folderBackupDeps(
    stored: ManagedExchangeRecord | undefined,
    permission: HandlePermissionQuery,
    markOutcome: ManagedBackupMarkOutcome = "marked",
  ) {
    const markIfCurrent = vi.fn(() => Promise.resolve(markOutcome));
    const deps: ManagedFolderBackupDeps = {
      readRecord: () => Promise.resolve(stored),
      writeToFolder: (rec, fileName, content) =>
        writeBackupToWorkingFolder(rec, fileName, content, permission),
      removeFromFolder: (rec, fileName) =>
        removeBackupFromWorkingFolder(rec, fileName, permission),
      markIfCurrent,
      now: () => new Date(BACKED_UP_AT),
    };
    return { deps, markIfCurrent };
  }

  /** What the manual backup downloads for `rec` at the same instant. */
  async function manualBackup(rec: ManagedExchangeRecord) {
    const manual = backupDeps(rec);
    await exportManagedBackup(rec.id, manual);
    return manual.downloaded[0];
  }

  beforeEach(() => {
    // The feature detection a stored grant is followed on; Node has no File
    // System Access API of its own.
    vi.stubGlobal("FileSystemDirectoryHandle", class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a granted folder takes the manual backup's bytes under the exchange's label, and the marker is stamped without a prompt", async () => {
    const folder = fakeFolder();
    const rec = { ...record(), workingDirectoryHandle: folder.handle };
    const permission = fakePermission("granted");
    const { deps, markIfCurrent } = folderBackupDeps(rec, permission);

    const backup = await backUpManagedExchangeToFolder(rec.id, deps);

    expect(backup).toEqual({
      kind: "backed-up",
      fileName: BACKUP_NAME,
      directoryName: "Riverbend exchange",
      backedUpAt: new Date(BACKED_UP_AT),
    });
    // The same bytes the manual backup downloads, under the same name a
    // download at that instant takes.
    const manual = await manualBackup(rec);
    expect(manual.fileName).toBe(BACKUP_NAME);
    expect(folder.files.get(BACKUP_NAME)).toBe(manual.content);
    expect(markIfCurrent).toHaveBeenCalledWith(
      rec.id,
      rec.sharedSecret,
      BACKED_UP_AT,
      {
        kind: "folder",
        folderName: "Riverbend exchange",
        fileName: BACKUP_NAME,
      },
    );
    expect(permission.requested).toBe(false);
  });

  test("a folder name outside the stored bound is left off the marker, which is still stamped", async () => {
    // The marker's reader rejects a name outside 1-255 code units, so storing
    // one would leave the exchange's local state unreadable on this device.
    for (const name of ["x".repeat(256), ""]) {
      const folder = fakeFolder({ name });
      const rec = { ...record(), workingDirectoryHandle: folder.handle };
      const { deps, markIfCurrent } = folderBackupDeps(
        rec,
        fakePermission("granted"),
      );

      expect(await backUpManagedExchangeToFolder(rec.id, deps)).toEqual({
        kind: "backed-up",
        fileName: BACKUP_NAME,
        directoryName: name,
        backedUpAt: new Date(BACKED_UP_AT),
      });
      expect(markIfCurrent).toHaveBeenCalledWith(
        rec.id,
        rec.sharedSecret,
        BACKED_UP_AT,
        { kind: "folder", fileName: BACKUP_NAME },
      );
    }
  });

  test("a grant that would need the operator's gesture writes nothing, prompts for nothing, and stamps nothing", async () => {
    for (const state of ["prompt", "denied"] as const) {
      const folder = fakeFolder();
      const rec = { ...record(), workingDirectoryHandle: folder.handle };
      const permission = fakePermission(state);
      const { deps, markIfCurrent } = folderBackupDeps(rec, permission);

      expect(await backUpManagedExchangeToFolder(rec.id, deps)).toEqual({
        kind: "ungranted",
        state,
      });
      expect(folder.files.size).toBe(0);
      expect(markIfCurrent).not.toHaveBeenCalled();
      expect(permission.requested).toBe(false);
    }
  });

  test("an exchange holding no folder grant writes nothing and stamps nothing", async () => {
    const rec = record();
    const { deps, markIfCurrent } = folderBackupDeps(
      rec,
      fakePermission("granted"),
    );

    expect(await backUpManagedExchangeToFolder(rec.id, deps)).toEqual({
      kind: "no-folder",
    });
    expect(markIfCurrent).not.toHaveBeenCalled();
  });

  test("a record whose secret a re-invite replaced after the run stored its own writes nothing and stamps nothing", async () => {
    const folder = fakeFolder();
    const rec = { ...record(), workingDirectoryHandle: folder.handle };
    const { deps, markIfCurrent } = folderBackupDeps(
      rec,
      fakePermission("granted"),
    );

    expect(
      await backUpManagedExchangeToFolder(
        rec.id,
        deps,
        undefined,
        generateSharedSecret(),
      ),
    ).toEqual({ kind: "secret-changed" });
    expect(folder.files.size).toBe(0);
    expect(markIfCurrent).not.toHaveBeenCalled();
  });

  test("a write the folder refuses is reported, stamps nothing, and does not reject", async () => {
    const refusal = new Error("the disk is full");
    const folder = fakeFolder({ failWrite: refusal });
    const rec = { ...record(), workingDirectoryHandle: folder.handle };
    const { deps, markIfCurrent } = folderBackupDeps(
      rec,
      fakePermission("granted"),
    );

    expect(await backUpManagedExchangeToFolder(rec.id, deps)).toEqual({
      kind: "write-failed",
      error: refusal,
    });
    expect(folder.files.has(BACKUP_NAME)).toBe(false);
    expect(markIfCurrent).not.toHaveBeenCalled();
  });

  test("a file already held under the backup's name is left as it is", async () => {
    // A download saved into the folder by hand, or another exchange sharing the
    // folder, may have taken the same name in the same second.
    const folder = fakeFolder({ holding: { [BACKUP_NAME]: "another backup" } });
    const rec = { ...record(), workingDirectoryHandle: folder.handle };
    const { deps, markIfCurrent } = folderBackupDeps(
      rec,
      fakePermission("granted"),
    );

    expect(await backUpManagedExchangeToFolder(rec.id, deps)).toEqual({
      kind: "name-held",
      fileName: BACKUP_NAME,
    });
    expect(folder.files.get(BACKUP_NAME)).toBe("another backup");
    expect(markIfCurrent).not.toHaveBeenCalled();
  });

  describe("replacing the previous automatic backup", () => {
    const EARLIER_NAME =
      "alcove-backup-Riverbend-quarterly-2026-07-07T120000Z.json";
    const EARLIER: ManagedFolderBackupLocation = {
      kind: "folder",
      folderName: "Riverbend exchange",
      fileName: EARLIER_NAME,
    };

    test("two runs a second apart leave only the newer backup, which the marker names", async () => {
      const folder = fakeFolder();
      const stored = { ...record(), workingDirectoryHandle: folder.handle };
      const permission = fakePermission("granted");
      let marker: ManagedBackupMarker | undefined;
      let clock = new Date("2026-07-14T12:00:00.000Z");
      const deps: ManagedFolderBackupDeps = {
        readRecord: () => Promise.resolve(stored),
        writeToFolder: (rec, fileName, content) =>
          writeBackupToWorkingFolder(rec, fileName, content, permission),
        removeFromFolder: (rec, fileName) =>
          removeBackupFromWorkingFolder(rec, fileName, permission),
        markIfCurrent: (_id, expectedSharedSecret, backedUpAt, savedAs) => {
          if (stored.sharedSecret !== expectedSharedSecret)
            return Promise.resolve("superseded");
          marker = { backedUpAt, savedAs };
          return Promise.resolve("marked");
        },
        now: () => clock,
      };

      const first = await backUpManagedExchangeToFolder(stored.id, deps);
      // The run reads the marker before its rotation clears it.
      const previous = automaticBackupOnMarker(marker);
      stored.sharedSecret = generateSharedSecret();
      clock = new Date("2026-07-14T12:00:01.000Z");
      const second = await backUpManagedExchangeToFolder(
        stored.id,
        deps,
        previous,
      );

      const firstName = BACKUP_NAME;
      const secondName =
        "alcove-backup-Riverbend-quarterly-2026-07-14T120001Z.json";
      expect(first).toMatchObject({ kind: "backed-up", fileName: firstName });
      expect(second).toMatchObject({
        kind: "backed-up",
        fileName: secondName,
        previous: { kind: "removed", fileName: firstName },
      });
      expect([...folder.files.keys()]).toEqual([secondName]);
      expect(
        importManagedExchangeArtifact(folder.files.get(secondName) ?? "").record
          .sharedSecret,
      ).toBe(stored.sharedSecret);
      expect(marker).toEqual({
        backedUpAt: "2026-07-14T12:00:01.000Z",
        savedAs: {
          kind: "folder",
          folderName: "Riverbend exchange",
          fileName: secondName,
        },
      });
    });

    test("a backup saved by hand is never removed, whatever its name", async () => {
      // A download and a folder backup share one name pattern, so only the
      // marker tells the previous folder backup apart from the rest.
      const handSaved = {
        "alcove-backup-Riverbend-quarterly-2026-07-01T090000Z.json":
          "a downloaded backup",
        "alcove-backup-Riverbend-quarterly-2026-06-30T120000Z.json":
          "an automatic backup the marker no longer names",
        "riverbend-keep.json": "a copy kept by hand",
      };
      const folder = fakeFolder({
        holding: { ...handSaved, [EARLIER_NAME]: "the previous backup" },
      });
      const rec = { ...record(), workingDirectoryHandle: folder.handle };
      const { deps } = folderBackupDeps(rec, fakePermission("granted"));

      expect(
        await backUpManagedExchangeToFolder(rec.id, deps, EARLIER),
      ).toMatchObject({
        kind: "backed-up",
        previous: { kind: "removed", fileName: EARLIER_NAME },
      });
      expect([...folder.files.keys()].sort()).toEqual(
        [...Object.keys(handSaved), BACKUP_NAME].sort(),
      );
      for (const [name, content] of Object.entries(handSaved))
        expect(folder.files.get(name)).toBe(content);
    });

    test("with no automatic backup on the marker, nothing is removed", async () => {
      const folder = fakeFolder({
        holding: { [EARLIER_NAME]: "a file under an automatic name" },
      });
      const rec = { ...record(), workingDirectoryHandle: folder.handle };
      const { deps } = folderBackupDeps(rec, fakePermission("granted"));
      const removeFromFolder = vi.spyOn(deps, "removeFromFolder");

      for (const marker of [
        undefined,
        { backedUpAt: BACKED_UP_AT },
        {
          backedUpAt: BACKED_UP_AT,
          savedAs: { kind: "downloaded" as const, fileName: EARLIER_NAME },
        },
      ])
        expect(automaticBackupOnMarker(marker)).toBeUndefined();
      expect(await backUpManagedExchangeToFolder(rec.id, deps)).toEqual({
        kind: "backed-up",
        fileName: BACKUP_NAME,
        directoryName: "Riverbend exchange",
        backedUpAt: new Date(BACKED_UP_AT),
      });
      expect(removeFromFolder).not.toHaveBeenCalled();
      expect(folder.files.has(EARLIER_NAME)).toBe(true);
    });

    test("a write that fails leaves the previous backup in place", async () => {
      for (const failure of [
        { failWrite: new Error("the disk is full") },
        { holding: { [BACKUP_NAME]: "another exchange's backup" } },
      ]) {
        const folder = fakeFolder({
          ...failure,
          holding: {
            ...failure.holding,
            [EARLIER_NAME]: "the previous backup",
          },
        });
        const rec = { ...record(), workingDirectoryHandle: folder.handle };
        const { deps, markIfCurrent } = folderBackupDeps(
          rec,
          fakePermission("granted"),
        );
        const removeFromFolder = vi.spyOn(deps, "removeFromFolder");

        const backup = await backUpManagedExchangeToFolder(
          rec.id,
          deps,
          EARLIER,
        );

        expect(["write-failed", "name-held"]).toContain(backup.kind);
        expect(folder.files.get(EARLIER_NAME)).toBe("the previous backup");
        expect(removeFromFolder).not.toHaveBeenCalled();
        expect(markIfCurrent).not.toHaveBeenCalled();
      }
    });

    test("a previous backup recorded in another folder, or in none named, is left", async () => {
      for (const previous of [
        { ...EARLIER, folderName: "Last year's exchange" },
        { kind: "folder" as const, fileName: EARLIER_NAME },
      ]) {
        const folder = fakeFolder({
          holding: { [EARLIER_NAME]: "a file under the recorded name" },
        });
        const rec = { ...record(), workingDirectoryHandle: folder.handle };
        const { deps } = folderBackupDeps(rec, fakePermission("granted"));

        expect(
          await backUpManagedExchangeToFolder(rec.id, deps, previous),
        ).toMatchObject({
          kind: "backed-up",
          previous: { kind: "other-folder", fileName: EARLIER_NAME },
        });
        expect(folder.files.has(EARLIER_NAME)).toBe(true);
      }
    });

    test("a removal the folder refuses is reported, and the new backup still counts", async () => {
      const refusal = new Error("the folder is read-only");
      const folder = fakeFolder({
        holding: { [EARLIER_NAME]: "the previous backup" },
        failRemove: refusal,
      });
      const rec = { ...record(), workingDirectoryHandle: folder.handle };
      const { deps, markIfCurrent } = folderBackupDeps(
        rec,
        fakePermission("granted"),
      );

      expect(
        await backUpManagedExchangeToFolder(rec.id, deps, EARLIER),
      ).toEqual({
        kind: "backed-up",
        fileName: BACKUP_NAME,
        directoryName: "Riverbend exchange",
        backedUpAt: new Date(BACKED_UP_AT),
        previous: {
          kind: "remove-failed",
          error: refusal,
          fileName: EARLIER_NAME,
        },
      });
      expect(markIfCurrent).toHaveBeenCalledTimes(1);
      expect(folder.files.has(BACKUP_NAME)).toBe(true);
    });

    test("a previous backup already gone from the folder is reported as absent", async () => {
      const folder = fakeFolder();
      const rec = { ...record(), workingDirectoryHandle: folder.handle };
      const { deps } = folderBackupDeps(rec, fakePermission("granted"));

      expect(
        await backUpManagedExchangeToFolder(rec.id, deps, EARLIER),
      ).toMatchObject({
        kind: "backed-up",
        previous: { kind: "absent", fileName: EARLIER_NAME },
      });
      expect([...folder.files.keys()]).toEqual([BACKUP_NAME]);
    });
  });

  test("a secret that moved on after the write leaves the marker unstamped", async () => {
    const folder = fakeFolder();
    const rec = { ...record(), workingDirectoryHandle: folder.handle };
    const { deps } = folderBackupDeps(
      rec,
      fakePermission("granted"),
      "superseded",
    );

    expect(await backUpManagedExchangeToFolder(rec.id, deps)).toEqual({
      kind: "superseded",
      fileName: BACKUP_NAME,
      directoryName: "Riverbend exchange",
    });
  });

  test("a record that is gone, or holds no secret to back up, is reported rather than thrown", async () => {
    const gone = folderBackupDeps(undefined, fakePermission("granted"));
    expect(await backUpManagedExchangeToFolder("gone", gone.deps)).toEqual({
      kind: "failed",
      error: expect.any(Error),
    });

    const folder = fakeFolder();
    const { sharedSecret: _withheld, ...configOnly } = {
      ...record(),
      workingDirectoryHandle: folder.handle,
    };
    const held = folderBackupDeps(configOnly, fakePermission("granted"));
    expect(
      await backUpManagedExchangeToFolder(configOnly.id, held.deps),
    ).toMatchObject({ kind: "failed" });
    expect(folder.files.size).toBe(0);
    expect(held.markIfCurrent).not.toHaveBeenCalled();
  });
});
