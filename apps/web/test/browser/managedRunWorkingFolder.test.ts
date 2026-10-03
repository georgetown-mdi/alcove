/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// The run surface over an exchange's working folder: a browser that can grant a
// folder asks for one where the exchange holds none, rather than offering a file
// chooser, and a folder holding no input file stops the run before it connects,
// naming the file it looked for and the folder it looked in.

const dialed = vi.hoisted(() => ({ count: 0 }));

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () => {
  const mock = (await import("./moduleMocks")).rendezvousMock();
  const counted = () => {
    dialed.count += 1;
    return Promise.reject(new Error("no partner in this test"));
  };
  return { ...mock, dialAsAcceptor: counted, listenAsInviter: counted };
});

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
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

beforeEach(async () => {
  dialed.count = 0;
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

describe("an exchange holding no working folder", () => {
  test("asks for the folder and offers no run until it is chosen", async () => {
    vi.stubGlobal("showDirectoryPicker", () => Promise.resolve(undefined));
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await expect
      .element(page.getByText("Choose this exchange's folder."))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Run exchange" }))
      .toBeDisabled();
    expect(page.getByText("Choose your input file.").query()).toBeNull();
  });

  test("runs from the folder once it is chosen", async () => {
    const folder = await opfsFolder("run-surface-chosen");
    vi.stubGlobal("showDirectoryPicker", () => Promise.resolve(folder));
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    await page.getByRole("button", { name: "Choose folder" }).first().click();

    await expect
      .element(page.getByRole("button", { name: "Run exchange" }))
      .toBeEnabled();
    expect(page.getByText("Choose this exchange's folder.").query()).toBeNull();
    const stored = await getManagedExchange(created.id);
    expect(await stored?.workingDirectoryHandle?.isSameEntry(folder)).toBe(
      true,
    );
  });
});

describe("a working folder holding no input file", () => {
  test("stops the run before connecting, naming the file and the folder", async () => {
    expectConsole(
      "error",
      "ManagedInputError: managed exchange input could not be read at run start",
    );
    const folder = await opfsFolder("run-surface-empty");
    const created = await createManagedExchange(
      newExchange({ workingDirectoryHandle: folder }),
    );
    app.render(createElement(ManagedRunSurface, { id: created.id }));

    const runButton = page.getByRole("button", { name: "Run exchange" });
    await expect.element(runButton).toBeEnabled();
    await runButton.click();

    await expect
      .element(
        page.getByText(
          'the folder "run-surface-empty" has no file named input.csv',
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("nothing left this device", { exact: false }))
      .toBeInTheDocument();
    expect(dialed.count).toBe(0);
    const stored = await getManagedExchange(created.id);
    expect(stored?.lastRun?.failureKind).toBe("input");
    expect(stored?.sharedSecret).toBe(created.sharedSecret);
  });
});
