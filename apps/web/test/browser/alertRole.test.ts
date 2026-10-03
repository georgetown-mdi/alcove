/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { Alert } from "@mantine/core";

import { alertRoleFor } from "@theme";

import { createAppMount } from "./renderApp";

// The live-region role an Alert renders with under the app's theme: a polite
// status for a hint or warning, the interrupting alert only where the call site
// asks for it.

const app = createAppMount();

afterEach(app.unmount);

test("an Alert that sets no role is a polite status, not an interrupting alert", async () => {
  app.render(createElement(Alert, { color: "yellow", title: "A warning" }));
  await expect
    .element(page.getByRole("status"))
    .toMatchTextContent("A warning");
  expect(page.getByRole("alert").query()).toBeNull();
});

test("an error Alert keeps the role it sets", async () => {
  app.render(
    createElement(Alert, {
      color: "red",
      role: alertRoleFor("red"),
      title: "An error",
    }),
  );
  await expect.element(page.getByRole("alert")).toMatchTextContent("An error");
});

test("a runtime color other than red takes the polite default", async () => {
  app.render(
    createElement(Alert, {
      color: "green",
      role: alertRoleFor("green"),
      title: "Verified",
    }),
  );
  await expect.element(page.getByRole("status")).toMatchTextContent("Verified");
});
