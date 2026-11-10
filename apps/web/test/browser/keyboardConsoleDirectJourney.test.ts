/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { DirectExchangeScreen } from "@exchange/DirectExchangeScreen";

import { AUTHORED_SFTP, stubConsoleJobApi } from "./consoleStates";
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
import { expectAaClean, sweepContrast } from "./contrastSweep";
import { expectConsole } from "./expectedConsole";
import { expectStepAccessible } from "./stepChecks";

import type { ConsoleJobApi, ConsoleJobApiOptions } from "./consoleStates";

// The console's quick exchange driven from the keyboard alone (keyboardOnly.ts):
// a file from the working folder, the agreed server, the confirm step, and the
// run the console conducts through to its result or failure. Each step is held
// to the step checks (stepChecks.ts).

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

const TERMS_MISMATCH =
  "linkage terms do not match the partner's inferred terms";

/** Picks the working folder's file from the keyboard and lands on the agreed
 * server step, in `scheme` when one is forced. */
async function reachAgreedServerByKeyboard(
  scheme?: "light" | "dark",
): Promise<void> {
  app.render(
    createElement(DirectExchangeScreen),
    scheme === undefined ? undefined : { forceColorScheme: scheme },
  );
  await expect
    .element(page.getByText("Choose a file from your folder"))
    .toBeInTheDocument();
  await activate(control("button", "Select clients.csv"));
  await expect
    .element(page.getByRole("heading", { level: 2, name: "Confirm this file" }))
    .toBeInTheDocument();
  await activate(control("button", "Use this file"));
  await expectHeadingFocused("The agreed server");
}

/** The step checks, then the contrast sweep of every text element in
 * `scheme`. */
async function expectAgreedServerAccessible(
  scheme: "light" | "dark",
  state: string,
): Promise<void> {
  await expectStepAccessible(app.container);
  expectAaClean(sweepContrast(app.container), scheme, {
    route: "/direct",
    state,
  });
}

/** Picks the file, passes the agreed server, confirms and runs from the
 * keyboard, then advances the console's run past the wait for the partner. */
async function runByKeyboard(api: ConsoleJobApi): Promise<void> {
  await reachAgreedServerByKeyboard();
  await expect.element(page.getByText("Ready to try")).toBeInTheDocument();
  await expectStepAccessible(app.container);
  await activate(control("button", "Continue to confirm and run"));

  await expectHeadingFocused("Confirm and run");
  await typeInto(control("textbox", "Your identity (optional)"), "County");
  await toggle(
    control("checkbox", /^I trust the server my partner and I agreed on/),
  );
  await expectStepAccessible(app.container);
  await activate(control("button", "Run the exchange"));

  await vi.waitFor(() => expect(api.createdJobStreaming()).toBe(true));
  api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange in progress");
  await expectStepAccessible(app.container);
}

test("console quick exchange: file, server, confirm, run and result, from the keyboard", async () => {
  const api = stubConsoleJobApi({ sftp: AUTHORED_SFTP });
  await runByKeyboard(api);

  api.emitEvent({ v: 1, type: "result", resultWritten: true });
  api.closeEvents();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange complete");
  await expectStepAccessible(app.container);
});

test("console quick exchange: a stopped run and its start over, from the keyboard", async () => {
  expectConsole("error", `RelayedTerminalError: ${TERMS_MISMATCH}`);
  const api = stubConsoleJobApi({ sftp: AUTHORED_SFTP });
  await runByKeyboard(api);

  api.setJobStatus("failed");
  api.emitEvent({
    v: 1,
    type: "error",
    category: "config",
    message: TERMS_MISMATCH,
  });
  api.closeEvents();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toMatchTextContent("Exchange stopped");
  const startOver = page.getByRole("button", { name: "Start over" });
  await expect.element(startOver).not.toHaveAttribute("aria-haspopup");
  await expectStepAccessible(app.container);
  await tabTo(control("button", "Start over"));
});

/** The agreed server's states a saved connection or the console's shared
 * folder puts it in, with the status badge whose contrast each one shows. */
const AGREED_SERVER_STATES: ReadonlyArray<{
  state: string;
  jobApi: ConsoleJobApiOptions;
  shown: string;
  badge?: string;
  filedrop?: boolean;
}> = [
  {
    state: "a split-directory connection with retain mode off",
    jobApi: {
      sftp: { ...AUTHORED_SFTP, inboundPath: "/in", outboundPath: "/out" },
    },
    shown: "This connection needs retain mode",
    badge: "Needs retain mode",
  },
  {
    state: "a saved connection a quick exchange refuses",
    jobApi: {
      sftp: { ...AUTHORED_SFTP, zeroSetupRefusal: "sftp-url-directory" },
    },
    shown: "The saved SFTP connection's remote directory cannot be used",
    badge: "Needs a change",
  },
  {
    state: "the shared folder is also the working folder",
    jobApi: {
      rendezvous: {
        configured: true,
        locator: "/rendezvous",
        folderName: "exchange-with-county",
        sharesDataRoot: true,
      },
    },
    shown: "The shared folder holds your own files",
    filedrop: true,
  },
];

for (const { state, jobApi, shown, badge, filedrop } of AGREED_SERVER_STATES)
  for (const scheme of ["light", "dark"] as const)
    test(`console quick exchange: ${state}, from the keyboard (${scheme})`, async () => {
      stubConsoleJobApi(jobApi);
      await reachAgreedServerByKeyboard(scheme);
      if (filedrop === true) {
        await tabTo(
          (focused) =>
            focused instanceof HTMLInputElement &&
            focused.type === "radio" &&
            focused.checked,
        );
        await userEvent.keyboard("{ArrowDown}");
        await expect
          .element(page.getByLabelText("A shared folder on this console"))
          .toBeChecked();
      }
      await expect.element(page.getByText(shown)).toBeInTheDocument();
      if (badge !== undefined)
        await expect
          .element(page.getByText(badge, { exact: true }))
          .toBeInTheDocument();
      await expectAgreedServerAccessible(scheme, state);
    });

test("console quick exchange: the file-handling card's conflict and notices, from the keyboard", async () => {
  stubConsoleJobApi({ sftp: AUTHORED_SFTP });
  await reachAgreedServerByKeyboard();
  await activate(control("button", /^How files are handled/));
  await toggle(control("checkbox", "Keep every exchange file"));
  await expect
    .element(page.getByText("Both sides must set this"))
    .toBeInTheDocument();
  await typeInto(control("combobox", "Timestamped filenames"), "Off");
  await toggle(control("checkbox", "Write files without renaming them"));
  await expect
    .element(page.getByText("Only safe on some shared folders"))
    .toBeInTheDocument();
  await expect
    .element(page.getByText("These settings cannot be used together"))
    .toBeInTheDocument();
  await expectStepAccessible(app.container);
});
