/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import { minimalPreparedExchange } from "@alcove/core/testing";

import { WAITING_STAGE_ID, stagesFor } from "@exchange/exchangeRun";
import {
  clearManagedExchanges,
  listManagedExchanges,
} from "@psi/managed/managedExchangeStore";
import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { ManagedRunSurface } from "@recurring/ManagedRunSurface";

import {
  activate,
  control,
  expectHeadingFocused,
  tabTo,
  toggle,
  typeInto,
} from "./keyboardOnly";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectNoAccessibilityViolations } from "./accessibilityRules";

import type { InvitationToken, LinkageTerms } from "@alcove/core";

// The accept flow and the recurring setup that follows it, driven from the
// keyboard alone (keyboardOnly.ts): each step's controls are reached by Tab and
// operated by Enter or Space, focus lands on the incoming step's heading, and
// the rule scan (accessibilityRules.ts) runs on each step and on the result.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The run settles itself with a matched result, the call order the real
// lifecycle fires, so the journey reaches Done with no hand-fired callback.
const journeyResultsUrl = URL.createObjectURL(new Blob(["a,b\nx,y\n"]));
vi.mock("@psi/exchangeLifecycle", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExchangeLifecycle: (options: {
    signal: AbortSignal;
    onStages: (stages: Array<unknown>) => void;
    onStage: (stageId: string) => void;
    onResult: (outputs: {
      kind: "matched";
      resultsUrl: string;
      matchedRecordCount: number;
    }) => void;
  }) =>
    Promise.resolve().then(() => {
      if (options.signal.aborted) return;
      options.onStages(
        stagesFor(
          minimalPreparedExchange({ linkageTerms: acceptorTerms }),
          "acceptor",
        ),
      );
      options.onStage(WAITING_STAGE_ID);
      options.onStage(CONFIRMING_PROTOCOL_STAGE_ID);
      options.onResult({
        kind: "matched" as const,
        resultsUrl: journeyResultsUrl,
        matchedRecordCount: 12,
      });
    }),
}));

// The move to another device downloads a backup file the runner cannot save;
// the dispatch is stubbed to the state it leaves the surface in, as
// managedRunSurfaceHandOff.test.ts does.
vi.mock("@psi/managed/managedExchangeExport", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchManagedMigration: () =>
    Promise.resolve({
      backedUpAt: new Date("2026-07-10T09:00:00.000Z"),
      confirm: () => Promise.resolve(),
    }),
}));

const acceptorTerms: LinkageTerms = {
  ...getDefaultLinkageTerms("County Health Department"),
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

async function invitationHash(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: acceptorTerms,
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

const app = createAppMount();

beforeEach(async () => {
  await clearManagedExchanges();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.location.hash = "";
  await clearManagedExchanges();
});

/** Accepts the invitation through to Done from the keyboard. */
async function acceptByKeyboard(): Promise<void> {
  window.location.hash = await invitationHash();
  app.render(createElement(AcceptorScreen));

  await expect
    .element(page.getByText("Invitation from County Health Department"))
    .toBeInTheDocument();
  expectNoAccessibilityViolations(app.container, { page: true });
  await activate(control("button", "Continue: consent & your file"));

  await expectHeadingFocused("Consent & your file");
  expectNoAccessibilityViolations(app.container, { page: true });
  await tabTo(
    (focused) => focused.getAttribute("aria-label") === "Your data file",
  );
  const fileInput = document.activeElement?.querySelector('input[type="file"]');
  expect(fileInput).not.toBeNull();
  await userEvent.upload(
    page.elementLocator(fileInput as HTMLElement),
    new File(["first_name,last_name\nAlice,Smith\n"], "cohort_intake.csv", {
      type: "text/csv",
    }),
  );
  await expect.element(page.getByText("cohort_intake.csv")).toBeInTheDocument();
  await toggle(control("checkbox", /./));
  await typeInto(control("textbox", "Your name"), "Sam Alvarez");
  await expect
    .element(page.getByLabelText("Your name"))
    .toHaveValue("Sam Alvarez");
  await activate(control("button", "Accept and continue"));

  await expectHeadingFocused("Confirm your columns");
  await expect
    .element(page.getByText("All 2 keys can match"))
    .toBeInTheDocument();
  expectNoAccessibilityViolations(app.container, { page: true });
  await activate(control("button", "Start the exchange"));

  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange complete");
}

test("accept: review, consent, columns and the result, from the keyboard", async () => {
  await acceptByKeyboard();
  await expectHeadingFocused("Exchange complete");
  await expect
    .element(page.getByText(/12.*matched records/))
    .toBeInTheDocument();
  expectNoAccessibilityViolations(app.container, { page: true });
  await tabTo(control("link", "Download result: results.csv"));
});

test("recurring setup: save the accepted exchange, then step through its surface, from the keyboard", async () => {
  await acceptByKeyboard();

  await typeInto(control("textbox", "Label"), "Riverbend quarterly");
  await activate(control("button", "Save as a recurring exchange"));
  await expect
    .poll(() => document.activeElement?.textContent ?? "")
    .toContain("Saved as a recurring exchange.");
  expectNoAccessibilityViolations(app.container, { page: true });

  const [saved] = await listManagedExchanges();
  expect(saved.label).toBe("Riverbend quarterly");
  app.unmount();
  app.render(createElement(ManagedRunSurface, { id: saved.id }));

  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Riverbend quarterly");
  expectNoAccessibilityViolations(app.container, { page: true });

  await activate(control("button", "Move to another device"));
  await expectHeadingFocused("Confirm the move");
  expectNoAccessibilityViolations(app.container, { page: true });

  await activate(control("button", "Keep it on this device"));
  await expectHeadingFocused("Riverbend quarterly");

  await activate(control("button", "Move to another device"));
  await expectHeadingFocused("Confirm the move");
  await activate(control("button", "I saved the file; hand off this exchange"));
  await expectHeadingFocused("Handed off to another device");
  expectNoAccessibilityViolations(app.container, { page: true });
});
