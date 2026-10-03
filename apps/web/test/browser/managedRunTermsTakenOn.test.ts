/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
  getManagedExchange,
  putManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { ManagedTermsChangeTakenOnError } from "@psi/managed/managedTermsProposal";
import { TERMS_CHANGE_TAKEN_ON_FAILURE } from "@recurring/managedRunLaunchModel";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const ACCEPTED_AGREEMENT = "DUA-2026-accepted";

/** The stubbed run takes the partner's terms on, as an attended Accept of a
 * change the run cannot continue under writes them, then stops the way core
 * stops that run. */
vi.mock("@psi/managed/managedRunDriver", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runManagedExchangeInBrowser: async ({
      record,
    }: {
      record: ManagedExchangeRecord;
    }) => {
      const stored = await getManagedExchange(record.id);
      if (stored === undefined) throw new Error("the record is gone");
      await putManagedExchange({
        ...stored,
        exchangeFile: {
          ...stored.exchangeFile,
          linkageTerms: {
            ...stored.exchangeFile.linkageTerms,
            legalAgreement: {
              reference: ACCEPTED_AGREEMENT,
              purpose: "Quarterly program evaluation",
              expirationDate: "2099-12-31",
            },
          },
        },
      });
      throw new ManagedTermsChangeTakenOnError({ cause: undefined });
    },
  };
});

async function workingFolder(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle("managed-folder", { create: true });
}

const app = createAppMount();

beforeEach(clearManagedExchanges);

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

test("a run stopped after an accepted terms change shows the terms the exchange now holds", async () => {
  expectConsole(
    "error",
    /^ManagedTermsChangeTakenOnError: your partner's changed linkage terms were saved /,
  );
  const created = await createManagedExchange({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    workingDirectoryHandle: await workingFolder(),
  });
  app.render(createElement(ManagedRunSurface, { id: created.id }));
  const runButton = page.getByRole("button", { name: "Run exchange" });
  await expect.element(runButton).toBeEnabled();
  await runButton.click();

  await expect
    .element(page.getByText(TERMS_CHANGE_TAKEN_ON_FAILURE.message))
    .toBeInTheDocument();
  await expect.element(page.getByText(ACCEPTED_AGREEMENT)).toBeInTheDocument();
});
