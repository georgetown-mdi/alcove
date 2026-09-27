/// <reference types="@vitest/browser-playwright/context" />
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assembleExchangeSpec,
  connectionFromLocator,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";

import {
  HandlePermissionError,
  MANAGED_INPUT_FILE_NAME,
  ManagedInputFileMissingError,
  acquireManagedInput,
  acquireValidatedManagedInput,
  ensureHandlePermission,
} from "@psi/managed/managedInputHandle";
import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  persistManagedExchangeWorkingDirectory,
} from "@psi/managed/managedExchangeStore";
import { ManagedInputError } from "@psi/managed/managedInputGuard";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { runManagedExchange } from "@psi/managed/managedExchangeRun";
import { storedWorkingDirectoryUsable } from "@psi/managed/managedWorkingDirectory";

import type { ExchangeSpec, WebRTCExchangeLocator } from "@alcove/core";
import type {
  HandlePermissionQuery,
  HandlePermissionState,
} from "@psi/managed/managedInputHandle";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// The platform half of the working folder's input read, exercised against real
// Chromium: reading the one conventioned name from a FileSystemDirectoryHandle
// at run start, the read-through-not-snapshot property, the benign missing-file
// and column-shape failures, and the run-seam composition (the input guard
// gating the handshake). The permission layer below is injected since an OPFS
// handle has no real queryPermission or requestPermission to exercise the
// non-granted and prompt cases.

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

// The standing terms an exchange over CONFORMING_HEADER's columns agreed: derived
// WITH that metadata, so the declared keys are the ones those columns support. The
// guard holds an input to every declared key, so terms derived without metadata
// (which keep the whole built-in set) would refuse the conforming file too.
const linkageTerms = getDefaultLinkageTerms(
  "County Health Dept",
  inferMetadata(["ssn", "first_name", "last_name", "date_of_birth"], []),
);

/** The standing exchange-file document a managed record persists. */
function standingExchangeFile(csvDelimiter?: string): ExchangeSpec {
  return assembleExchangeSpec({
    connection: connectionFromLocator(webrtcLocator),
    linkageTerms,
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  });
}

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: webrtcLocator,
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

const CONFORMING_HEADER = "ssn,first_name,last_name,date_of_birth\n";
const CONFORMING_ROW = "123456789,ADA,LOVELACE,01/01/1990\n";
const DRIFTED_CSV = "unrelated_a,unrelated_b\n1,2\n";

/** Make an origin-private-file-system folder named `name`, holding `input` as
 * its input file where given, and return its handle. OPFS handles are
 * structured-cloneable and support the lookups a run makes, so they stand in for
 * a picker handle for everything except the permission extension. */
async function opfsFolder(
  name: string,
  input?: string,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(name, { create: true });
  if (input !== undefined) await writeInput(folder, input);
  return folder;
}

/** Put `content` in `folder` under the conventioned input name, replacing what
 * stood there -- the operator's refresh between runs. */
async function writeInput(
  folder: FileSystemDirectoryHandle,
  content: string,
): Promise<void> {
  const handle = await folder.getFileHandle(MANAGED_INPUT_FILE_NAME, {
    create: true,
  });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

/** A permission seam that reports a fixed state and records whether it prompted,
 * so the unattended-never-prompts and attended-prompts paths can be asserted
 * against a handle that (being OPFS) implements no real permission extension. */
function fakePermission(
  queryState: HandlePermissionState,
  requestState: HandlePermissionState = "granted",
): HandlePermissionQuery & { requested: boolean } {
  const seam = {
    requested: false,
    query: () => Promise.resolve(queryState),
    request: () => {
      seam.requested = true;
      return Promise.resolve(requestState);
    },
  };
  return seam;
}

const OPFS_NAMES: Array<string> = [];
async function trackedFolder(
  name: string,
  input?: string,
): Promise<FileSystemDirectoryHandle> {
  OPFS_NAMES.push(name);
  return opfsFolder(name, input);
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
  const root = await navigator.storage.getDirectory();
  for (const name of OPFS_NAMES.splice(0)) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch {
      // Already gone (a test that removed the entry itself).
    }
  }
});

describe("storedWorkingDirectoryUsable", () => {
  test("a held folder is usable where the API exists", async () => {
    const folder = await trackedFolder("usable-folder");
    expect(storedWorkingDirectoryUsable(folder)).toBe(true);
  });

  test("no folder held is no usable folder", () => {
    expect(storedWorkingDirectoryUsable(undefined)).toBe(false);
  });
});

describe("read from the working folder at run start", () => {
  test("each run reads whatever file stands under the conventioned name", async () => {
    const folder = await trackedFolder(
      "managed-folder",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    const first = await acquireManagedInput({
      kind: "folder",
      directory: folder,
      attendance: "unattended",
    });
    expect(first.columns).toEqual([
      "ssn",
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
    // The parsed rows ride the same single parse as the columns, so the run
    // consumes the input without a second read.
    expect(first.rows).toEqual([
      {
        ssn: "123456789",
        first_name: "ADA",
        last_name: "LOVELACE",
        date_of_birth: "01/01/1990",
      },
    ]);

    // Put the next period's extract under the same name -- the data-refresh
    // workflow -- and the same folder yields the new contents, no re-selection.
    await writeInput(folder, "email_address\nada@example.org\n");

    const second = await acquireManagedInput({
      kind: "folder",
      directory: folder,
      attendance: "unattended",
    });
    expect(second.columns).toEqual(["email_address"]);
    expect(second.rows).toEqual([{ email_address: "ada@example.org" }]);
  });

  test("the header transform reaches the run's own read", async () => {
    // The managed run re-reads the operator's file at each run start, through a
    // real File the platform hands back. The names it acquires are the ones core's
    // parse boundary stripped, so a run keys on -- and sends -- the same names the
    // seat that authored the standing terms saw. Written as escapes, never as raw
    // bytes, so the source is readable.
    const RLO = "\u202e";
    const PDI = "\u2069";
    const folder = await trackedFolder(
      "managed-folder-bidi",
      `ssn,first_name,la${RLO}st_name${PDI},date_of_birth\n` + CONFORMING_ROW,
    );
    const acquired = await acquireManagedInput({
      kind: "folder",
      directory: folder,
      attendance: "unattended",
    });
    expect(acquired.columns).toEqual([
      "ssn",
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
    expect(acquired.rows).toEqual([
      {
        ssn: "123456789",
        first_name: "ADA",
        last_name: "LOVELACE",
        date_of_birth: "01/01/1990",
      },
    ]);
  });

  test("a folder without the input file fails as a benign acquire rejection naming both", async () => {
    const folder = await trackedFolder(
      "managed-folder-emptied",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    // Remove the input from the folder: the lookup now rejects with a
    // not-found, the clean missing-input state -- never a desync or attack.
    await folder.removeEntry(MANAGED_INPUT_FILE_NAME);

    const error: unknown = await acquireManagedInput({
      kind: "folder",
      directory: folder,
      attendance: "unattended",
    }).then(
      () => {
        throw new Error("the acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("acquire");
    expect((error as ManagedInputError).cause).toBeInstanceOf(
      ManagedInputFileMissingError,
    );
    expect((error as ManagedInputError).cause).toMatchObject({
      fileName: MANAGED_INPUT_FILE_NAME,
      folderName: "managed-folder-emptied",
    });
  });

  test("a folder under the input name is refused as a missing file", async () => {
    // What Chromium raises for a lookup naming a folder is the platform's own,
    // so it is driven here rather than assumed.
    const folder = await trackedFolder("managed-folder-mismatch");
    await folder.getDirectoryHandle(MANAGED_INPUT_FILE_NAME, { create: true });
    const error: unknown = await acquireManagedInput({
      kind: "folder",
      directory: folder,
      attendance: "unattended",
    }).then(
      () => {
        throw new Error("the acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect((error as ManagedInputError).cause).toBeInstanceOf(
      ManagedInputFileMissingError,
    );
  });
});

describe("acquireValidatedManagedInput: column-shape guard on each path", () => {
  test("accepts a conforming file read from the folder", async () => {
    const folder = await trackedFolder(
      "managed-folder-conforming",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    const acquired = await acquireValidatedManagedInput(
      standingExchangeFile(),
      {
        kind: "folder",
        directory: folder,
        attendance: "unattended",
      },
    );
    expect(acquired.columns[0]).toBe("ssn");
  });

  test("reads a run's input by the delimiter the stored document states", async () => {
    // The delimiter is a caret, outside the set the parse detects from, so the
    // columns satisfy the standing terms only because the stored value reached
    // the read -- what an unattended run depends on, with nobody to choose.
    const folder = await trackedFolder(
      "managed-folder-caret",
      "ssn^first_name^last_name^date_of_birth\n" +
        "123456789^ADA^LOVELACE^01/01/1990\n",
    );
    const acquired = await acquireValidatedManagedInput(
      standingExchangeFile("^"),
      { kind: "folder", directory: folder, attendance: "unattended" },
    );
    expect(acquired.columns).toEqual([
      "ssn",
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
    expect(acquired.rows).toEqual([
      {
        ssn: "123456789",
        first_name: "ADA",
        last_name: "LOVELACE",
        date_of_birth: "01/01/1990",
      },
    ]);
  });

  test("rejects a drifted file read from the folder (columns rejection)", async () => {
    const folder = await trackedFolder("drifted-folder", DRIFTED_CSV);
    const error: unknown = await acquireValidatedManagedInput(
      standingExchangeFile(),
      { kind: "folder", directory: folder, attendance: "unattended" },
    ).then(
      () => {
        throw new Error("the validated acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("columns");
  });

  test("rejects a drifted re-selected file (the no-API path)", async () => {
    // The re-selection path supplies a File directly rather than a folder; the
    // same column guard applies.
    const file = new File([DRIFTED_CSV], "drifted.csv", { type: "text/csv" });
    const error: unknown = await acquireValidatedManagedInput(
      standingExchangeFile(),
      { kind: "file", file },
    ).then(
      () => {
        throw new Error("the validated acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("columns");
  });

  test("accepts a conforming re-selected file", async () => {
    const file = new File([CONFORMING_HEADER + CONFORMING_ROW], "input.csv", {
      type: "text/csv",
    });
    const acquired = await acquireValidatedManagedInput(
      standingExchangeFile(),
      {
        kind: "file",
        file,
      },
    );
    expect(acquired.columns[0]).toBe("ssn");
  });
});

describe("permission layer (injected)", () => {
  test("the unattended path proceeds on an existing grant, never prompting", async () => {
    const handle = await trackedFolder("permission-folder", CONFORMING_HEADER);
    const permission = fakePermission("granted");
    await ensureHandlePermission(handle, "unattended", "read", permission);
    expect(permission.requested).toBe(false);
  });

  test("the unattended path fails on a non-granted state without prompting", async () => {
    const handle = await trackedFolder("permission-folder", CONFORMING_HEADER);
    const permission = fakePermission("prompt");
    await expect(
      ensureHandlePermission(handle, "unattended", "read", permission),
    ).rejects.toBeInstanceOf(HandlePermissionError);
    // A scheduled run has nobody to answer a prompt, so it must not request.
    expect(permission.requested).toBe(false);
  });

  test("the attended path prompts when the state is prompt and proceeds on grant", async () => {
    const handle = await trackedFolder("permission-folder", CONFORMING_HEADER);
    const permission = fakePermission("prompt", "granted");
    await ensureHandlePermission(handle, "attended", "read", permission);
    expect(permission.requested).toBe(true);
  });

  test("the attended path fails when the operator denies the prompt", async () => {
    const handle = await trackedFolder("permission-folder", CONFORMING_HEADER);
    const permission = fakePermission("prompt", "denied");
    await expect(
      ensureHandlePermission(handle, "attended", "read", permission),
    ).rejects.toBeInstanceOf(HandlePermissionError);
    expect(permission.requested).toBe(true);
  });

  test("a denied state fails the unattended acquire as a benign acquire rejection", async () => {
    const handle = await trackedFolder("permission-folder", CONFORMING_HEADER);
    const permission = fakePermission("denied");
    const error: unknown = await acquireManagedInput(
      { kind: "folder", directory: handle, attendance: "unattended" },
      permission,
    ).then(
      () => {
        throw new Error("the acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("acquire");
    expect((error as ManagedInputError).cause).toBeInstanceOf(
      HandlePermissionError,
    );
  });
});

describe("folder persistence and re-point", () => {
  test("no folder is persisted where none is supplied (the save-flow shape)", async () => {
    // The save flow takes no folder; the record has none until the operator
    // chooses one on the exchange's page.
    const created = await createManagedExchange(newExchange());
    expect(created.workingDirectoryHandle).toBeUndefined();
    expect(
      (await getManagedExchange(created.id))?.workingDirectoryHandle,
    ).toBeUndefined();
  });

  test("a granted folder persists, and a run reads its input through the stored copy", async () => {
    const created = await createManagedExchange(newExchange());
    const folder = await trackedFolder(
      "persisted-folder",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    await persistManagedExchangeWorkingDirectory(created.id, folder);
    const stored = await getManagedExchange(created.id);
    const directory = stored?.workingDirectoryHandle;
    expect(await directory?.isSameEntry(folder)).toBe(true);
    // The grant advanced only the folder; the secret and document are intact.
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
    expect(stored?.exchangeFile).toEqual(created.exchangeFile);

    // The structured-clone copy the store hands back resolves the name itself.
    if (directory === undefined) throw new Error("no folder was stored");
    const acquired = await acquireManagedInput({
      kind: "folder",
      directory,
      attendance: "unattended",
    });
    expect(acquired.columns[0]).toBe("ssn");
  });

  test("re-pointing to a new folder replaces the old one, and null drops it", async () => {
    const first = await trackedFolder("first-folder");
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: first }),
    );
    expect(
      await (
        await getManagedExchange(created.id)
      )?.workingDirectoryHandle?.isSameEntry(first),
    ).toBe(true);

    const second = await trackedFolder("second-folder");
    await persistManagedExchangeWorkingDirectory(created.id, second);
    const afterRepoint = await getManagedExchange(created.id);
    expect(
      await afterRepoint?.workingDirectoryHandle?.isSameEntry(second),
    ).toBe(true);
    expect(await afterRepoint?.workingDirectoryHandle?.isSameEntry(first)).toBe(
      false,
    );

    await persistManagedExchangeWorkingDirectory(created.id, null);
    expect(
      (await getManagedExchange(created.id))?.workingDirectoryHandle,
    ).toBeUndefined();
  });
});

describe("run seam composition: the input guard gates the handshake", () => {
  test("a missing file records a benign input failure and never handshakes", async () => {
    const folder = await trackedFolder(
      "run-folder-missing",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    await folder.removeEntry(MANAGED_INPUT_FILE_NAME);

    let handshakeRan = false;
    const error: unknown = await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () =>
        acquireValidatedManagedInput(created.exchangeFile, {
          kind: "folder",
          directory: folder,
          attendance: "unattended",
        }),
      handshake: () => {
        handshakeRan = true;
        return Promise.resolve({
          rotatedSecret: generateSharedSecret(),
          handshake: "c",
        });
      },
      dataExchange: () => Promise.resolve("done"),
    }).then(
      () => {
        throw new Error("the run should have rejected on the missing input");
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ManagedInputError);
    // No connection was attempted: the guard fails before the handshake.
    expect(handshakeRan).toBe(false);
    // The benign input failure is recorded, never desync/attack framing.
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("failed");
    expect(stored?.lastRun?.failureKind).toBe("input");
    // The rotation did not run: the pre-run secret is intact.
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
  });

  test("a column-shape rejection records the terms-shortfall failure and never handshakes", async () => {
    const folder = await trackedFolder("run-folder-drifted", DRIFTED_CSV);
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );

    let handshakeRan = false;
    const error: unknown = await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () =>
        acquireValidatedManagedInput(created.exchangeFile, {
          kind: "folder",
          directory: folder,
          attendance: "unattended",
        }),
      handshake: () => {
        handshakeRan = true;
        return Promise.resolve({
          rotatedSecret: generateSharedSecret(),
          handshake: "c",
        });
      },
      dataExchange: () => Promise.resolve("done"),
    }).then(
      () => {
        throw new Error("the run should have rejected on the drifted columns");
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("columns");
    expect(handshakeRan).toBe(false);
    const stored = await getManagedExchange(created.id);
    // Held apart from the acquisition failure above: the next visit must not be
    // offered the file picker for a file that refuses identically.
    expect(stored?.lastRun?.failureKind).toBe("terms-shortfall");
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
  });

  test("a conforming file passes the guard and reaches the handshake", async () => {
    const folder = await trackedFolder(
      "run-folder-conforming",
      CONFORMING_HEADER + CONFORMING_ROW,
    );
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    const rotatedSecret = generateSharedSecret();

    // The handshake receives the acquired input, proving the guard gates it.
    let handshakeColumns: Array<string> | undefined;
    const result = await runManagedExchange({
      record: created,
      runStartedAtMs: Date.now(),
      acquireInput: () =>
        acquireValidatedManagedInput(created.exchangeFile, {
          kind: "folder",
          directory: folder,
          attendance: "unattended",
        }),
      handshake: (input) => {
        handshakeColumns = input.columns;
        return Promise.resolve({ rotatedSecret, handshake: "c" });
      },
      dataExchange: () => Promise.resolve("done"),
    });

    expect(handshakeColumns?.[0]).toBe("ssn");
    expect(result.exchange).toBe("done");
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.outcome).toBe("succeeded");
    expect(stored?.sharedSecret).toBe(rotatedSecret);
  });
});
