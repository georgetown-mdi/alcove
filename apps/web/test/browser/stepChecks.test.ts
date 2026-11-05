/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";
import { Button } from "@mantine/core";

import { axeViolations } from "./axeScan";
import { createAppMount } from "./renderApp";
import { expectStepAccessible } from "./stepChecks";

import type { ComponentType, ReactNode } from "react";

const FilledButton = Button as unknown as ComponentType<{
  children?: ReactNode;
}>;

const app = createAppMount();

afterEach(app.unmount);

// A light filled-primary button under a resting pointer paints its hover fill,
// which axe measures below 4.5:1; the step checks read it in its resting state.
test("the step checks scan a control the pointer rests on in its resting state", async () => {
  app.render(
    createElement(
      "main",
      null,
      createElement("h1", null, "Confirm your columns"),
      createElement(FilledButton, null, "Start the exchange"),
    ),
    { forceColorScheme: "light" },
  );
  await expect
    .poll(() => app.container.querySelector(".mantine-Button-root"))
    .not.toBeNull();
  const button = app.container.querySelector(
    ".mantine-Button-root",
  ) as HTMLElement;
  await userEvent.hover(button);
  await expect.poll(() => button.matches(":hover")).toBe(true);
  expect((await axeViolations(app.container)).map(({ rule }) => rule)).toEqual([
    "color-contrast",
  ]);

  await expectStepAccessible(app.container);
});
