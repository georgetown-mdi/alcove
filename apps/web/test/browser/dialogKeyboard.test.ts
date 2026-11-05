/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";
import { createElement } from "react";

import { page, userEvent } from "vitest/browser";

import "@mantine/core/styles.css";

import { ConfirmedActionButton } from "@components/ConfirmedActionButton";

import { activate, control } from "./keyboardOnly";
import { createAppMount, flushPendingUpdates } from "./renderApp";
import { expectNoAccessibilityViolations } from "./accessibilityRules";
import { expectNoAxeViolations } from "./axeScan";

// A confirm dialog opened from the keyboard holds focus while open, passes
// both scans, and lets the keyboard out with Escape back to its trigger
// (WCAG 2.1.2, 2.4.3). No dialog in the app turns Escape off
// (test/unit/wcagSourceChecks.test.ts).

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

test("Escape closes a confirm the keyboard opened and returns focus to its trigger", async () => {
  app.render(
    createElement(ConfirmedActionButton, {
      label: "Remove this exchange",
      variant: "danger",
      statement: "This removes the saved exchange from this browser.",
      onConfirm: () => undefined,
    }),
  );
  await expect
    .element(page.getByRole("button", { name: "Remove this exchange" }))
    .toBeInTheDocument();
  await activate(control("button", "Remove this exchange"));

  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect
    .poll(() => dialog.element().contains(document.activeElement))
    .toBe(true);
  expectNoAccessibilityViolations(dialog.element());
  await expectNoAxeViolations(dialog.element());

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect
    .poll(() => document.activeElement?.textContent)
    .toBe("Remove this exchange");
});
