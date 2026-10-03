/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { getDefaultLinkageTerms } from "@alcove/core";
import { minimalPreparedExchange } from "@alcove/core/testing";

import { InviterScreen } from "@exchange/InviterScreen";
import { stagesFor } from "@exchange/exchangeRun";

import {
  activate,
  control,
  expectHeadingFocused,
  tabTo,
  typeInto,
} from "./keyboardOnly";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectConsole } from "./expectedConsole";
import { expectNoAccessibilityViolations } from "./accessibilityRules";

// The invite flow driven from the keyboard alone (keyboardOnly.ts): the file
// and the terms through to a created invitation, then the result and the
// failure a run can end in. Each step is held to the rule scan
// (accessibilityRules.ts).

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The run is recorded rather than run, so a test fires the callbacks the real
// lifecycle fires to reach the result or the failure.
interface CapturedRun {
  onStages: (stages: Array<unknown>) => void;
  onStage: (stageId: string) => void;
  onResult: (outputs: {
    kind: "matched";
    resultsUrl: string;
    matchedRecordCount: number;
  }) => void;
  onError: (failure: { category: string; error: unknown }) => void;
}
const runs = vi.hoisted(() => ({ calls: [] as Array<unknown> }));
vi.mock("@psi/exchangeLifecycle", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExchangeLifecycle: (options: unknown) => {
    runs.calls.push(options);
    return Promise.resolve();
  },
}));

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  runs.calls.length = 0;
});

/** Creates the invitation from the keyboard and returns the run it started. */
async function inviteByKeyboard(): Promise<CapturedRun> {
  app.render(createElement(InviterScreen));
  await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  expectNoAccessibilityViolations(app.container, { page: true });

  await typeInto(control("textbox", "Your name"), "Dana Okafor");
  await tabTo(
    (focused) => focused.getAttribute("aria-label") === "Your data file",
  );
  const fileInput = document.activeElement?.querySelector('input[type="file"]');
  expect(fileInput).not.toBeNull();
  await userEvent.upload(
    page.elementLocator(fileInput as HTMLElement),
    new File(
      [
        "client_id,first_name,last_name,dob,program_code\n" +
          "1,Ann,Lee,01/02/1990,A\n2,Bo,Ray,03/04/1985,B\n",
      ],
      "clients.csv",
      { type: "text/csv" },
    ),
  );
  await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
  expectNoAccessibilityViolations(app.container, { page: true });
  await activate(control("button", "Continue to matching & sharing"));

  await expectHeadingFocused("Matching & sharing");
  expectNoAccessibilityViolations(app.container, { page: true });
  await activate(control("button", "Continue to review & create"));

  await expectHeadingFocused(/Review/);
  expectNoAccessibilityViolations(app.container, { page: true });
  await activate(control("button", "Create the invitation"));

  await expectHeadingFocused("Your invitation is ready");
  expectNoAccessibilityViolations(app.container, { page: true });
  await tabTo(control("button", "Copy invitation link"));
  await vi.waitFor(() => expect(runs.calls).toHaveLength(1));
  return runs.calls[0] as CapturedRun;
}

test("invite: file, matching, review and the created invitation, then the result, from the keyboard", async () => {
  const run = await inviteByKeyboard();
  run.onStages(
    stagesFor(
      minimalPreparedExchange({
        linkageTerms: getDefaultLinkageTerms("Keyboard journey"),
      }),
    ),
  );
  run.onStage("waiting for peer");
  run.onStage("confirming protocol");
  run.onResult({
    kind: "matched",
    resultsUrl: URL.createObjectURL(new Blob(["a,b\n"])),
    matchedRecordCount: 12,
  });

  await expectHeadingFocused("Exchange complete");
  expectNoAccessibilityViolations(app.container, { page: true });
  await tabTo(control("link", "Download result: results.csv"));
});

test("invite: a failed run takes focus and its retry is reachable from the keyboard", async () => {
  expectConsole("error", "Error: transport");
  const run = await inviteByKeyboard();
  run.onStage("waiting for peer");
  run.onError({ category: "exchange", error: new Error("transport") });

  await expect
    .poll(() => document.activeElement?.textContent ?? "")
    .toContain("Exchange failed");
  expectNoAccessibilityViolations(app.container, { page: true });
  await activate(control("button", "Try again"));
  await vi.waitFor(() => expect(runs.calls).toHaveLength(2));
  await expectHeadingFocused("Your invitation is ready");
});
