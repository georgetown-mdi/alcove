/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import { WorkShell } from "@exchange/WorkShell";

import { axeViolations } from "./axeScan";
import { createAppMount } from "./renderApp";
import { expectStepAccessible } from "./stepChecks";

const app = createAppMount();

afterEach(app.unmount);

// The theme's controls keep their contrast under the pointer, so the hover
// state that fails here comes from this test's own rule.
const HOVER_ONLY_FAILURE = `
  .step-checks-probe { color: #000000; background: #ffffff; border: 0; }
  .step-checks-probe:hover { color: #b0b0b0; }
`;

// A control under a resting pointer paints its hover colours, which axe
// measures below 4.5:1; the step checks read it in its resting state.
test("the step checks scan a control the pointer rests on in its resting state", async () => {
  app.render(
    createElement(
      "main",
      null,
      createElement("style", null, HOVER_ONLY_FAILURE),
      createElement("h1", null, "Confirm your columns"),
      createElement(
        "button",
        { type: "button", className: "step-checks-probe" },
        "Start the exchange",
      ),
    ),
  );
  await expect
    .poll(() => app.container.querySelector(".step-checks-probe"))
    .not.toBeNull();
  const button = app.container.querySelector(
    ".step-checks-probe",
  ) as HTMLElement;
  await userEvent.hover(button);
  await expect.poll(() => button.matches(":hover")).toBe(true);
  expect((await axeViolations(app.container)).map(({ rule }) => rule)).toEqual([
    "color-contrast",
  ]);

  await expectStepAccessible(app.container);
});

// The work shell reorders its ledger and work column at 320 px; the journey
// goes on from the control it reached.
test("the step checks leave focus on the control the journey reached", async () => {
  app.render(
    createElement(WorkShell, {
      ledger: createElement("aside", { "aria-label": "Exchange" }, "Terms"),
      children: [
        createElement("h1", { key: "heading" }, "Confirm your columns"),
        createElement(
          "button",
          { key: "start", type: "button" },
          "Start the exchange",
        ),
      ],
    }),
  );
  const button = page.getByRole("button", { name: "Start the exchange" });
  await expect.element(button).toBeInTheDocument();
  button.element().focus();
  await expect.element(button).toHaveFocus();

  await expectStepAccessible(app.container);

  await expect.element(button).toHaveFocus();
});
