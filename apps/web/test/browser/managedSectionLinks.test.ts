/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  clearManagedExchanges,
  createManagedExchange,
} from "@psi/managed/managedExchangeStore";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";

import { BackupPanel } from "@recurring/ManagedRunSections";
import { MANAGED_BACKUP_SECTION_ID } from "@recurring/managedSectionIds";
import { SavedExchanges } from "@recurring/SavedExchanges";

import { createAppMount, flushPendingUpdates } from "./renderApp";

// The saved list's links into a saved exchange's backup panel and run schedule,
// and the panel landing on them: the row's link resolves to that row's page
// with the section's fragment, and the section the fragment names scrolls into
// view and takes focus. The schedule section's own landing is in the detail
// suite (managedExchangeDetail.test.ts), which renders it.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock({ resolveLinks: true }),
);

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", window.location.pathname);
  await clearManagedExchanges();
});

describe("saved list links into a saved exchange's sections", () => {
  test("the backup and schedule links name the row's exchange and the section", async () => {
    const opensAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stored = await createManagedExchange({
      label: "Riverbend quarterly",
      exchangeFile: composeManagedExchangeFile({
        connection: { channel: "webrtc", host: "signaling.example.org" },
        linkageTerms: getDefaultLinkageTerms("County Health Dept"),
      }),
      side: "inviter",
      sharedSecret: generateSharedSecret(),
      schedule: {
        anchor: opensAt,
        intervalDays: 1,
        windowSeconds: 10_800,
        nextWindow: opensAt,
        consecutiveMisses: 2,
      },
    });

    app.render(createElement(SavedExchanges));

    const backUp = page.getByRole("link", {
      name: "Not backed up - back up now",
    });
    await expect
      .element(backUp)
      .toHaveAttribute("href", `/saved/${stored.id}#backup`);
    await expect
      .element(page.getByRole("link", { name: "Compare schedules" }))
      .toHaveAttribute("href", `/saved/${stored.id}#schedule`);
  });
});

describe("the backup panel as a fragment target", () => {
  function renderBackupPanel() {
    app.render(
      createElement(BackupPanel, {
        marker: undefined,
        busy: false,
        failed: false,
        runInFlight: false,
        onBackUp: () => undefined,
        onMigrate: () => undefined,
      }),
    );
  }

  test("scrolls into view and takes focus when the fragment names it", async () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    window.history.replaceState(null, "", `#${MANAGED_BACKUP_SECTION_ID}`);

    renderBackupPanel();

    await expect
      .element(page.getByText("Back up this exchange."))
      .toBeInTheDocument();
    // The landing runs in a passive effect, after the commit the locator saw.
    await flushPendingUpdates();
    const section = document.getElementById(MANAGED_BACKUP_SECTION_ID);
    expect(section).not.toBeNull();
    expect(document.activeElement).toBe(section);
    expect(scrolled.mock.contexts).toEqual([section]);
  });

  test("neither scrolls nor takes focus without the fragment", async () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");

    renderBackupPanel();

    await expect
      .element(page.getByText("Back up this exchange."))
      .toBeInTheDocument();
    await flushPendingUpdates();
    const section = document.getElementById(MANAGED_BACKUP_SECTION_ID);
    expect(section).not.toBeNull();
    expect(document.activeElement).not.toBe(section);
    expect(scrolled).not.toHaveBeenCalled();
  });
});
