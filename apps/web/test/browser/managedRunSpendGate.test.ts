/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  RECORD_GONE_HANDOFF_REASON,
  RECORD_GONE_HANDOFF_TITLE,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
  SUPERSEDED_HANDOFF_REASON,
  SUPERSEDED_HANDOFF_TITLE,
} from "@recurring/managedHandoffGate";
import {
  clearManagedExchanges,
  createManagedExchange,
  deleteManagedExchange,
  persistManagedExchangeRotation,
} from "@psi/managed/managedExchangeStore";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";
import { RUN_IN_FLIGHT_EXPORT_REASON } from "@recurring/managedCronExportModel";
import { composeManagedExchangeFile } from "@psi/managed/managedExchangeRecord";
import { getManagedLocalState } from "@psi/managed/managedLocalState";

import { disclosureToggle, openDisclosure } from "./collapsePanels";
import {
  filterLockFromReadings,
  holdRunLockElsewhere,
  stalePollUntilClick,
} from "./runLockReadings";
import { captureDownloads } from "./captureDownloads";
import { createAppMount } from "./renderApp";

import type { NewManagedExchange } from "@psi/managed/managedExchangeRecord";

// The move to another device must never hand over a copy of the shared secret
// that a run's rotation has already superseded, or is about to supersede. Two
// independent mechanisms enforce this: the confirmation's store step re-reads the
// record under the run's own lock, and the surface withholds the move while a run
// is in flight in any context. The command-line download is withheld the same
// way, since files taken mid-run are about to go out of date. This runs in
// Chromium because both take the real browser lock and poll.

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

const downloadButton = () =>
  page.getByRole("button", { name: "Download alcove.yaml and .alcove.key" });

const migrateButton = () =>
  page.getByRole("button", { name: "Move to another device" });

const migrationConfirm = () =>
  page.getByRole("button", {
    name: "I saved the file; hand off this exchange",
  });

// Each notice is matched on its heading exactly, so a heading and the reason under
// it cannot resolve to the same element.
const waitNotice = () =>
  page.getByText(RUN_IN_FLIGHT_HANDOFF_TITLE, { exact: true });

const supersededNotice = () =>
  page.getByText(SUPERSEDED_HANDOFF_TITLE, { exact: true });

const recordGoneNotice = () =>
  page.getByText(RECORD_GONE_HANDOFF_TITLE, { exact: true });

// The dismiss label the record-gone refusal takes on both surfaces: neutral,
// because there is no live copy left for "keep it here" to describe.
const closeButton = () => page.getByRole("button", { name: "Close" });

// An assertion on a state the run lock's 400 ms poll produces takes no timeout of
// its own: an un-timed `expect.element` polls for what is left of the test's own
// timeout, so a constant here would only narrow the budget every other wait in the
// file already runs under.

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  app.unmount();
  await clearManagedExchanges();
});

describe("a move across a run of the same exchange", () => {
  test("the move to another device refuses a copy a run elsewhere superseded, then takes a fresh one", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect
        .element(page.getByText("Confirm the move"))
        .toBeInTheDocument();

      // A run in another context rotates and persists while this screen stands --
      // the ordering no gate on this screen can observe, since the confirm screen
      // outlives the run that superseded it.
      await persistManagedExchangeRotation(created.id, {
        sharedSecret: generateSharedSecret(),
        expires: null,
      });

      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      await expect.element(supersededNotice()).toBeInTheDocument();
      await expect.element(migrationConfirm()).toBeDisabled();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      // The refusal's way out is the route off THIS screen: its only download
      // control lives on the one behind it, so the copy names the button that
      // goes back rather than a download nothing here offers.
      await expect
        .element(page.getByText(SUPERSEDED_HANDOFF_REASON))
        .toBeInTheDocument();

      // Downloading again reads the rotated record, and that copy hands off --
      // by the two clicks the refusal above names, in that order.
      await page
        .getByRole("button", { name: "Keep it on this device" })
        .click();
      await migrateButton().click();
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      await expect
        .element(page.getByText("Handed off to another device"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeDefined();
    } finally {
      downloads.restore();
    }
  });
});

describe("a hand-off whose record is gone", () => {
  test("the move refuses without sending the operator for a download that cannot exist", async () => {
    // The confirmation outlives the record: an operator who deleted the exchange
    // (or whose browser storage was cleared) in another tab still has this screen
    // standing, with the artifact already on their disk.
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect
        .element(page.getByText("Confirm the move"))
        .toBeInTheDocument();

      await deleteManagedExchange(created.id);
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      // Its own refusal, not the superseded one: there is no copy here to hand
      // over and none to download again either.
      await expect.element(recordGoneNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText(RECORD_GONE_HANDOFF_REASON))
        .toBeInTheDocument();
      await expect.element(supersededNotice()).not.toBeInTheDocument();
      await expect.element(migrationConfirm()).toBeDisabled();
      // The dismiss label is neutral rather than "Keep it on this device": there
      // is no live copy left here for that label to describe.
      await expect.element(closeButton()).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Keep it on this device" }))
        .not.toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
    } finally {
      downloads.restore();
    }
  });
});

describe("a confirmation clicked between two readings of the run lock", () => {
  // The poll behind the withholding reads every 400 ms, so a run can take the
  // lock while a confirm button is still enabled from the last reading. What
  // covers that gap is the handler's own re-read at the click.

  test("the move confirmation re-reads the lock at the click and holds back", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    let restorePoll: (() => void) | undefined;
    let release: (() => void) | undefined;
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect.element(migrationConfirm()).toBeEnabled();

      // Installed once the confirmation is up, so the click that dispatched the
      // export is not the one the reading is restored on.
      restorePoll = stalePollUntilClick(created.id);
      release = await holdRunLockElsewhere(created.id);
      // Still enabled: the poll's readings do not see this run, which is the
      // state the click-time re-read exists for.
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      // Nothing spent, and the run is named as the reason rather than the
      // operator being left with a confirmation that silently did nothing.
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await expect.element(waitNotice()).toBeInTheDocument();
      await expect
        .element(page.getByText("Handed off to another device"))
        .not.toBeInTheDocument();

      release();
      release = undefined;
      // The confirmation is intact once the run releases: the refused click
      // consumed nothing.
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();
      await expect
        .element(page.getByText("Handed off to another device"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeDefined();
    } finally {
      release?.();
      restorePoll?.();
      downloads.restore();
    }
  });
});

describe("a confirmation the run lock refuses at the write", () => {
  // The surface's readings are the best-effort half and can miss a run entirely --
  // the poll's interval, a query this browser will not answer. What is measured
  // here is the half that cannot: the spend takes the run+rotate lock itself, so a
  // click that reaches it mid-run spends nothing, and the run's own rotation
  // therefore supersedes nothing that was handed over.

  test("the move confirmation spends nothing while a run holds the lock", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    let readings: { reveal: () => void; restore: () => void } | undefined;
    let release: (() => void) | undefined;
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect.element(migrationConfirm()).toBeEnabled();

      readings = filterLockFromReadings(created.id);
      release = await holdRunLockElsewhere(created.id);
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      await expect.element(waitNotice()).toBeInTheDocument();
      await expect.element(supersededNotice()).not.toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      await expect
        .element(page.getByText("Handed off to another device"))
        .not.toBeInTheDocument();
      // The confirm control stays enabled through its own run-in-flight refusal --
      // the poll never saw this run, so nothing in the surface's own state disables
      // it -- and the wait copy above is what tells the operator to retry it.
      await expect.element(migrationConfirm()).toBeEnabled();

      release();
      release = undefined;
      readings.restore();
      readings = undefined;
      await expect.element(migrationConfirm()).toBeEnabled();
      await migrationConfirm().click();

      await expect
        .element(page.getByText("Handed off to another device"))
        .toBeInTheDocument();
      expect((await getManagedLocalState(created.id))?.spent).toBeDefined();
    } finally {
      release?.();
      readings?.restore();
      downloads.restore();
    }
  });
});

describe("a run held in another context", () => {
  test("the move confirmation is withheld while another context runs, and returns", async () => {
    const created = await createManagedExchange(newExchange());
    const downloads = captureDownloads();
    try {
      app.render(createElement(ManagedRunSurface, { id: created.id }));
      await expect.element(migrateButton()).toBeInTheDocument();
      await migrateButton().click();
      await expect.element(migrationConfirm()).toBeEnabled();

      const release = await holdRunLockElsewhere(created.id);
      try {
        await expect.element(migrationConfirm()).toBeDisabled();
        await expect.element(waitNotice()).toBeInTheDocument();
        expect((await getManagedLocalState(created.id))?.spent).toBeUndefined();
      } finally {
        release();
      }

      await expect.element(migrationConfirm()).toBeEnabled();
      await expect.element(waitNotice()).not.toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("the command-line download and the move are withheld while another context runs", async () => {
    const created = await createManagedExchange(newExchange());
    app.render(createElement(ManagedRunSurface, { id: created.id }));
    await expect.element(exportToggle()).toBeInTheDocument();
    // openDisclosure, not a bare click: the download button below is moving until
    // the panel's open transition ends.
    await openDisclosure(EXPORT_PANEL);
    await expect.element(downloadButton()).toBeEnabled();

    const release = await holdRunLockElsewhere(created.id);
    try {
      // Either download taken mid-run holds a secret the run is about to replace.
      await expect.element(migrateButton()).toBeDisabled();
      await expect.element(downloadButton()).toBeDisabled();
      await expect
        .element(page.getByText(RUN_IN_FLIGHT_EXPORT_REASON))
        .toBeInTheDocument();
    } finally {
      release();
    }

    await expect.element(migrateButton()).toBeEnabled();
    await expect.element(downloadButton()).toBeEnabled();
    await expect
      .element(page.getByText(RUN_IN_FLIGHT_EXPORT_REASON))
      .not.toBeInTheDocument();
  });
});
