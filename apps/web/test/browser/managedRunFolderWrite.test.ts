/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

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

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

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

// The driver is stubbed to a completed run: its results file built through the
// caller's own URL allocation, as the real driver builds it, and a succeeded
// stamp at a fixed instant so the written name is known.
vi.mock("@psi/managed/managedRunDriver", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runManagedExchangeInBrowser: (config: {
      urls: { create: (blob: Blob) => string };
    }) =>
      Promise.resolve({
        exchange: {
          kind: "matched",
          resultsUrl: config.urls.create(
            new Blob([RESULTS_CSV], { type: "text/csv" }),
          ),
          matchedRecordCount: 1,
        },
        lastRun: { at: RUN_AT, outcome: "succeeded" },
      }),
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

  test("keeps the download and reports a write that did not land beside it", async () => {
    const folder = await opfsFolder("attended-write-fails");
    // A folder already under the results name makes the file write refuse.
    await folder.getDirectoryHandle(runResultsFileName(LABEL, RUN_AT), {
      create: true,
    });
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await runToCompletion();

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
