import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MANAGED_INPUT_FILE_NAME,
  ManagedInputFileMissingError,
  acquireManagedInput,
} from "@psi/managed/managedInputHandle";
import {
  writeResultsToWorkingDirectory,
  writeRunResultsToWorkingFolder,
} from "@psi/managed/managedWorkingDirectory";
import { ManagedInputError } from "@psi/managed/managedInputGuard";

import type {
  HandlePermissionMode,
  HandlePermissionQuery,
  HandlePermissionState,
} from "@psi/managed/managedInputHandle";

/**
 * A run's input read from the exchange's working folder by its one conventioned
 * name, and its results written beside it. A real directory handle needs a picker
 * grant no Node project can summon, so the folder here is built to the platform
 * calls the read and the write make, keeping its entries by name so a test can
 * replace the input between runs the way the operator does.
 */

const parse = vi.fn((file: File) =>
  file.text().then((text) => ({
    data: [],
    errors: [],
    meta: {
      fields: (text.split("\n")[0] ?? "").split(","),
      sanitizedColumnPositions: [],
    },
  })),
);

vi.mock("@psi/workers/csvParseController", () => ({
  loadCSVFileOffMainThread: (file: File) => parse(file),
}));

/** The cause an `"acquire"` rejection holds, or `undefined` for anything else. */
function acquireCause(error: unknown): unknown {
  return error instanceof ManagedInputError &&
    error.rejection.reason === "acquire"
    ? error.rejection.cause
    : undefined;
}

const granted: HandlePermissionQuery = {
  query: () => Promise.resolve("granted"),
  request: () => Promise.resolve("granted"),
};

/** A permission layer keeping one state per mode, as the browser does: both
 * start at `initial` (`"prompt"`, as after a browser restart), a request sets
 * the mode it asks for to `answer`, and a `readwrite` grant also admits a read.
 * `calls` records every query and request, in order. */
function statefulPermission(
  answer: HandlePermissionState,
  initial: Record<HandlePermissionMode, HandlePermissionState> = {
    read: "prompt",
    readwrite: "prompt",
  },
) {
  const states = { ...initial };
  const calls: Array<string> = [];
  const layer: HandlePermissionQuery = {
    query: (_handle, mode) => {
      calls.push(`query ${mode}`);
      return Promise.resolve(states[mode]);
    },
    request: (_handle, mode) => {
      calls.push(`request ${mode}`);
      states[mode] = answer;
      if (mode === "readwrite" && answer === "granted") states.read = "granted";
      return Promise.resolve(states[mode]);
    },
  };
  return { layer, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A folder holding `entries` by name. `lookups` records every name asked for;
 * a name the folder does not hold is refused as the platform refuses it, with a
 * `NotFoundError`, unless the lookup creates it. */
function fakeFolder(name: string, entries: Map<string, string>) {
  const lookups: Array<{ fileName: string; create: boolean }> = [];
  const handle = {
    name,
    getFileHandle: (fileName: string, options?: { create?: boolean }) => {
      const create = options?.create === true;
      lookups.push({ fileName, create });
      if (!entries.has(fileName)) {
        if (!create)
          return Promise.reject(
            new DOMException(
              "A requested file could not be found",
              "NotFoundError",
            ),
          );
        entries.set(fileName, "");
      }
      return Promise.resolve({
        getFile: () =>
          Promise.resolve(new File([entries.get(fileName) ?? ""], fileName)),
        createWritable: () =>
          Promise.resolve({
            write: async (blob: Blob) => {
              entries.set(fileName, await blob.text());
            },
            close: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          }),
      });
    },
    removeEntry: (fileName: string) => {
      entries.delete(fileName);
      return Promise.resolve();
    },
  };
  return { lookups, handle: handle as unknown as FileSystemDirectoryHandle };
}

describe("reading a run's input from the working folder", () => {
  test("looks the conventioned name up afresh on every run", async () => {
    const entries = new Map([[MANAGED_INPUT_FILE_NAME, "ssn,dob\n"]]);
    const folder = fakeFolder("Riverbend exchange", entries);
    const source = {
      kind: "folder" as const,
      directory: folder.handle,
      attendance: "unattended" as const,
    };

    const first = await acquireManagedInput(source, granted);
    expect(first.columns).toEqual(["ssn", "dob"]);

    // The operator puts the next period's extract under the same name; the next
    // run reads that file, not the one that stood there before.
    entries.set(MANAGED_INPUT_FILE_NAME, "ssn,dob,zip\n");
    const second = await acquireManagedInput(source, granted);
    expect(second.columns).toEqual(["ssn", "dob", "zip"]);

    expect(folder.lookups).toEqual([
      { fileName: MANAGED_INPUT_FILE_NAME, create: false },
      { fileName: MANAGED_INPUT_FILE_NAME, create: false },
    ]);
  });

  test("refuses a folder holding no input file, naming the file and the folder, before any parse", async () => {
    parse.mockClear();
    const folder = fakeFolder(
      "Riverbend exchange",
      new Map([["records.csv", "ssn\n"]]),
    );
    const read = acquireManagedInput(
      { kind: "folder", directory: folder.handle, attendance: "unattended" },
      granted,
    );

    const cause = acquireCause(await read.catch((caught: unknown) => caught));
    expect(cause).toBeInstanceOf(ManagedInputFileMissingError);
    expect(cause).toMatchObject({
      fileName: MANAGED_INPUT_FILE_NAME,
      folderName: "Riverbend exchange",
    });
    // Another file in the folder is not read in its place.
    expect(parse).not.toHaveBeenCalled();
    expect(folder.lookups).toEqual([
      { fileName: MANAGED_INPUT_FILE_NAME, create: false },
    ]);
  });

  test("refuses a folder under the input name as a missing file", async () => {
    const mismatch = new DOMException(
      "The path supplied exists, but was not an entry of requested type.",
      "TypeMismatchError",
    );
    const handle = {
      name: "Riverbend exchange",
      getFileHandle: () => Promise.reject(mismatch),
    } as unknown as FileSystemDirectoryHandle;
    const error: unknown = await acquireManagedInput(
      { kind: "folder", directory: handle, attendance: "unattended" },
      granted,
    ).catch((caught: unknown) => caught);
    expect(acquireCause(error)).toBeInstanceOf(ManagedInputFileMissingError);
  });

  test("a folder whose read permission is not standing is refused unattended without a lookup", async () => {
    const folder = fakeFolder(
      "Riverbend exchange",
      new Map([[MANAGED_INPUT_FILE_NAME, "ssn\n"]]),
    );
    const prompt: HandlePermissionQuery = {
      query: () => Promise.resolve("prompt"),
      request: () => Promise.reject(new Error("an unattended run never asks")),
    };
    await expect(
      acquireManagedInput(
        { kind: "folder", directory: folder.handle, attendance: "unattended" },
        prompt,
      ),
    ).rejects.toBeInstanceOf(ManagedInputError);
    expect(folder.lookups).toEqual([]);
  });
});

describe("the permission an attended run's input read asks for", () => {
  const RUN_AT = "2026-01-06T14:00:00.000Z";

  test("is readwrite, asked once, so the write after the run lands without asking", async () => {
    vi.stubGlobal("FileSystemDirectoryHandle", class {});
    const entries = new Map([[MANAGED_INPUT_FILE_NAME, "ssn\n"]]);
    const folder = fakeFolder("Riverbend exchange", entries);
    const permission = statefulPermission("granted");

    await acquireManagedInput(
      { kind: "folder", directory: folder.handle, attendance: "attended" },
      permission.layer,
    );
    expect(permission.calls).toEqual(["query readwrite", "request readwrite"]);

    const delivery = await writeRunResultsToWorkingFolder(
      { label: "Riverbend", workingDirectoryHandle: folder.handle },
      RUN_AT,
      new Blob(["ssn\n123\n"]),
      permission.layer,
    );
    expect(delivery.kind).toBe("written");
    expect(permission.calls).toEqual([
      "query readwrite",
      "request readwrite",
      "query readwrite",
    ]);
  });

  test("still reads the input on a standing read grant where write is refused, asking once", async () => {
    vi.stubGlobal("FileSystemDirectoryHandle", class {});
    const folder = fakeFolder(
      "Riverbend exchange",
      new Map([[MANAGED_INPUT_FILE_NAME, "ssn\n"]]),
    );
    const permission = statefulPermission("denied", {
      read: "granted",
      readwrite: "prompt",
    });

    const acquired = await acquireManagedInput(
      { kind: "folder", directory: folder.handle, attendance: "attended" },
      permission.layer,
    );
    expect(acquired.columns).toEqual(["ssn"]);
    expect(permission.calls).toEqual([
      "query readwrite",
      "request readwrite",
      "query read",
    ]);

    const delivery = await writeRunResultsToWorkingFolder(
      { label: "Riverbend", workingDirectoryHandle: folder.handle },
      RUN_AT,
      new Blob(["ssn\n123\n"]),
      permission.layer,
    );
    expect(delivery).toEqual({ kind: "ungranted", state: "denied" });
    expect(
      permission.calls.filter((call) => call.startsWith("request")),
    ).toHaveLength(1);
  });

  test("is refused, naming the readwrite state, where neither grant stands", async () => {
    const folder = fakeFolder(
      "Riverbend exchange",
      new Map([[MANAGED_INPUT_FILE_NAME, "ssn\n"]]),
    );
    const permission = statefulPermission("denied");

    const error = await acquireManagedInput(
      { kind: "folder", directory: folder.handle, attendance: "attended" },
      permission.layer,
    ).catch((caught: unknown) => caught);
    expect(acquireCause(error)).toMatchObject({
      name: "HandlePermissionError",
      mode: "readwrite",
      state: "denied",
    });
    expect(folder.lookups).toEqual([]);
  });

  test("is read alone, queried and never asked, on an unattended run", async () => {
    const folder = fakeFolder(
      "Riverbend exchange",
      new Map([[MANAGED_INPUT_FILE_NAME, "ssn\n"]]),
    );
    const permission = statefulPermission("granted", {
      read: "granted",
      readwrite: "granted",
    });

    await acquireManagedInput(
      { kind: "folder", directory: folder.handle, attendance: "unattended" },
      permission.layer,
    );
    expect(permission.calls).toEqual(["query read"]);
  });
});

describe("the results a run writes into the working folder", () => {
  test("land beside the input, which is left as it was", async () => {
    const entries = new Map([[MANAGED_INPUT_FILE_NAME, "ssn,dob\n"]]);
    const folder = fakeFolder("Riverbend exchange", entries);

    await acquireManagedInput(
      { kind: "folder", directory: folder.handle, attendance: "unattended" },
      granted,
    );
    const delivery = await writeResultsToWorkingDirectory(
      folder.handle,
      "alcove-results-riverbend-20260106T140000Z.csv",
      new Blob(["ssn\n123\n"]),
      granted,
    );

    expect(delivery).toEqual({
      kind: "written",
      fileName: "alcove-results-riverbend-20260106T140000Z.csv",
      directoryName: "Riverbend exchange",
    });
    expect([...entries.keys()].sort()).toEqual([
      "alcove-results-riverbend-20260106T140000Z.csv",
      MANAGED_INPUT_FILE_NAME,
    ]);
    expect(entries.get(MANAGED_INPUT_FILE_NAME)).toBe("ssn,dob\n");
    expect(entries.get("alcove-results-riverbend-20260106T140000Z.csv")).toBe(
      "ssn\n123\n",
    );
  });
});
