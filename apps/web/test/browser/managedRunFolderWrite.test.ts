/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  getLogger,
} from "@alcove/core";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { runResultsFileName } from "@psi/parkedResults";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";

import type * as WorkingDirectory from "@psi/managed/managedWorkingDirectory";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";
import type { RunResultsFolderWrite } from "@psi/managed/managedWorkingDirectory";

// An attended run of a recurring exchange writes its results into the working
// folder the operator granted, under the name a scheduled run would use, and
// still offers the download. A write that does not land is reported beside the
// download, which stays. An exchange holding no folder grant writes nothing.

const RESULTS_CSV = "id,county\nA-19,Riverbend\n";
const RUN_AT = "2026-03-01T14:00:00.000Z";
const LABEL = "Riverbend quarterly";

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const log = getLogger("ManagedRunSurface");

// What a test varies about the stubbed run and the folder write. `allocated`
// false builds the results URL outside the caller's allocation; a `hold` keeps
// the folder write from starting until the test releases it, and `written` is
// the write's own outcome once it has run. `refuseBytes` has the write's stream
// refuse the bytes after the results entry is created.
const stub = vi.hoisted(() => ({
  allocated: true,
  hold: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
  written: undefined as Promise<unknown> | undefined,
  refuseBytes: false,
}));

// The driver is stubbed to a completed run: its results file built through the
// caller's own URL allocation, as the real driver builds it, and a succeeded
// stamp at a fixed instant so the written name is known.
vi.mock("@psi/managed/managedRunDriver", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runManagedExchangeInBrowser: (config: {
      urls: { create: (blob: Blob) => string };
    }) => {
      const blob = new Blob([RESULTS_CSV], { type: "text/csv" });
      return Promise.resolve({
        exchange: {
          kind: "matched",
          resultsUrl: stub.allocated
            ? config.urls.create(blob)
            : window.URL.createObjectURL(blob),
          matchedRecordCount: 1,
        },
        lastRun: { at: RUN_AT, outcome: "succeeded" },
      });
    },
  };
});

/**
 * The granted folder with a stream that refuses the bytes, wrapping the REAL
 * directory: the entry `getFileHandle` creates, the abort, and the removal that
 * follows are Chromium's own, so what the folder is left holding is the
 * platform's answer.
 */
function refusingBytesFolder(
  real: FileSystemDirectoryHandle,
): FileSystemDirectoryHandle {
  return {
    name: real.name,
    getFileHandle: async (
      fileName: string,
      options?: FileSystemGetFileOptions,
    ) => {
      const file = await real.getFileHandle(fileName, options);
      return {
        createWritable: async () => {
          const writable = await file.createWritable();
          return {
            write: () =>
              Promise.reject(new Error("the folder refused the bytes")),
            close: () => writable.close(),
            abort: () => writable.abort(),
          };
        },
      };
    },
    removeEntry: (name: string, options?: FileSystemRemoveOptions) =>
      real.removeEntry(name, options),
  } as unknown as FileSystemDirectoryHandle;
}

vi.mock("@psi/managed/managedWorkingDirectory", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkingDirectory>();
  return {
    ...actual,
    writeRunResultsToWorkingFolder: (
      ...args: Parameters<typeof actual.writeRunResultsToWorkingFolder>
    ): Promise<RunResultsFolderWrite> => {
      stub.started?.();
      const [record, ...rest] = args;
      const folder = record.workingDirectoryHandle;
      const writtenRecord =
        stub.refuseBytes && folder !== undefined
          ? { ...record, workingDirectoryHandle: refusingBytesFolder(folder) }
          : record;
      const written = (stub.hold ?? Promise.resolve()).then(() =>
        actual.writeRunResultsToWorkingFolder(writtenRecord, ...rest),
      );
      stub.written = written;
      return written;
    },
  };
});

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: LABEL,
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

const FOLDER_NAMES: Array<string> = [];

async function opfsFolder(name: string): Promise<FileSystemDirectoryHandle> {
  FOLDER_NAMES.push(name);
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

const app = createAppMount();

/** What a directory holds, by entry name. */
async function entryNames(
  directory: FileSystemDirectoryHandle,
): Promise<Array<string>> {
  const names: Array<string> = [];
  for await (const name of directory.keys()) names.push(name);
  return names.sort();
}

/** The not-written note beside the download, and the download itself. */
async function expectNotWrittenBesideDownload(): Promise<void> {
  await expect
    .element(page.getByText("Not written to your folder"))
    .toBeInTheDocument();
  await expect
    .element(
      page.getByText("the write failed. Download them above instead", {
        exact: false,
      }),
    )
    .toBeInTheDocument();
  await expect
    .element(page.getByRole("link", { name: /Download result/ }))
    .toBeInTheDocument();
}

/** Press Run on the mounted surface and wait for the completion screen. */
async function runToCompletion(): Promise<void> {
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();
  await expect
    .element(page.getByRole("heading", { name: "Run complete" }))
    .toBeInTheDocument();
}

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  stub.allocated = true;
  stub.hold = undefined;
  stub.started = undefined;
  stub.written = undefined;
  stub.refuseBytes = false;
  await clearManagedExchanges();
  const root = await navigator.storage.getDirectory();
  for (const name of FOLDER_NAMES.splice(0))
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
});

describe("an attended run of an exchange holding a folder grant", () => {
  test("writes its results into the folder under the scheduled run's name, and still offers the download", async () => {
    const folder = await opfsFolder("attended-write");
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await runToCompletion();

    const fileName = runResultsFileName(LABEL, RUN_AT);
    await expect
      .element(page.getByText(`also written to ${fileName}`, { exact: false }))
      .toBeInTheDocument();
    const written = await (await folder.getFileHandle(fileName)).getFile();
    expect(await written.text()).toBe(RESULTS_CSV);
    await expect
      .element(page.getByRole("link", { name: /Download result/ }))
      .toBeInTheDocument();
  });

  test("keeps the download, reports a write that did not land beside it, and leaves a folder already under the results name", async () => {
    expectConsole(
      "error",
      "TypeMismatchError: The path supplied exists, but was not an entry of requested type.",
    );
    const folder = await opfsFolder("attended-write-fails");
    const fileName = runResultsFileName(LABEL, RUN_AT);
    // A folder already under the results name makes the file write refuse.
    await folder.getDirectoryHandle(fileName, { create: true });
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await runToCompletion();

    await expectNotWrittenBesideDownload();
    expect(await stub.written).toMatchObject({ kind: "write-failed" });
    await expect(folder.getDirectoryHandle(fileName)).resolves.toBeDefined();
  });

  test("removes the results entry a write created before its bytes were refused", async () => {
    expectConsole("error", "Error: the folder refused the bytes");
    stub.refuseBytes = true;
    const folder = await opfsFolder("attended-write-refuses-bytes");
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await runToCompletion();

    await expectNotWrittenBesideDownload();
    expect(await stub.written).toMatchObject({ kind: "write-failed" });
    expect(await entryNames(folder)).toEqual([]);
  });
});

describe("an attended run whose surface is torn down during the folder write", () => {
  // A write already under way when the operator leaves still lands, and the
  // surface it belonged to is not updated or reported on afterwards.
  async function tearDownDuringWrite(
    folder: FileSystemDirectoryHandle,
  ): Promise<void> {
    let release: () => void = () => undefined;
    stub.hold = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      stub.started = resolve;
    });
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await runToCompletion();
    await started;
    await expect
      .element(page.getByText("Writing the results to", { exact: false }))
      .toBeInTheDocument();
    app.unmount();
    release();
    await stub.written;
    await flushPendingUpdates();
  }

  test("completes the write", async () => {
    const folder = await opfsFolder("attended-write-torn-down");

    await tearDownDuringWrite(folder);

    const written = await (
      await folder.getFileHandle(runResultsFileName(LABEL, RUN_AT))
    ).getFile();
    expect(await written.text()).toBe(RESULTS_CSV);
  });

  test("reports nothing once the surface is gone, even for a write that failed", async () => {
    const folder = await opfsFolder("attended-write-torn-down-fails");
    await folder.getDirectoryHandle(runResultsFileName(LABEL, RUN_AT), {
      create: true,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await tearDownDuringWrite(folder);

    expect(await stub.written).toMatchObject({ kind: "write-failed" });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("an attended run whose results file the surface did not allocate", () => {
  test("logs that nothing was written to the folder, and writes nothing", async () => {
    stub.allocated = false;
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const folder = await opfsFolder("attended-write-unallocated");
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await runToCompletion();
    await flushPendingUpdates();

    expect(error).toHaveBeenCalledWith(
      `managed exchange ${created.id}: the run's results file was not built ` +
        `through this runtime's own allocation, so nothing was written to ` +
        `the working folder`,
    );
    expect(stub.written).toBeUndefined();
    expect(app.container.textContent).not.toContain("folder you granted");
  });
});

describe("an attended run of an exchange holding no folder grant", () => {
  test("offers the download and says nothing of a folder", async () => {
    vi.stubGlobal("showDirectoryPicker", undefined);
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByText("Choose your input file."))
      .toBeInTheDocument();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(["ssn\n"], "input.csv", { type: "text/csv" }),
    );

    await runToCompletion();

    await expect
      .element(page.getByRole("link", { name: /Download result/ }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain("folder you granted");
    expect(app.container.textContent).not.toContain("Not written");
  });
});
