/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { getDefaultLinkageTerms } from "@alcove/core";

import { InviterScreen } from "@exchange/InviterScreen";
import { OPEN_CONFIGURATION_LABEL } from "@console/mountedConfiguration";
import { SWEEP_CONTROL_LABEL } from "@psi/runDiagnosticsModel";

import {
  AUTHORED_SFTP,
  AUTHORED_SFTP_WITH_CREDENTIAL_WARNING,
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

// The console's invite flow driven from the keyboard alone (keyboardOnly.ts):
// a file from the working folder, the console's cards on Review & create, the
// SFTP connection and coordination server it authors, the configuration in the
// working folder, and the run the console conducts through to its result or
// failure. Each step is held to the step checks (stepChecks.ts).

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
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

/** A transport stall the console relays: an `exchange` failure that offers
 * Try again. */
const STALL_MESSAGE =
  "the partner did not answer within 10m; confirm they started their half " +
  "and run the exchange again";

/** Picks the working folder's file from the keyboard, through its confirm
 * stage, and walks to Review & create. */
async function reachReviewByKeyboard(): Promise<void> {
  app.render(createElement(InviterScreen));
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await typeInto(control("textbox", "Your name or agency"), "Dana Okafor");
  await activate(control("button", "Select clients.csv"));
  await expect
    .element(page.getByRole("heading", { level: 2, name: "Confirm this file" }))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Use this file"));
  await expect
    .element(page.getByText("Selected", { exact: true }))
    .toBeInTheDocument();
  await activate(control("button", "Continue to matching & sharing"));

  await expectHeadingFocused("Matching & sharing");
  await expectStepAccessible(app.container);
  await activate(control("button", "Continue to review & create"));
  await expectHeadingFocused(/Review/);
}

/** Creates the invitation over the authored SFTP connection from the keyboard
 * and advances the console's run past the wait for the partner. */
async function runByKeyboard(api: ConsoleJobApi): Promise<void> {
  await reachReviewByKeyboard();
  await expect.element(page.getByText("Ready to try")).toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Create the invitation"));

  await expectHeadingFocused("Your invitation is ready");
  await vi.waitFor(() => expect(api.createdJobStreaming()).toBe(true));
  await expectStepAccessible(app.container);

  api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange in progress");
  await expectStepAccessible(app.container);
}

test("console invite: working-folder file, review, invitation, run and result, from the keyboard", async () => {
  const api = stubConsoleJobApi({ sftp: AUTHORED_SFTP });
  await runByKeyboard(api);

  api.emitEvent({ v: 1, type: "result", resultWritten: true });
  api.closeEvents();
  await expectHeadingFocused("Exchange complete");
  await expectStepAccessible(app.container);
});

test("console invite: a failed run and its retry, from the keyboard", async () => {
  expectConsole("error", `RelayedSelfExplainingError: ${STALL_MESSAGE}`);
  const api = stubConsoleJobApi({ sftp: AUTHORED_SFTP });
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
  const retry = page.getByRole("button", { name: "Try again" });
  await expect.element(retry).toBeInTheDocument();
  await expect.element(retry).not.toHaveAttribute("aria-haspopup");
  await expectStepAccessible(app.container);
  await tabTo(control("button", "Try again"));
});

test("console invite: the cards on Review & create open, and show their errors and a credential warning, from the keyboard", async () => {
  stubConsoleJobApi({ sftp: AUTHORED_SFTP_WITH_CREDENTIAL_WARNING });
  await reachReviewByKeyboard();
  await expect
    .element(page.getByText(/is inside the job data root/))
    .toBeInTheDocument();

  await activate(control("button", /^How files are handled/));
  await activate(control("button", /^Connection tuning/));
  await typeInto(
    control("textbox", "How many times to retry a failed connection"),
    "x",
  );
  await activate(control("button", /^Diagnostics and recovery/));
  await toggle(control("checkbox", SWEEP_CONTROL_LABEL));
  await activate(control("button", /^Receipts and record keeping/));
  await expect
    .element(page.getByText("These settings cannot be used").first())
    .toBeInTheDocument();
  await expect
    .element(page.getByText("This run cannot start yet").first())
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the SFTP connection form, its field error and a refused save, from the keyboard", async () => {
  stubConsoleJobApi({ sftpPutStatus: 500 });
  await reachReviewByKeyboard();
  await expect
    .element(page.getByText("No SFTP connection set up for this exchange yet"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await activate(
    control("button", "Run it in my own command-line tool instead"),
  );
  await expect
    .element(page.getByText(/in your own Alcove command-line tool/))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(
    control("button", "Set up a connection to run it here instead"),
  );
  await expect
    .element(page.getByLabelText("SFTP server address"))
    .toHaveFocus();
  await activate(control("button", "Cancel"));
  await expect
    .element(page.getByText("No SFTP connection set up for this exchange yet"))
    .toBeInTheDocument();

  await activate(control("button", "Add connection"));
  await expect
    .element(page.getByLabelText("SFTP server address"))
    .toHaveFocus();
  await expectStepAccessible(app.container);

  await activate(control("button", "Save connection"));
  await expect
    .element(page.getByText("Enter the SFTP server address."))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);

  await tabTo(control("textbox", "SFTP server address"), { backward: true });
  await userEvent.keyboard("sftp.partner.example");
  await typeInto(control("textbox", "Username"), "linkage");
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

test("console invite: the coordination server card, empty and then set, from the keyboard", async () => {
  stubConsoleJobApi({
    webrtcSet: {
      configured: true,
      host: "signal.example.org",
      port: 8443,
      path: "/api/",
      secure: true,
      webAppOrigin: "https://psi.data-bridge.org",
      warnings: [],
    },
  });
  await reachReviewByKeyboard();

  // Tab enters the transport radios at the checked one; the arrow keys move
  // the choice within them, past the ones this console cannot run.
  await tabTo(
    (focused) =>
      focused instanceof HTMLInputElement &&
      focused.type === "radio" &&
      focused.checked,
  );
  const webrtc = page.getByLabelText("Over WebRTC, run here");
  for (
    let press = 0;
    press < 4 && !(webrtc.element() as HTMLInputElement).checked;
    press += 1
  )
    await userEvent.keyboard("{ArrowDown}");
  await expect.element(webrtc).toBeChecked();
  await expect
    .element(page.getByLabelText("Coordination server or web app address"))
    .toHaveValue("");
  await expectStepAccessible(app.container);

  await typeInto(
    control("textbox", "Coordination server or web app address"),
    "https://psi.data-bridge.org",
  );
  await activate(control("button", "Set address and relay"));
  await expect
    .element(page.getByText("wss://signal.example.org:8443/api/"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: the working folder's configuration, opened with its notices, from the keyboard", async () => {
  stubConsoleJobApi({
    config: {
      configured: true,
      present: true,
      document: {
        channel: "sftp",
        server: { host: "sftp.partner.example", username: "county" },
        linkageTerms: getDefaultLinkageTerms("County Health"),
      },
      carriedThrough: ["added_setting"],
      warnings: ["connection.server.password"],
      signingPathSettings: [],
      folderPathSettings: [],
    },
  });
  app.render(createElement(InviterScreen));
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();

  await activate(control("button", OPEN_CONFIGURATION_LABEL));
  await expect
    .element(page.getByText("Configuration opened").first())
    .toBeInTheDocument();
  await expect.element(page.getByText(/added_setting/)).toBeInTheDocument();
  await expectStepAccessible(app.container);
});

test("console invite: a configuration the console refuses, from the keyboard", async () => {
  stubConsoleJobApi({
    config: {
      error:
        "The alcove.yaml in your working folder is not an Alcove exchange " +
        "configuration. Check the file, then open it again.",
    },
    configStatus: 400,
  });
  app.render(createElement(InviterScreen));
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();

  await activate(control("button", OPEN_CONFIGURATION_LABEL));
  await expect
    .element(page.getByText("This configuration cannot be opened").first())
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});
