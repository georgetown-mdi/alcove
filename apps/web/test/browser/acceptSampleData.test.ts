/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry (the
// exchange browser suites' shared discipline).
import "@mantine/core/styles.css";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import { minimalPreparedExchange } from "@alcove/core/testing";

import {
  SAMPLE_INVITATIONS_STORAGE_KEY,
  recordSampleInvitation,
} from "@exchange/sampleInvitationRecord";
import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { SAMPLE_PARTNER_FILE_NAME } from "@psi/sampleData";
import { stagesFor } from "@exchange/exchangeRun";

import { isolatedColumnName } from "@components/ColumnName";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import { lifecycleCall, lifecycleCalls } from "./moduleMocks";

import type { InvitationToken, LinkageTerms } from "@alcove/core";

// The acceptor's sample partner file: offered on the consent step only for an
// invitation this browser created from the sample data, chosen through the
// same intake a dropped file uses, and treated as a practice run from there.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// The rendezvous dial runs only inside the run lifecycle's acquire closure,
// which the lifecycle stub below never invokes.
vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The run is recorded rather than run, so a test completes it by firing the
// callbacks the real lifecycle fires.
vi.mock("@psi/exchangeLifecycle", async (importOriginal) =>
  (await import("./moduleMocks")).exchangeLifecycleMock(importOriginal),
);

// The recurring offer probes the managed store as it mounts: counting the
// probes tells whether the offer mounted. The real probe still answers.
const storeProbe = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@psi/managed/managedExchangeStore", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const probe = actual.probeManagedStoreOpen as () => Promise<boolean>;
  return {
    ...actual,
    probeManagedStoreOpen: () => {
      storeProbe.calls += 1;
      return probe();
    },
  };
});

/** Terms the sample partner file's name columns cover in full. */
const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Sample County Agency",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

const SAMPLE_COLUMNS = ["first_name", "last_name", "dob", "zip", "member_id"];

async function encodeToken(): Promise<{ encoded: string; expires: string }> {
  const expires = new Date(Date.now() + 3600 * 1000).toISOString();
  const token: InvitationToken = {
    version: "1",
    linkageTerms: terms,
    sharedSecret: generateSharedSecret(),
    expires,
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return { encoded: await encodeInvitation(token), expires };
}

const app = createAppMount();

afterEach(() => {
  app.unmount();
  window.location.hash = "";
  window.localStorage.removeItem(SAMPLE_INVITATIONS_STORAGE_KEY);
  lifecycleCalls.length = 0;
  storeProbe.calls = 0;
});

const sampleChoice = () =>
  page.getByRole("button", { name: "Use the sample partner file" });
const ledger = () =>
  document.querySelector('aside[aria-label="This exchange"]') as Element;
const SAMPLE_NOTICE = "Sample data (synthetic records)";
const unloadPrompted = () =>
  !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

/** Open `encoded` on the acceptor screen and continue to the consent step. */
async function reachConsent(encoded: string) {
  window.location.hash = encoded;
  app.render(createElement(AcceptorScreen));
  await page
    .getByRole("button", { name: "Continue: consent & your file" })
    .click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Consent & your file");
}

/** A sample invitation this browser created, opened at the consent step. */
async function reachConsentOnSampleInvitation() {
  const { encoded, expires } = await encodeToken();
  await recordSampleInvitation(encoded, expires);
  await reachConsent(encoded);
}

/** Choose the sample, consent, name, and accept into the columns step. */
async function acceptSample() {
  await sampleChoice().click();
  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
  await page.getByRole("button", { name: "Accept and continue" }).click();
  await expect
    .element(page.getByRole("heading", { name: "Confirm your columns" }))
    .toBeInTheDocument();
}

describe("the sample partner file on the consent step", () => {
  test("a sample invitation this browser created offers it; the same invitation without the record does not", async () => {
    const { encoded, expires } = await encodeToken();
    await reachConsent(encoded);
    await expect
      .element(page.getByRole("button", { name: "Accept and continue" }))
      .toBeInTheDocument();
    expect(sampleChoice().query()).toBeNull();
    app.unmount();

    await recordSampleInvitation(encoded, expires);
    await reachConsent(encoded);
    await expect.element(sampleChoice()).toBeInTheDocument();
  });

  test("a real invitation is never offered it", async () => {
    const sample = await encodeToken();
    await recordSampleInvitation(sample.encoded, sample.expires);
    const real = await encodeToken();
    await reachConsent(real.encoded);
    await expect
      .element(page.getByRole("button", { name: "Accept and continue" }))
      .toBeInTheDocument();
    expect(sampleChoice().query()).toBeNull();
  });

  test("shows only while no file is chosen; Clear and a real file each end the sample", async () => {
    await reachConsentOnSampleInvitation();
    await expect.element(sampleChoice()).toBeInTheDocument();
    expect(ledger().textContent).not.toContain(SAMPLE_NOTICE);

    // Chosen, the sample is the step's file and the choice goes.
    await sampleChoice().click();
    await expect
      .element(page.getByText(SAMPLE_PARTNER_FILE_NAME))
      .toBeInTheDocument();
    expect(sampleChoice().query()).toBeNull();
    expect(ledger().textContent).toContain(SAMPLE_NOTICE);
    await vi.waitFor(() => expect(unloadPrompted()).toBe(false));

    // Clear returns the step to no file chosen.
    await page.getByRole("button", { name: "Clear" }).click();
    await expect.element(sampleChoice()).toBeInTheDocument();
    expect(page.getByText(SAMPLE_PARTNER_FILE_NAME).query()).toBeNull();
    expect(ledger().textContent).not.toContain(SAMPLE_NOTICE);

    // A real file replaces the sample and clears its state.
    await sampleChoice().click();
    await expect
      .element(page.getByText(SAMPLE_PARTNER_FILE_NAME))
      .toBeInTheDocument();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(["first_name,last_name\nAnn,Lee\n"], "mine.csv", {
        type: "text/csv",
      }),
    );
    await expect.element(page.getByText("mine.csv")).toBeInTheDocument();
    expect(page.getByText(SAMPLE_PARTNER_FILE_NAME).query()).toBeNull();
    expect(sampleChoice().query()).toBeNull();
    expect(ledger().textContent).not.toContain(SAMPLE_NOTICE);
    await vi.waitFor(() => expect(unloadPrompted()).toBe(true));
  });

  test("the consent gate holds the sample as it holds a dropped file", async () => {
    await reachConsentOnSampleInvitation();
    await sampleChoice().click();
    const accept = page.getByRole("button", { name: "Accept and continue" });
    await expect.element(accept).toBeDisabled();
    await userEvent.click(page.getByRole("checkbox"));
    await expect.element(accept).toBeDisabled();
    await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
    await expect.element(accept).toBeEnabled();
  });

  test("a sample accept reaches the columns step with the sample's columns", async () => {
    await reachConsentOnSampleInvitation();
    await acceptSample();
    for (const column of SAMPLE_COLUMNS)
      await expect
        .element(
          page.getByRole("combobox", {
            name: `How column ${isolatedColumnName(column)} is used`,
            exact: true,
          }),
        )
        .toBeInTheDocument();
    expect(ledger().textContent).toContain(SAMPLE_NOTICE);
    // The Clear is withheld once the consent gate admits the rows.
    expect(page.getByRole("button", { name: "Clear" }).query()).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();
  });

  test("a run on a real file is offered Save as a recurring exchange", async () => {
    await reachConsentOnSampleInvitation();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(["first_name,last_name\nAnn,Lee\n"], "mine.csv", {
        type: "text/csv",
      }),
    );
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
    await page.getByRole("button", { name: "Accept and continue" }).click();
    await completeRun();
    await flushPendingUpdates();
    expect(storeProbe.calls).toBeGreaterThan(0);
    await expect
      .element(
        page.getByRole("button", { name: "Save as a recurring exchange" }),
      )
      .toBeInTheDocument();
  });

  test("a sample run is not offered Save as a recurring exchange", async () => {
    await reachConsentOnSampleInvitation();
    await acceptSample();
    await completeRun();
    // The offer probes the store as it mounts, so no probe means no offer.
    await flushPendingUpdates();
    expect(storeProbe.calls).toBe(0);
    expect(
      page
        .getByRole("button", { name: "Save as a recurring exchange" })
        .query(),
    ).toBeNull();
    expect(ledger().textContent).toContain(SAMPLE_NOTICE);
  });

  test("a sample run in flight does not prompt on unload; a real run does", async () => {
    await reachConsentOnSampleInvitation();
    await acceptSample();
    await startRun();
    await expect
      .element(page.getByRole("heading", { name: "Exchange in progress" }))
      .toBeInTheDocument();
    await flushPendingUpdates();
    expect(unloadPrompted()).toBe(false);
    app.unmount();
    lifecycleCalls.length = 0;

    await reachConsentOnSampleInvitation();
    await uploadRealFile();
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
    await page.getByRole("button", { name: "Accept and continue" }).click();
    await startRun();
    await vi.waitFor(() => expect(unloadPrompted()).toBe(true));
  });

  test("a real file dropped after going back from the admitted sample needs a new accept", async () => {
    await reachConsentOnSampleInvitation();
    await acceptSample();

    window.history.back();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Consent & your file");
    await uploadRealFile();
    await expect.element(page.getByText("mine.csv")).toBeInTheDocument();

    // Forward does not reach the columns read from the sample.
    const forwarded = new Promise((resolve) =>
      window.addEventListener("popstate", resolve, { once: true }),
    );
    window.history.forward();
    await forwarded;
    await flushPendingUpdates();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Consent & your file");
    expect(
      page.getByRole("heading", { name: "Confirm your columns" }).query(),
    ).toBeNull();
    expect(ledger().textContent).not.toContain(SAMPLE_NOTICE);

    await page.getByRole("button", { name: "Accept and continue" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("combobox", {
          name: `How column ${isolatedColumnName("dob")} is used`,
          exact: true,
        })
        .query(),
    ).toBeNull();
    expect(ledger().textContent).not.toContain(SAMPLE_NOTICE);
  });
});

/** Drop a real two-column file on the consent step's dropzone. */
async function uploadRealFile() {
  const fileInput = document.querySelector('input[type="file"]');
  await userEvent.upload(
    page.elementLocator(fileInput as HTMLElement),
    new File(["first_name,last_name\nAnn,Lee\n"], "mine.csv", {
      type: "text/csv",
    }),
  );
}

/** Start the exchange from the columns step; the run stays in flight. */
async function startRun() {
  await page.getByRole("button", { name: "Start the exchange" }).click();
  await vi.waitFor(() => expect(lifecycleCalls).toHaveLength(1));
}

/** Start the exchange from the columns step and complete its run with a
 * rotated secret, the condition the recurring offer appears on. */
async function completeRun() {
  await startRun();
  const run = lifecycleCall(0);
  run.onStages(
    stagesFor(
      minimalPreparedExchange({
        linkageTerms: getDefaultLinkageTerms("Sample run"),
      }),
      "acceptor",
    ),
  );
  run.onResult(
    {
      kind: "matched",
      resultsUrl: URL.createObjectURL(new Blob(["a,b\n"])),
      matchedRecordCount: 6,
    },
    { rotatedSecret: generateSharedSecret() },
  );
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange complete");
}
