/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";
import { createElement } from "react";

import { page, userEvent } from "vitest/browser";

import "@mantine/core/styles.css";

import { Tooltip } from "@mantine/core";

import { StandardizationPreview } from "@components/StandardizationPreview";
import { columnSamplesFromRows } from "@psi/columnSamples";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { tabTo } from "./keyboardOnly";

// WCAG 1.4.13 over the app's tooltips, which take their defaults from the
// theme (theme.ts): a tooltip shown on hover or focus can be dismissed with
// Escape, and the pointer can move onto it.

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

function mountTooltip(overrides: { interactive?: boolean } = {}) {
  app.render(
    createElement(
      "div",
      { style: { padding: "80px" } },
      createElement(
        Tooltip,
        {
          label: "What this heading means, at some length",
          multiline: true,
          w: 250,
          events: { hover: true, focus: true, touch: true },
          ...overrides,
        },
        createElement("button", { type: "button" }, "Info"),
      ),
    ),
  );
}

// The cleaning preview's badges show their detail only in a tooltip, so each
// badge is a Tab stop whose focus opens it.
test("the cleaning preview's badges open their detail from the keyboard", async () => {
  app.render(
    createElement(StandardizationPreview, {
      field: {
        name: "fn",
        type: "first_name",
        constraints: { allowedCharacters: "A-Z " },
      },
      inputColumn: "n",
      steps: [{ function: "remove_dashes" }],
      columnSamples: columnSamplesFromRows(
        [{ n: "---" }, { n: "mary" }],
        ["n"],
      ),
    }),
  );
  await expect
    .element(page.getByRole("img", { name: /^Cleaned to an empty value/ }))
    .toBeInTheDocument();

  await tabTo(
    (focused) =>
      focused.getAttribute("aria-label")?.startsWith("Cleaned to") === true,
  );
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  expect(page.getByRole("tooltip").element().textContent).toContain(
    "still takes part in matching as an empty key",
  );
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();

  await tabTo(
    (focused) =>
      focused.getAttribute("aria-label")?.startsWith("Constraint warning") ===
      true,
  );
  await expect.element(page.getByRole("tooltip")).toBeVisible();
});

test("Escape dismisses a tooltip its trigger's focus opened", async () => {
  mountTooltip();
  await userEvent.tab();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});

/** Well past the time a tooltip the pointer has left takes to close: Mantine
 * gives it no close delay and a 100 ms exit transition. */
const TOOLTIP_CLOSE_WAIT_MS = 500;

/** Moves the pointer from the trigger onto the open tooltip, a real pointer
 * move the browser delivers, and rests it there past the close time. `force`
 * skips the runner's wait for the tooltip to take pointer events, so the
 * control case below can move onto a tooltip that does not. */
async function restPointerOnTooltip(): Promise<void> {
  await userEvent.hover(page.getByRole("button", { name: "Info" }));
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  await userEvent.hover(page.getByRole("tooltip"), { force: true });
  await new Promise((resolve) => setTimeout(resolve, TOOLTIP_CLOSE_WAIT_MS));
}

test("a tooltip stays open while the pointer moves onto it and rests there", async () => {
  mountTooltip();
  await restPointerOnTooltip();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
});

test("without the theme's setting, the same move closes the tooltip", async () => {
  mountTooltip({ interactive: false });
  await restPointerOnTooltip();
  expect(page.getByRole("tooltip").query()).toBeNull();
});
