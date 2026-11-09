/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";
import { createElement } from "react";

import { page } from "vitest/browser";

import "@mantine/core/styles.css";

import { AsyncConfirmButton } from "@components/AsyncConfirmButton";

import { createAppMount, flushPendingUpdates } from "./renderApp";

// The confirm the destructive steps on a saved exchange share: it closes only
// on a step that took, so a rejected one never displays as done.

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

test("a rejected step keeps the confirm open with the failure, and a retry that takes closes it", async () => {
  const attempts: Array<"rejected" | "resolved"> = [];
  app.render(
    createElement(AsyncConfirmButton, {
      triggerLabel: "Clear the records",
      title: "Clear the records",
      confirmLabel: "Clear them",
      failureTitle: "Nothing was cleared",
      failureText: "The records were not removed. Nothing changed; try again.",
      onConfirm: () => {
        if (attempts.length === 0) {
          attempts.push("rejected");
          return Promise.reject(new Error("store failed"));
        }
        attempts.push("resolved");
        return Promise.resolve();
      },
      children: "These records have no other copy.",
    }),
  );

  await page.getByRole("button", { name: "Clear the records" }).click();
  const dialog = page.getByRole("dialog", { name: "Clear the records" });
  await expect.element(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Clear them" }).click();
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent(
      "Nothing was clearedThe records were not removed. Nothing changed; try again.",
    );
  await expect.element(dialog).toBeVisible();
  expect(attempts).toEqual(["rejected"]);

  await dialog.getByRole("button", { name: "Clear them" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(attempts).toEqual(["rejected", "resolved"]);
});
