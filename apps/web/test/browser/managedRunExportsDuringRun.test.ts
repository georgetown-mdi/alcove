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
import { MANAGED_BACKUP_SECTION_ID } from "@recurring/managedSectionIds";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { RUN_IN_FLIGHT_EXPORT_NOTE } from "@recurring/managedCronExportModel";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { getManagedLocalState } from "@psi/managed/managedLocalState";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { disclosureToggle, openDisclosure } from "./collapsePanels";
import { captureDownloads } from "./captureDownloads";
import { holdRunLockElsewhere } from "./runLockReadings";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// Both exports -- the backup and the command-line files -- follow one rule while a
// run of the exchange is in flight: each stays offered and downloads, with a note
// beside it that the run replaces the secret the file holds. Neither takes the
// run's lock. This runs in Chromium because the run is a real browser lock and
// the note follows the surface's real poll of it.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: {
        channel: "webrtc",
        host: "signaling.example.org",
        port: 3000,
        path: "/api/",
      },
      linkageTerms,
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

const app = createAppMount();

const EXPORT_PANEL = "Run this from the command line";

const exportToggle = () => disclosureToggle(EXPORT_PANEL);

const cliDownloadButton = () =>
  page.getByRole("button", { name: "Download alcove.yaml and .alcove.key" });

const backupButton = () =>
  page.getByRole("button", { name: "Download a backup" });

/** How many places show the run-in-progress note: one beside each export. */
const notesShown = () =>
  page.getByText(RUN_IN_FLIGHT_EXPORT_NOTE).elements().length;

// An assertion on a state the run lock's 400 ms poll produces takes no timeout of
// its own: an un-timed `expect.element` or `expect.poll` polls for what is left of
// the test's own timeout.

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  await clearManagedExchanges();
});

describe("a run held in another context", () => {
  test("keeps both downloads offered, with the note beside each until the run ends", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect.element(exportToggle()).toBeInTheDocument();
    // openDisclosure, not a bare click: the download button below is moving until
    // the panel's open transition ends.
    await openDisclosure(EXPORT_PANEL);
    await expect.element(cliDownloadButton()).toBeEnabled();
    expect(notesShown()).toBe(0);

    const release = await holdRunLockElsewhere(created.id);
    try {
      await expect.poll(notesShown).toBe(2);
      await expect.element(backupButton()).toBeEnabled();
      await expect.element(cliDownloadButton()).toBeEnabled();
    } finally {
      release();
    }

    await expect.poll(notesShown).toBe(0);
  });

  test("downloads both while the run holds the lock, and marks the backup", async () => {
    const created = await createManagedExchange(newExchange());
    const before = await getManagedExchange(created.id);
    const release = await holdRunLockElsewhere(created.id);
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.poll(notesShown).toBe(2);

      await backupButton().click();
      await expect.poll(() => downloads.captured.length).toBe(1);
      await openDisclosure(EXPORT_PANEL);
      await cliDownloadButton().click();
      await expect.poll(() => downloads.captured.length).toBe(3);
      await downloads.settled();

      expect(downloads.captured.map(({ fileName }) => fileName)).toEqual([
        expect.stringMatching(/^alcove-backup-/),
        "alcove.yaml",
        ".alcove.key",
      ]);
      expect(downloads.captured[0].text).toContain(created.sharedSecret);
      expect(downloads.captured[2].text).toContain(created.sharedSecret);
      expect(page.getByText("Could not save the backup").query()).toBe(null);
      expect(await getManagedExchange(created.id)).toEqual(before);
      expect((await getManagedLocalState(created.id))?.backup).toBeDefined();
    } finally {
      downloads.restore();
      release();
    }
  });
});

describe("what neither export takes with it", () => {
  test("names the accounting of disclosures beside both downloads", async () => {
    const note =
      "This exchange's accounting of disclosures stays in this browser and " +
      "is not included in this download. To keep a copy of it, export the " +
      "accounting as CSV.";
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await openDisclosure(EXPORT_PANEL);
    await expect.element(cliDownloadButton()).toBeEnabled();

    expect(page.getByText(note).elements()).toHaveLength(2);
    expect(
      document.getElementById(MANAGED_BACKUP_SECTION_ID)?.textContent,
    ).toContain(note);
  });
});

describe("a backup taken with no run in flight", () => {
  test("leaves the stored record unchanged and runnable, and writes only its backup marker", async () => {
    const created = await createManagedExchange(newExchange());
    const before = await getManagedExchange(created.id);
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await backupButton().click();
      await expect.poll(() => downloads.captured.length).toBe(1);
      await downloads.settled();

      expect(await getManagedExchange(created.id)).toEqual(before);
      const local = await getManagedLocalState(created.id);
      expect(Object.keys(local ?? {})).toEqual(["backup"]);
      expect(local?.backup?.savedAs).toEqual({
        kind: "downloaded",
        fileName: downloads.captured[0].fileName,
      });
      await expect
        .element(
          page.getByRole("status").filter({ hasText: "Backed up as of" }),
        )
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Run exchange" }))
        .toBeInTheDocument();
      expect(app.container.textContent).not.toMatch(/handed off/i);
    } finally {
      downloads.restore();
    }
  });
});
