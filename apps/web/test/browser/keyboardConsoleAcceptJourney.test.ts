/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

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
  toggle,
  typeInto,
} from "./keyboardOnly";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectStepAccessible } from "./stepChecks";

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
  await expectStepAccessible(app.container);
});
