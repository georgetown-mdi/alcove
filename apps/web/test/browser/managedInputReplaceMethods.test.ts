/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedInputError } from "@psi/managed/managedInputGuard";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import {
  MANAGED_INPUT_FILE_NAME,
  ManagedInputFileMissingError,
  acquireManagedInput,
} from "@psi/managed/managedInputHandle";

import type { CSVParseRows } from "@psi/workers/csvParseController";
import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";
import type { WebRTCExchangeLocator } from "@alcove/core";

// What a run reads from a persisted working folder after the input file in it
// is replaced, exercised against real Chromium: the three ways an export job,
// an editor, or a sync client refreshes a file -- overwrite in place, write a
// temporary file and rename it over the name, delete the file and create a new
// one -- plus the archive-then-drop variant that moves the current file away
// first.
//
// Constraint: the folder measured is in the origin private file system, whose
// handles are structured-cloneable and take the same getFileHandle/getFile
// calls as a picked one. It stands in for the production case -- a folder the
// operator picked from the local filesystem -- which no headless run can
// obtain, since the picker needs a person. The permission extension an OPFS
// handle does not implement is the injected suite's (managedInputHandle.test.ts,
// "permission layer").

const FOLDER_NAME = "replace-methods-folder";
const STAGED_NAME = `${MANAGED_INPUT_FILE_NAME}.part`;
const ARCHIVED_NAME = "input-prior-period.csv";

const HEADER = "ssn,first_name,last_name,date_of_birth\n";
const FIRST_PERIOD = HEADER + "111111111,ADA,LOVELACE,01/01/1990\n";
const SECOND_PERIOD =
  HEADER +
  "222222222,GRACE,HOPPER,12/09/1906\n" +
  "333333333,KATHERINE,JOHNSON,08/26/1918\n";

const FIRST_PERIOD_ROWS = [
  {
    ssn: "111111111",
    first_name: "ADA",
    last_name: "LOVELACE",
    date_of_birth: "01/01/1990",
  },
];
const SECOND_PERIOD_ROWS = [
  {
    ssn: "222222222",
    first_name: "GRACE",
    last_name: "HOPPER",
    date_of_birth: "12/09/1906",
  },
  {
    ssn: "333333333",
    first_name: "KATHERINE",
    last_name: "JOHNSON",
    date_of_birth: "08/26/1918",
  },
];

const webrtcLocator: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "signaling.example.org",
  port: 3000,
  path: "/api/",
};

const linkageTerms = getDefaultLinkageTerms(
  "County Health Dept",
  inferMetadata(["ssn", "first_name", "last_name", "date_of_birth"], []),
);

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

/** `FileSystemFileHandle.move` is a Chromium extension the DOM lib does not
 * type. It is what a rename over an existing name takes here, and its absence
 * fails the rename cases rather than skipping them. */
type MovableFileHandle = FileSystemFileHandle & {
  move: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

function movable(handle: FileSystemFileHandle): MovableFileHandle {
  const candidate = handle as MovableFileHandle;
  expect(typeof candidate.move).toBe("function");
  return candidate;
}

/** The working folder every case refreshes its input in. */
async function workingFolder(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(FOLDER_NAME, { create: true });
}

async function writeInFolder(
  folder: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<FileSystemFileHandle> {
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
  return handle;
}

/** The folder a run actually follows: written onto a managed record and read
 * back out of the store, so every case below measures a handle that has been
 * through the record's structured-clone round trip rather than the one held in
 * memory. */
async function persistedFolder(
  folder: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle> {
  const created = await createManagedExchange(
    newExchange({ workingDirectoryHandle: folder }),
  );
  const stored = await getManagedExchange(created.id);
  const persisted = stored?.workingDirectoryHandle;
  if (persisted === undefined) throw new Error("no folder was persisted");
  return persisted;
}

/** One run's read from the persisted folder: the bytes that run received and
 * the rows it parsed out of them. */
async function runTimeRead(
  directory: FileSystemDirectoryHandle,
): Promise<{ text: string; rows: CSVParseRows }> {
  const acquired = await acquireManagedInput({
    kind: "folder",
    directory,
    attendance: "unattended",
  });
  return { text: await acquired.file.text(), rows: acquired.rows };
}

async function firstPeriodRun(): Promise<{
  folder: FileSystemDirectoryHandle;
  persisted: FileSystemDirectoryHandle;
}> {
  const folder = await workingFolder();
  await writeInFolder(folder, MANAGED_INPUT_FILE_NAME, FIRST_PERIOD);
  const persisted = await persistedFolder(folder);
  const first = await runTimeRead(persisted);
  expect(first.text).toBe(FIRST_PERIOD);
  expect(first.rows).toEqual(FIRST_PERIOD_ROWS);
  return { folder, persisted };
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await clearManagedExchanges();
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(FOLDER_NAME, { recursive: true });
  } catch {
    // Already gone.
  }
});

describe("overwrite in place", () => {
  test("the next run reads the new period", async () => {
    const { folder, persisted } = await firstPeriodRun();

    await writeInFolder(folder, MANAGED_INPUT_FILE_NAME, SECOND_PERIOD);

    const second = await runTimeRead(persisted);
    expect(second.text).toBe(SECOND_PERIOD);
    expect(second.rows).toEqual(SECOND_PERIOD_ROWS);
  });
});

describe("write a temporary file and rename it over the name", () => {
  test("the next run reads the new period", async () => {
    const { folder, persisted } = await firstPeriodRun();

    const staged = await writeInFolder(folder, STAGED_NAME, SECOND_PERIOD);
    await movable(staged).move(folder, MANAGED_INPUT_FILE_NAME);

    const second = await runTimeRead(persisted);
    expect(second.text).toBe(SECOND_PERIOD);
    expect(second.rows).toEqual(SECOND_PERIOD_ROWS);
    await expect(folder.getFileHandle(STAGED_NAME)).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });
});

describe("delete the file and create a new one", () => {
  test("the next run reads the new period", async () => {
    const { folder, persisted } = await firstPeriodRun();

    await folder.removeEntry(MANAGED_INPUT_FILE_NAME);
    await writeInFolder(folder, MANAGED_INPUT_FILE_NAME, SECOND_PERIOD);

    const second = await runTimeRead(persisted);
    expect(second.text).toBe(SECOND_PERIOD);
    expect(second.rows).toEqual(SECOND_PERIOD_ROWS);
  });

  test("a run between the delete and the create fails the read, naming the file and the folder", async () => {
    const { folder, persisted } = await firstPeriodRun();

    await folder.removeEntry(MANAGED_INPUT_FILE_NAME);

    const error: unknown = await acquireManagedInput({
      kind: "folder",
      directory: persisted,
      attendance: "unattended",
    }).then(
      () => {
        throw new Error("the acquire should have rejected");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedInputError);
    expect((error as ManagedInputError).rejection.reason).toBe("acquire");
    const cause = (error as ManagedInputError).cause;
    expect(cause).toBeInstanceOf(ManagedInputFileMissingError);
    expect(cause).toMatchObject({
      fileName: MANAGED_INPUT_FILE_NAME,
      folderName: FOLDER_NAME,
    });
    expect((cause as Error).cause).toMatchObject({ name: "NotFoundError" });
  });
});

describe("move the current file away, then write the new period", () => {
  test("the next run reads the new period", async () => {
    const { folder, persisted } = await firstPeriodRun();

    const atPath = await folder.getFileHandle(MANAGED_INPUT_FILE_NAME);
    await movable(atPath).move(folder, ARCHIVED_NAME);
    await writeInFolder(folder, MANAGED_INPUT_FILE_NAME, SECOND_PERIOD);

    const second = await runTimeRead(persisted);
    expect(second.text).toBe(SECOND_PERIOD);
    expect(second.rows).toEqual(SECOND_PERIOD_ROWS);
    const archived = await folder.getFileHandle(ARCHIVED_NAME);
    expect(await (await archived.getFile()).text()).toBe(FIRST_PERIOD);
  });
});

describe("a File kept from the previous run", () => {
  test("does not read the new period", async () => {
    const { folder, persisted } = await firstPeriodRun();
    const retained = await (
      await persisted.getFileHandle(MANAGED_INPUT_FILE_NAME)
    ).getFile();

    await writeInFolder(folder, MANAGED_INPUT_FILE_NAME, SECOND_PERIOD);

    await expect(retained.text()).rejects.toMatchObject({
      name: "NotReadableError",
    });
    expect((await runTimeRead(persisted)).text).toBe(SECOND_PERIOD);
  });
});
