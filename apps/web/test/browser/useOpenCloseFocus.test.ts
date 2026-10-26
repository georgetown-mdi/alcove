/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement, useLayoutEffect, useState } from "react";

import { useOpenCloseFocus } from "@components/useOpenCloseFocus";

import { createAppMount } from "./renderApp";

// A click can arrive while an earlier render's effects are still waiting to
// run, as it can on a loaded machine; the earlier render's effects then run
// after the click's handler and before the render it causes. The harness
// makes that order certain: a render outside any event clicks from its
// layout effect, before its own effects have run.

const app = createAppMount();

afterEach(app.unmount);

type Click = "open" | "remove";

function Harness({ click }: { click: Click | undefined }) {
  const [open, setOpen] = useState(false);
  const [isSet, setIsSet] = useState(true);
  const { fieldRef, actionRef, focusFieldNext, focusActionNext } =
    useOpenCloseFocus<HTMLTextAreaElement>();
  useLayoutEffect(() => {
    if (click === undefined) return;
    const label = click === "open" ? "Change" : "Remove";
    document
      .querySelectorAll("button")
      .forEach((button) => button.textContent === label && button.click());
  }, [click]);

  if (open)
    return createElement("textarea", { ref: fieldRef, "aria-label": "Field" });
  if (!isSet)
    return createElement("button", { ref: actionRef, type: "button" }, "Set");
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        ref: actionRef,
        type: "button",
        onClick: () => {
          focusFieldNext();
          setOpen(true);
        },
      },
      "Change",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          focusActionNext();
          setIsSet(false);
        },
      },
      "Remove",
    ),
  );
}

// Re-rendered from a timer so the render runs outside any event, and its
// effects wait for a later task.
function rerenderOutsideAnEvent(click: Click): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(() => {
      app.render(createElement(Harness, { click }));
      resolve();
    }, 0),
  );
}

test("opening takes focus to the field when an earlier render's effects run after the click", async () => {
  app.render(createElement(Harness, { click: undefined }));
  await expect
    .element(page.getByRole("button", { name: "Change" }))
    .toBeInTheDocument();

  await rerenderOutsideAnEvent("open");

  const field = page.getByRole("textbox", { name: "Field" });
  await expect.element(field).toBeInTheDocument();
  await expect.element(field).toHaveFocus();
});

test("removing takes focus to the new action when an earlier render's effects run after the click", async () => {
  app.render(createElement(Harness, { click: undefined }));
  await expect
    .element(page.getByRole("button", { name: "Remove" }))
    .toBeInTheDocument();

  await rerenderOutsideAnEvent("remove");

  const action = page.getByRole("button", { name: "Set", exact: true });
  await expect.element(action).toBeInTheDocument();
  await expect.element(action).toHaveFocus();
});
