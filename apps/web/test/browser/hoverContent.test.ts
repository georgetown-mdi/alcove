/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";
import { createElement } from "react";

import { page, userEvent } from "vitest/browser";

import "@mantine/core/styles.css";

import { Tooltip } from "@mantine/core";

import { createAppMount, flushPendingUpdates } from "./renderApp";

// WCAG 1.4.13 over the app's tooltips, which take their defaults from the
// theme (theme.ts): a tooltip shown on hover or focus can be dismissed with
// Escape, and the pointer can move onto it.

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

function mountTooltip() {
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
        },
        createElement("button", { type: "button" }, "Info"),
      ),
    ),
  );
}

test("Escape dismisses a tooltip its trigger's focus opened", async () => {
  mountTooltip();
  await userEvent.tab();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});

// The runner moves the pointer in one jump, which crosses no point between
// the trigger and the tooltip, so this holds the setting that makes a tooltip
// hoverable rather than driving a pointer across to it.
test("a tooltip takes pointer events, so the pointer can rest on it", async () => {
  mountTooltip();
  await userEvent.hover(page.getByRole("button", { name: "Info" }));
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toBeVisible();
  expect(getComputedStyle(tooltip.element()).pointerEvents).toBe("auto");
});
