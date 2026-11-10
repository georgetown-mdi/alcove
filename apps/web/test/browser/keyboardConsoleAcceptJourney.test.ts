/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { AcceptorScreen } from "@exchange/AcceptorScreen";

import {
  COHORT_FILE,
  COHORT_PROFILE,
  sftpAcceptToken,
  stubConsoleJobApi,
} from "./consoleStates";
import {
  CONSOLE_JOURNEY_TIMEOUT_MS,
  activate,
  control,
  expectHeadingFocused,
  tabTo,
  toggle,
  typeInto,
} from "./keyboardOnly";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";
import { expectStepAccessible } from "./stepChecks";

import type { ConsoleJobApi } from "./consoleStates";

// The console's accept flow over the partner's SFTP server, driven from the
// keyboard alone (keyboardOnly.ts): the terms, consent and a file from the
// working folder, then the columns step where the operator sets up the SFTP
// connection. Each step is held to the step checks (stepChecks.ts).

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../utils/clientConfigMock")).consoleClientConfigMock(
    importOriginal,
  ),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.setConfig({ testTimeout: CONSOLE_JOURNEY_TIMEOUT_MS });

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.location.hash = "";
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

/** A transport stall the console relays: an `exchange` failure that offers
 * Try again. */
const STALL_MESSAGE =
  "the partner did not answer within 10m; confirm they started their half " +
  "and run the exchange again";

/** Walks the accept flow from the keyboard to the columns step and opens the
 * SFTP connection form there. */
async function openConnectionFormByKeyboard(): Promise<void> {
  window.location.hash = await sftpAcceptToken();
  app.render(createElement(AcceptorScreen));
  await expect
    .element(page.getByText("Invitation from County Health Department"))
    .toBeInTheDocument();
  await activate(control("button", "Continue: consent & your file"));
  await expectHeadingFocused("Consent & your file");
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();
  await toggle(control("checkbox", /./));
  await typeInto(control("textbox", "Your name or agency"), "Sam Alvarez");
  await activate(control("button", "Select cohort.csv"));
  await activate(control("button", "Use this file"));
  await expect
    .element(page.getByText("Selected", { exact: true }))
    .toBeInTheDocument();
  await activate(control("button", "Accept and continue"));
  await expectHeadingFocused("Confirm your columns");
  await activate(control("button", "Set up connection"));
  await expect.element(page.getByLabelText("Username")).toHaveFocus();
}

/** Authors the connection from the keyboard, starts the exchange and advances
 * the console's run past the wait for the partner. */
async function runByKeyboard(api: ConsoleJobApi): Promise<void> {
  await openConnectionFormByKeyboard();
  await userEvent.keyboard("linkage");
  await typeInto(
    control("textbox", "Server identity fingerprint"),
    FINGERPRINT,
  );
  await typeInto(control("textbox", "File reference"), "@/run/secrets/key");
  await activate(control("button", "Save connection"));
  await expect.element(page.getByText("Ready to try")).toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Start the exchange"));

  await vi.waitFor(() => expect(api.createdJobStreaming()).toBe(true));
  await expectStepAccessible(app.container);
  api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange in progress");
  await expectStepAccessible(app.container);
}

const ACCEPT_JOB_API = {
  inputs: { configured: true, files: [COHORT_FILE] },
  profile: COHORT_PROFILE,
};

test("console accept over SFTP: the run and its result, from the keyboard", async () => {
  const api = stubConsoleJobApi(ACCEPT_JOB_API);
  await runByKeyboard(api);

  api.emitEvent({ v: 1, type: "result", resultWritten: true });
  api.closeEvents();
  await expectHeadingFocused("Exchange complete");
  await expectStepAccessible(app.container);
});

test("console accept over SFTP: a failed run, from the keyboard", async () => {
  expectConsole("error", `RelayedSelfExplainingError: ${STALL_MESSAGE}`);
  const api = stubConsoleJobApi(ACCEPT_JOB_API);
  await runByKeyboard(api);

  api.setJobStatus("failed");
  api.emitEvent({
    v: 1,
    type: "error",
    category: "exchange",
    message: STALL_MESSAGE,
    recoveryHint: true,
  });
  api.closeEvents();
  await expect.element(page.getByText(STALL_MESSAGE)).toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console accept over SFTP: the connection form's field errors and a refused save, from the keyboard", async () => {
  stubConsoleJobApi({ ...ACCEPT_JOB_API, sftpPutStatus: 500 });
  await openConnectionFormByKeyboard();
  await activate(control("button", "Save connection"));
  await expect
    .element(page.getByLabelText("Username"))
    .toHaveAttribute("aria-invalid", "true");
  await expectStepAccessible(app.container);

  await tabTo(control("textbox", "Username"), { backward: true });
  await userEvent.keyboard("linkage");
  await typeInto(
    control("textbox", "Server identity fingerprint"),
    FINGERPRINT,
  );
  await typeInto(control("textbox", "File reference"), "@/run/secrets/key");
  await activate(control("button", "Save connection"));
  await expect
    .element(page.getByText("Could not save the connection"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console accept over SFTP: terms, consent, working-folder file and the connection form, from the keyboard", async () => {
  stubConsoleJobApi({
    inputs: { configured: true, files: [COHORT_FILE] },
    profile: COHORT_PROFILE,
  });
  window.location.hash = await sftpAcceptToken();
  app.render(createElement(AcceptorScreen));

  await expect
    .element(page.getByText("Invitation from County Health Department"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Continue: consent & your file"));

  await expectHeadingFocused("Consent & your file");
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
  await toggle(control("checkbox", /./));
  await typeInto(control("textbox", "Your name or agency"), "Sam Alvarez");
  await activate(control("button", "Select cohort.csv"));
  await expect
    .element(page.getByRole("heading", { level: 2, name: "Confirm this file" }))
    .toBeInTheDocument();
  await activate(control("button", "Use this file"));
  await expect
    .element(page.getByText("Selected", { exact: true }))
    .toBeInTheDocument();
  await activate(control("button", "Accept and continue"));

  await expectHeadingFocused("Confirm your columns");
  await expect
    .element(
      page.getByText("Set up the SFTP connection above before you can start."),
    )
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await activate(control("button", "Set up connection"));
  await expect.element(page.getByLabelText("Username")).toHaveFocus();
  await expect
    .element(page.getByLabelText("Username"))
    .toHaveAttribute("autocomplete", "username");
  await expectStepAccessible(app.container);
});
