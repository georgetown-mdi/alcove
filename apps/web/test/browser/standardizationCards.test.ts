/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useState } from "react";

import { authoredLinkageFields } from "@alcove/core";

import {
  MAX_PEOPLE_PER_VALUE_REFUSAL,
  transformationWithCleaningSettings,
} from "@psi/standardizationAuthoring";
import { StandardizationCards } from "@components/StandardizationCards";
import { columnSamplesFromRows } from "@psi/columnSamples";

import { createAppMount } from "./renderApp";
import { expandFieldCards } from "./fieldCards";

import type { Metadata, Standardization } from "@alcove/core";
import type { CleaningSettings } from "@psi/standardizationAuthoring";

const app = createAppMount();

afterEach(app.unmount);

// Two first_name columns (a maiden and a current name) plus a date, so a same-typed
// field has a second column free to bind -- the multi-field scenario the add/remove
// affordances exist for.
const metadata: Metadata = [
  { name: "maiden_col", type: "first_name", role: "linkage", isPayload: false },
  {
    name: "current_col",
    type: "first_name",
    role: "linkage",
    isPayload: false,
  },
  { name: "dob_col", type: "date_of_birth", role: "linkage", isPayload: false },
];
const rawRows = [{ maiden_col: "Smith", current_col: "Jones", dob_col: "X" }];
const columnSamples = columnSamplesFromRows(
  rawRows,
  metadata.map((column) => column.name),
);

type CardsProps = Parameters<typeof StandardizationCards>[0];

function render(
  standardization: Standardization,
  overrides: Partial<CardsProps> = {},
) {
  app.render(
    createElement(StandardizationCards, {
      standardization,
      declaredFields: authoredLinkageFields(metadata, standardization),
      metadata,
      columnSamples,
      onStepsChange: () => {},
      onInputColumnChange: () => {},
      onMissingField: "skip",
      ...overrides,
    }),
  );
}

describe("StandardizationCards: per-field binding and multi-field affordances", () => {
  // One first_name field plus a date: the first_name type has a second column free,
  // so the "add another" affordance is offered when the host supplies onAddField.
  const oneNameField: Standardization = [
    { output: "first_name", input: "maiden_col", steps: [] },
    { output: "date_of_birth", input: "dob_col", steps: [] },
  ];

  test("the input-column binding is a labelled combobox when the type has more than one column", async () => {
    render(oneNameField);
    // Cards start collapsed to their label; expand to reach the binding control.
    await expandFieldCards();
    // The shared StandardizationStepEditor renders the binding as a Mantine Select
    // named by its label; reachable by role + accessible name on both pages.
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }))
      .toBeInTheDocument();
  });

  test("the add-another-field affordance fires onAddField with the type when a free column exists", async () => {
    const onAddField = vi.fn<(type: string) => void>();
    render(oneNameField, { onAddField });
    const addButton = page.getByRole("button", {
      name: "Add another first name field",
    });
    await expect.element(addButton).toBeInTheDocument();
    await userEvent.click(addButton);
    // The component gates the affordance (a free column of the type exists) and emits
    // only the type; the host owns the append behavior.
    expect(onAddField).toHaveBeenCalledWith("first_name");
  });

  test("no add affordance when onAddField is omitted (the acceptor case)", async () => {
    render(oneNameField);
    await expandFieldCards();
    // Wait for the cards to commit before asserting the affordance's absence.
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Add another first name field" })
        .elements(),
    ).toHaveLength(0);
  });

  test("a same-typed pair offers one remove control per field and fires onRemoveField", async () => {
    // Two first_name fields bound to distinct columns: each is removable. With both
    // columns bound there is no free one, so no add control is offered.
    const twoNameFields: Standardization = [
      { output: "first_name", input: "maiden_col", steps: [] },
      { output: "first_name_2", input: "current_col", steps: [] },
      { output: "date_of_birth", input: "dob_col", steps: [] },
    ];
    const onRemoveField = vi.fn<(output: string) => void>();
    render(twoNameFields, { onAddField: () => {}, onRemoveField });
    // Cards start collapsed; expand them to reach the per-field remove controls.
    await expandFieldCards();
    // One remove control per same-typed field (two), none for the lone date.
    await expect
      .poll(
        () =>
          page.getByRole("button", { name: "Remove this field" }).elements()
            .length,
      )
      .toBe(2);
    // Both columns are bound, so no free one and no add control.
    expect(
      page
        .getByRole("button", { name: "Add another first name field" })
        .elements(),
    ).toHaveLength(0);
    await userEvent.click(
      page.getByRole("button", { name: "Remove this field" }).first(),
    );
    expect(onRemoveField).toHaveBeenCalledWith("first_name");
  });

  test("no remove control on a lone field, nor when onRemoveField is omitted", async () => {
    const twoNameFields: Standardization = [
      { output: "first_name", input: "maiden_col", steps: [] },
      { output: "first_name_2", input: "current_col", steps: [] },
    ];
    // A same-typed pair, but no onRemoveField supplied: the affordance never renders.
    render(twoNameFields);
    await expandFieldCards();
    // Wait for the cards to commit before asserting the affordance's absence.
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }).first())
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Remove this field" }).elements(),
    ).toHaveLength(0);
  });
});

describe("StandardizationCards: the limit and last-name rule beside the steps", () => {
  const ruled: Standardization = [
    {
      output: "first_name",
      input: "maiden_col",
      steps: [],
      maxPeoplePerValue: 3,
      nullIfLastName: { values: ["JOHN"], lastNames: ["DOE"] },
    },
  ];
  const unruled: Standardization = [
    { output: "first_name", input: "maiden_col", steps: [] },
  ];

  type SettingsSpy = (output: string, settings: CleaningSettings) => void;

  /** The cards over a standardization they edit in place, as a host does. */
  function StatefulCards({
    initial,
    onCleaningSettingsChange,
  }: {
    initial: Standardization;
    onCleaningSettingsChange: SettingsSpy;
  }) {
    const [standardization, setStandardization] = useState(initial);
    return createElement(StandardizationCards, {
      standardization,
      declaredFields: authoredLinkageFields(metadata, standardization),
      metadata,
      columnSamples,
      onStepsChange: () => {},
      onInputColumnChange: () => {},
      onMissingField: "skip",
      onCleaningSettingsChange: (output, settings) => {
        onCleaningSettingsChange(output, settings);
        setStandardization((current) =>
          current.map((transformation) =>
            transformation.output === output
              ? transformationWithCleaningSettings(transformation, settings)
              : transformation,
          ),
        );
      },
    });
  }

  function renderStateful(initial: Standardization) {
    const onCleaningSettingsChange = vi.fn<SettingsSpy>();
    app.render(
      createElement(StatefulCards, { initial, onCleaningSettingsChange }),
    );
    return onCleaningSettingsChange;
  }

  const limitInput = () =>
    page.getByRole("textbox", { name: "Most people who may share one value" });
  const valuesInput = () =>
    page.getByPlaceholder("Type a value and press Enter");

  test("a field's card shows the limit and the rule it states", async () => {
    renderStateful(ruled);
    await expandFieldCards();
    await expect.element(limitInput()).toHaveValue("3");
    await expect
      .element(page.getByText("JOHN", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("DOE", { exact: true }))
      .toBeInTheDocument();
  });

  test("editing the limit emits it with the rule kept, and clearing it removes it", async () => {
    const onChange = renderStateful(ruled);
    await expandFieldCards();
    await userEvent.fill(limitInput(), "2");
    expect(onChange).toHaveBeenLastCalledWith("first_name", {
      maxPeoplePerValue: 2,
      nullIfLastName: { values: ["JOHN"], lastNames: ["DOE"] },
    });
    await userEvent.clear(limitInput());
    expect(onChange).toHaveBeenLastCalledWith("first_name", {
      nullIfLastName: { values: ["JOHN"], lastNames: ["DOE"] },
    });
  });

  test("a limit the configuration schema refuses is marked", async () => {
    renderStateful(unruled);
    await expandFieldCards();
    await userEvent.fill(limitInput(), "0");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(MAX_PEOPLE_PER_VALUE_REFUSAL);
  });

  test("a value typed into the rule emits the rule", async () => {
    const onChange = renderStateful(unruled);
    await expandFieldCards();
    await userEvent.click(valuesInput());
    await userEvent.keyboard("JANE{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("first_name", {
      nullIfLastName: { values: ["JANE"], lastNames: [] },
    });
  });

  test("a rule with one list empty says it drops nothing until both are filled", async () => {
    renderStateful(unruled);
    await expandFieldCards();
    await userEvent.click(valuesInput());
    await userEvent.keyboard("JANE{Enter}");
    const lastNameNote = page.getByText(
      "Add at least one last name, or this rule drops nothing.",
    );
    await expect.element(lastNameNote).toBeInTheDocument();
    await userEvent.click(
      page.getByPlaceholder("Type a last name and press Enter"),
    );
    await userEvent.keyboard("DOE{Enter}");
    await expect.element(lastNameNote).not.toBeInTheDocument();
    expect(
      page
        .getByText("Add at least one value, or this rule drops nothing.")
        .elements(),
    ).toHaveLength(0);
  });

  test("a value the field's cleaning changes is flagged with its cleaned form", async () => {
    renderStateful([
      {
        output: "first_name",
        input: "maiden_col",
        steps: [{ function: "to_upper_case" }],
      },
    ]);
    await expandFieldCards();
    await userEvent.click(valuesInput());
    await userEvent.keyboard("john{Enter}JANE{Enter}");
    await expect
      .element(
        page.getByText(
          'This field\'s cleaning turns "john" into "JOHN", so it never matches. Enter "JOHN" instead.',
        ),
      )
      .toBeInTheDocument();
    expect(page.getByText(/turns "JANE"/).elements()).toHaveLength(0);
  });

  test("the limit cannot be stepped below one person", async () => {
    renderStateful([
      {
        output: "first_name",
        input: "maiden_col",
        steps: [],
        maxPeoplePerValue: 2,
      },
    ]);
    await expandFieldCards();
    const down = page.getByRole("button", {
      name: "One fewer person of shared-value limit",
    });
    await expect.element(down).toBeEnabled();
    await userEvent.click(down);
    await expect.element(limitInput()).toHaveValue("1");
    await expect.element(down).toBeDisabled();
  });

  test("the controls say coverage counts are taken before they apply", async () => {
    renderStateful(unruled);
    await expandFieldCards();
    await expect
      .element(
        page.getByText(
          "Coverage counts on this screen are taken before the limit and the last-name rule apply.",
        ),
      )
      .toBeInTheDocument();
  });

  test("no settings controls when the host does not edit them (the acceptor case)", async () => {
    render(ruled);
    await expandFieldCards();
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }))
      .toBeInTheDocument();
    expect(limitInput().elements()).toHaveLength(0);
    expect(valuesInput().elements()).toHaveLength(0);
  });
});

describe("StandardizationCards: an ssn4 field derived from an ssn column", () => {
  test("offers the ssn columns it may be derived from", async () => {
    const ssnMetadata: Metadata = [
      { name: "ssn_a", type: "ssn", role: "linkage", isPayload: false },
      { name: "ssn_b", type: "ssn", role: "linkage", isPayload: false },
    ];
    const standardization: Standardization = [
      { output: "ssn4", input: "ssn_a", steps: [] },
    ];
    app.render(
      createElement(StandardizationCards, {
        standardization,
        declaredFields: authoredLinkageFields(ssnMetadata, standardization),
        metadata: ssnMetadata,
        columnSamples: columnSamplesFromRows(
          [{ ssn_a: "078-05-1120", ssn_b: "219-09-9999" }],
          ["ssn_a", "ssn_b"],
        ),
        onStepsChange: () => {},
        onInputColumnChange: () => {},
        onMissingField: "throw",
      }),
    );
    await expandFieldCards();
    await expect
      .element(page.getByRole("combobox", { name: "Column to clean" }))
      .toBeInTheDocument();
  });
});
