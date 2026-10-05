/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement, useState } from "react";

import { NamedStepNumberInput } from "@components/NamedStepNumberInput";

import { createAppMount } from "./renderApp";

const app = createAppMount();

afterEach(() => {
  app.unmount();
});

interface FieldSpec {
  label: string;
  fieldName: string;
  initial: number;
  min: number;
  max: number;
  step: number;
}

function StepForm({ fields }: { fields: Array<FieldSpec> }) {
  const [values, setValues] = useState(fields.map((field) => field.initial));
  return createElement(
    "form",
    null,
    fields.map((field, index) =>
      createElement(NamedStepNumberInput, {
        key: field.label,
        label: field.label,
        stepUnit: "day",
        fieldName: field.fieldName,
        value: values[index],
        min: field.min,
        max: field.max,
        step: field.step,
        onChange: (value) =>
          setValues((current) =>
            current.map((old, at) =>
              at === index && typeof value === "number" ? value : old,
            ),
          ),
      }),
    ),
  );
}

const MAX_AGE: FieldSpec = {
  label: "Maximum age in days",
  fieldName: "maximum age",
  initial: 2,
  min: 1,
  max: 3,
  step: 1,
};

const INTERVAL: FieldSpec = {
  label: "A window opens every (days)",
  fieldName: "window interval",
  initial: 10,
  min: 5,
  max: 15,
  step: 5,
};

function field(spec: FieldSpec): HTMLInputElement {
  return page.getByLabelText(spec.label).element() as HTMLInputElement;
}

describe("NamedStepNumberInput step buttons", () => {
  test("two fields sharing a unit give their buttons distinct names", async () => {
    app.render(createElement(StepForm, { fields: [MAX_AGE, INTERVAL] }));
    await expect.element(page.getByLabelText(INTERVAL.label)).toBeVisible();

    const names = Array.from(
      document.querySelectorAll("button[aria-label]"),
      (button) => button.getAttribute("aria-label"),
    );
    expect(names).toEqual([
      "One more day of maximum age",
      "One fewer day of maximum age",
      "5 more days of window interval",
      "5 fewer days of window interval",
    ]);
    for (const button of document.querySelectorAll("button[aria-label]")) {
      expect(button.getAttribute("tabindex")).toBe("-1");
    }
  });

  test.each([MAX_AGE, INTERVAL])(
    "the $fieldName buttons move the value by the step, stop at the bounds and return focus",
    async (spec) => {
      app.render(createElement(StepForm, { fields: [spec] }));
      const unit = spec.step === 1 ? "day" : "days";
      const amount = spec.step === 1 ? "One" : String(spec.step);
      const up = page.getByRole("button", {
        name: `${amount} more ${unit} of ${spec.fieldName}`,
      });
      const down = page.getByRole("button", {
        name: `${amount} fewer ${unit} of ${spec.fieldName}`,
      });

      await up.click();
      await expect.poll(() => field(spec).value).toBe(String(spec.max));
      expect(document.activeElement).toBe(field(spec));
      await expect.element(up).toBeDisabled();
      await expect.element(down).toBeEnabled();

      await down.click();
      await expect.poll(() => field(spec).value).toBe(String(spec.initial));
      expect(document.activeElement).toBe(field(spec));

      await down.click();
      await expect.poll(() => field(spec).value).toBe(String(spec.min));
      expect(document.activeElement).toBe(field(spec));
      await expect.element(down).toBeDisabled();
      await expect.element(up).toBeEnabled();
    },
  );
});
