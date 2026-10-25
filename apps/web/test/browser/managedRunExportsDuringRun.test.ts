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
import { RUN_IN_FLIGHT_EXPORT_REASON } from "@recurring/managedCronExportModel";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { getManagedLocalState } from "@psi/managed/managedLocalState";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { disclosureToggle, openDisclosure } from "./collapsePanels";
import { holdRunLockElsewhere, pauseLockReadings } from "./runLockReadings";
import { captureDownloads } from "./captureDownloads";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// Both exports -- the backup and the command-line files -- follow one rule while a
// run of the exchange is in flight: the surface withholds them while its poll sees
// the run, and each takes the run's own lock, so a click the poll did not hold back
// is refused there. Either file taken mid-run would hold a secret the run is about
// to rotate. This runs in Chromium because both take the real browser lock and poll.

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

/** How many places show the run-in-progress reason: one beside each export. */
const reasonsShown = () =>
  page.getByText(RUN_IN_FLIGHT_EXPORT_REASON).elements().length;

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
  test("withholds both downloads with the reason beside each, and returns them", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect.element(exportToggle()).toBeInTheDocument();
    // openDisclosure, not a bare click: the download button below is moving until
    // the panel's open transition ends.
    await openDisclosure(EXPORT_PANEL);
    await expect.element(cliDownloadButton()).toBeEnabled();
    await expect.element(backupButton()).toBeEnabled();

    const release = await holdRunLockElsewhere(created.id);
    try {
      await expect.element(backupButton()).toBeDisabled();
      await expect.element(cliDownloadButton()).toBeDisabled();
      await expect.poll(reasonsShown).toBe(2);
    } finally {
      release();
    }

    await expect.element(backupButton()).toBeEnabled();
    await expect.element(cliDownloadButton()).toBeEnabled();
    await expect.poll(reasonsShown).toBe(0);
  });
});

describe("a backup the run lock refuses at the click", () => {
  // The surface's readings are the best-effort half and can miss a run -- the poll's
  // interval, a query this browser will not answer. What is measured here is the
  // half that cannot: the backup takes the run+rotate lock itself.

  test("downloads and marks nothing, shows the reason with no failure, and clears it on the next reading", async () => {
    const created = await createManagedExchange(newExchange());
    const before = await getManagedExchange(created.id);
    const readings = pauseLockReadings(created.id);
    const release = await holdRunLockElsewhere(created.id);
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(backupButton()).toBeEnabled();
      expect(reasonsShown()).toBe(0);

      await backupButton().click();

      // Beside both exports: the refusal is the run-in-progress reading they
      // share, and the collapsed command-line panel still holds its reason.
      await expect.poll(reasonsShown).toBe(2);
      expect(page.getByText("Could not save the backup").query()).toBe(null);
      await downloads.settled();
      expect(downloads.captured).toEqual([]);
      expect(await getManagedExchange(created.id)).toEqual(before);
      expect(await getManagedLocalState(created.id)).toBeUndefined();

      // The run's hold ends before the poll reads again. The next reading finds
      // the lock free, so the reason goes with no other click or change.
      release();
      readings.resume();
      await expect.poll(reasonsShown).toBe(0);
      await expect.element(backupButton()).toBeEnabled();
    } finally {
      downloads.restore();
      release();
      readings.restore();
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
  test("leaves the stored record unchanged and runnable, and records no hand-off", async () => {
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
      expect(local?.spent).toBeUndefined();
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
