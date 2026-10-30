/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { Fragment, createElement, useState } from "react";

import "@mantine/core/styles.css";

import {
  AUTHORED_KEYS_FLOOR_NOTE,
  BUILT_IN_RULES_INFO,
  HIGHEST_PRECISION_UNAVAILABLE_REASON,
  MATCHING_KEYS_LESS_CERTAIN_REMEDY,
  OPENED_CONFIGURATION_KEYS_NOTE,
  USE_BUILT_IN_RULES_STATEMENT,
  declaredFieldsFor,
  editorFromCsv,
  editorWithAuthoredDraft,
  editorWithBuiltInKeys,
  editorWithColumnDisclosure,
  editorWithImportedTerms,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithPrecisionFloorSelection,
  keyOrderHelp,
  resetToRecommended,
} from "@psi/inviterEditor";
import { reviewValidation } from "@psi/inviterModel";

import {
  CONTACT_AND_LOCATION_FIELD_TYPES,
  LESS_CERTAIN_KEY_COPY,
  linkageKeyIsLessCertain,
  precisionFloorLabel,
} from "@alcove/core";

import {
  SINGLE_PASS_DISCLOSURE_BODY,
  SINGLE_PASS_DISCLOSURE_TITLE,
} from "@psi/linkageStrategyChoice";
import {
  USE_BUILT_IN_RULES_LABEL,
  addKey,
  buildAdvancedTerms,
} from "@psi/authoring/advancedInvite";

import { KeysTab } from "@exchange/KeysTab";
import { canonicalLinkageKeysAndFields } from "@console/loadedConfig";
import { consoleAcquiredCsv } from "@console/consoleAcquiredCsv";
import { keysFromOpenedConfiguration as derivedKeysFromOpenedConfiguration } from "@exchange/inviterScreenModel";
import { lessCertainInfoLabel } from "@components/LessCertainInfo";

import { activate, control } from "./keyboardOnly";
import { disclosureToggle, openDisclosure } from "./collapsePanels";
import { createAppMount } from "./renderApp";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { LinkageField } from "@alcove/core";
import type { MountedConfigurationState } from "@console/mountedConfiguration";

// A minimal file with a date_of_birth column, so the seeded default keys
// include one built from it (the element the dead-key transform below targets).
const csv: AcquiredCsv = {
  fileName: "clients.csv",
  sizeBytes: 1024,
  rawRows: [
    {
      client_id: "1",
      first_name: "Ann",
      last_name: "Lee",
      dob: "01/02/1990",
      ssn4: "1234",
    },
  ],
  columns: ["client_id", "first_name", "last_name", "dob", "ssn4"],
  rowCount: 1,
};

// Author a self-defeating parse_date onto the date_of_birth element of the
// first key: input_format "MM/DD" has no year, so every record's element
// resolves empty and the whole key runs to a silent empty result -- the same
// dead-key construction the model-level tests in inviterModel.test.ts use.
function withDeadDobKey(editor: ReturnType<typeof editorFromCsv>) {
  const keys = editor.draft.keys.map((entry, index) => {
    if (index !== 0) return entry;
    const elements = entry.key.elements.map((element) =>
      element.field === "date_of_birth"
        ? {
            ...element,
            transform: [
              { function: "parse_date", params: { inputFormat: "MM/DD" } },
            ],
          }
        : element,
    );
    return { ...entry, key: { ...entry.key, elements } };
  });
  return editorWithAuthoredDraft(editor, { ...editor.draft, keys });
}

const app = createAppMount();

function render(expertMode = false, deadDobKey = true) {
  const seeded = editorFromCsv("Dana Okafor", csv);
  const editor = deadDobKey ? withDeadDobKey(seeded) : seeded;
  app.render(
    createElement(KeysTab, {
      editor,
      csv,
      expertMode,
      onExpertMode: () => undefined,
      onPrecisionFloorSelection: () => undefined,
      onUseBuiltInRules: () => undefined,
      onKeyEnabled: () => undefined,
      onKeyMoved: () => undefined,
      onAuthoredDraft: () => undefined,
      onStrategy: () => undefined,
      onDeduplicate: () => undefined,
      onImport: () => [],
      keysError: undefined,
      announce: () => undefined,
      onBack: () => undefined,
    }),
  );
}

afterEach(app.unmount);

describe("KeysTab: the dead-key badge", () => {
  const deadKeyBadge = {
    name: "This key's cleaning drops every value; review the transform",
  };

  test("is absent from the guided list", async () => {
    render();

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();
    expect(page.getByRole("img", deadKeyBadge).elements()).toHaveLength(0);
    const body = document.body.textContent;
    expect(body).not.toContain("satisfiable");
    expect(body).not.toContain("cleaning drops every value");
  });

  test('reads "cleaning drops every value" in the expert editor', async () => {
    render(true);

    const badge = page.getByRole("img", deadKeyBadge);
    await expect.element(badge).toBeInTheDocument();
    await expect
      .element(badge)
      .toMatchTextContent("cleaning drops every value");
  });
});

describe("KeysTab: a file with a ZIP column", () => {
  // The same minimal file with a ZIP column, so the guided list includes the
  // built-in keys that read it.
  const withZip: AcquiredCsv = {
    ...csv,
    rawRows: [{ ...csv.rawRows[0], zip: "60614" }],
    columns: [...csv.columns, "zip"],
  };

  function renderFor(source: AcquiredCsv) {
    app.render(
      createElement(KeysTab, {
        editor: editorFromCsv("Dana Okafor", source),
        csv: source,
        expertMode: false,
        onExpertMode: () => undefined,
        onPrecisionFloorSelection: () => undefined,
        onUseBuiltInRules: () => undefined,
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onDeduplicate: () => undefined,
        onImport: () => [],
        keysError: undefined,
        announce: () => undefined,
        onBack: () => undefined,
      }),
    );
  }

  test("lists the built-in ZIP keys on, with no offer marked apart", async () => {
    renderFor(withZip);

    const zipKey = page.getByRole("checkbox", {
      name: /LN \+ FN \+ DOB \+ ZIP5/,
    });
    await expect.element(zipKey).toBeInTheDocument();
    await expect.element(zipKey).toBeChecked();

    const body = document.body.textContent;
    expect(body).not.toContain("outside the default set");
    expect(body).not.toContain("Phone number, email address and ZIP code");
  });

  test("states the shared-value caveat beside the ZIP keys", async () => {
    renderFor(withZip);

    await expect
      .element(
        page.getByRole("note").filter({
          hasText:
            "must hold each person's own, never that of a site that serves them.",
        }),
      )
      .toBeInTheDocument();
  });

  test("states the shared-value caveat beside a county key", async () => {
    // The file has no phone, email or ZIP column, so the caveat can only come
    // from the county key.
    renderFor({
      ...csv,
      rawRows: [{ ...csv.rawRows[0], county: "COOK" }],
      columns: [...csv.columns, "county"],
    });

    await expect
      .element(
        page.getByRole("note").filter({
          hasText:
            "must hold each person's own, never that of a site that serves them.",
        }),
      )
      .toBeInTheDocument();
  });

  test("names the street number in the shared-value caveat beside the street number key", async () => {
    renderFor({
      ...csv,
      rawRows: [{ ...csv.rawRows[0], house_number: "123", zip: "60614" }],
      columns: [...csv.columns, "house_number", "zip"],
    });

    const streetNumberKey = page.getByRole("checkbox", {
      name: /LN \+ FN \+ DOB \+ street number \+ ZIP5/,
    });
    await expect.element(streetNumberKey).toBeChecked();
    await expect
      .element(
        page.getByRole("note").filter({
          hasText:
            "A street number, ZIP code, state, or county column must hold " +
            "each person's own, never that of a site that serves them.",
        }),
      )
      .toBeInTheDocument();
  });

  test("states no shared-value caveat with no phone, email or ZIP key", async () => {
    renderFor(csv);

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain(
      "must hold each person's own, never that of a site that serves them.",
    );
  });
});

describe("KeysTab: the shared-value caveat follows the enabled keys", () => {
  const withContacts: AcquiredCsv = {
    ...csv,
    rawRows: [
      {
        ...csv.rawRows[0],
        zip: "60614",
        phone: "3125550100",
        email: "ann@example.org",
      },
    ],
    columns: [...csv.columns, "zip", "phone", "email"],
  };
  const caveat =
    "must hold each person's own, never that of a site that serves them.";

  function renderWith(turnOff: (type: string | undefined) => boolean) {
    const editor = editorFromCsv("Dana Okafor", withContacts);
    const typeOf = new Map(
      declaredFieldsFor(editor.draft).map((field) => [field.name, field.type]),
    );
    const keys = editor.draft.keys.map((entry) => ({
      ...entry,
      enabled:
        entry.enabled &&
        !entry.key.elements.some((element) =>
          turnOff(typeOf.get(element.field)),
        ),
    }));
    app.render(
      createElement(KeysTab, {
        editor: editorWithAuthoredDraft(editor, { ...editor.draft, keys }),
        csv: withContacts,
        expertMode: false,
        onExpertMode: () => undefined,
        onPrecisionFloorSelection: () => undefined,
        onUseBuiltInRules: () => undefined,
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onDeduplicate: () => undefined,
        onImport: () => [],
        keysError: undefined,
        announce: () => undefined,
        onBack: () => undefined,
      }),
    );
  }

  const isContact = (type: string | undefined) =>
    type !== undefined &&
    (CONTACT_AND_LOCATION_FIELD_TYPES as ReadonlyArray<string>).includes(type);

  test("is absent when every phone, email and ZIP key is turned off", async () => {
    renderWith(isContact);

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain(caveat);
  });

  test("is present when one such key is on", async () => {
    renderWith((type) => isContact(type) && type !== "zip_code");

    await expect
      .element(page.getByRole("note").filter({ hasText: caveat }))
      .toBeInTheDocument();
  });
});

describe("KeysTab: expert import/export over a rows-withheld console shape", () => {
  test("renders the terms import without reading the throwing rawRows getter", async () => {
    // The console acquires a server-side profile, not the rows, so its `rawRows` is
    // a getter that throws in dev/test. KeysTab must feed the import/export the
    // rows-withheld seed ([]), not the getter -- so expert mode renders rather than
    // crashing the screen.
    const consoleCsv = consoleAcquiredCsv({
      fileName: "clients.csv",
      sizeBytes: 4096,
      columns: ["client_id", "first_name", "last_name", "dob", "ssn4"],
      rowCount: 12408,
      dateInputFormats: new Map([["dob", "MM/DD/YYYY"]]),
    });
    const editor = editorFromCsv("Dana Okafor", consoleCsv);
    app.render(
      createElement(KeysTab, {
        editor,
        csv: consoleCsv,
        expertMode: true,
        onExpertMode: () => undefined,
        onPrecisionFloorSelection: () => undefined,
        onUseBuiltInRules: () => undefined,
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onDeduplicate: () => undefined,
        onImport: () => [],
        keysError: undefined,
        announce: () => undefined,
        onBack: () => undefined,
      }),
    );

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();
    // The import/export surface rendered -- proof the throwing getter was never read.
    await expect
      .element(
        page.getByLabelText(
          "Paste a JSON or YAML linkage-terms document to import",
        ),
      )
      .toBeInTheDocument();
  });
});

describe("KeysTab: the built-in rule choice and the less certain mark", () => {
  /** A configuration open on the console, whose run continues its exchange. */
  const OPENED_MOUNTED_CONFIGURATION: MountedConfigurationState = {
    status: "opened",
    carriedThrough: [],
    warnings: [],
  };

  /** The tab over a live session, applying each floor choice through the
   * session model the inviter screen applies it through. */
  function Harness({
    initial,
    file = csv,
    keysFromOpenedConfiguration = false,
    openedConfigurationKeys,
  }: {
    initial: InviterEditor;
    file?: AcquiredCsv;
    keysFromOpenedConfiguration?: boolean;
    /** An opened configuration's keys and fields
     * (`canonicalLinkageKeysAndFields`), from which the tab's
     * `keysFromOpenedConfiguration` is derived at each render, as the inviter
     * screen derives it. */
    openedConfigurationKeys?: string;
  }) {
    const [editor, setEditor] = useState(initial);
    return createElement(KeysTab, {
      editor,
      csv: file,
      expertMode: false,
      onExpertMode: () => undefined,
      onPrecisionFloorSelection: (selection) =>
        setEditor(editorWithPrecisionFloorSelection(editor, selection)),
      onUseBuiltInRules: () => setEditor(editorWithBuiltInKeys(editor, file)),
      keysFromOpenedConfiguration:
        openedConfigurationKeys === undefined
          ? keysFromOpenedConfiguration
          : derivedKeysFromOpenedConfiguration({
              editor,
              mountedConfiguration: OPENED_MOUNTED_CONFIGURATION,
              openedConfigurationKeys,
            }),
      onKeyEnabled: (index, enabled) =>
        setEditor(editorWithKeyEnabled(editor, index, enabled)),
      onKeyMoved: (index, offset) =>
        setEditor(editorWithKeyMoved(editor, index, offset)),
      onAuthoredDraft: () => undefined,
      onStrategy: () => undefined,
      onDeduplicate: () => undefined,
      onImport: () => [],
      keysError: undefined,
      announce: () => undefined,
      onBack: () => undefined,
    });
  }

  const at99 = precisionFloorLabel(99);
  const at95 = precisionFloorLabel(95);
  const nameAndDateKey = {
    name: /Key \d+ - LN \+ FN \+ DOB \(less certain\)$/,
  };

  test("offers each floor by its label alone, 95 chosen, and asks no coverage question", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    const floor99 = page.getByRole("radio", { name: at99 });
    const floor95 = page.getByRole("radio", { name: at95 });
    await expect.element(floor95).toBeChecked();
    await expect.element(floor99).not.toBeChecked();
    await expect.element(floor99).toBeEnabled();
    expect(floor99.element().getAttribute("aria-describedby")).toBeNull();
    expect(floor95.element().getAttribute("aria-describedby")).toBeNull();
    expect(document.body.textContent).not.toMatch(/tier/i);

    expect(page.getByRole("radiogroup").elements()).toHaveLength(2);
    expect(page.getByRole("radio", { name: "Yes", exact: true }).query()).toBe(
      null,
    );
    expect(document.body.textContent).not.toMatch(
      /metropolitan|one state|answer below/i,
    );
  });

  test("places the button beside the Built-in rules label, which names the choice alone", async () => {
    const { ssn4: _ssn4, ...namesAndDate } = csv.rawRows[0];
    const file: AcquiredCsv = {
      ...csv,
      rawRows: [namesAndDate],
      columns: Object.keys(namesAndDate),
    };
    app.render(
      createElement(Harness, {
        initial: editorFromCsv("Dana Okafor", file),
        file,
      }),
    );

    const info = page.getByRole("button", {
      name: "About the built-in rules",
      exact: true,
    });
    const group = page.getByRole("radiogroup", {
      name: "Built-in rules",
      exact: true,
    });
    await expect.element(group).toBeInTheDocument();
    await expect
      .element(group)
      .toHaveAccessibleDescription(
        "Changing this lists the rules it selects that your file supplies, " +
          "in the built-in order. Keys you turned off stay off, and keys it " +
          "adds are turned on.",
      );
    // Highest precision is unavailable here, so its reason widens the group.
    await expect
      .element(page.getByRole("radio", { name: at99 }))
      .toBeDisabled();

    const label = page.getByText("Built-in rules", { exact: true }).element();
    const labelBox = label.getBoundingClientRect();
    const infoBox = info.element().getBoundingClientRect();
    const groupBox = group.element().getBoundingClientRect();
    expect(infoBox.left - labelBox.right).toBeGreaterThanOrEqual(0);
    expect(infoBox.left - labelBox.right).toBeLessThan(12);
    const infoMiddle = (infoBox.top + infoBox.bottom) / 2;
    expect(infoMiddle).toBeGreaterThan(labelBox.top);
    expect(infoMiddle).toBeLessThan(labelBox.bottom);
    expect(infoBox.right).toBeLessThan(groupBox.right / 2);
  });

  test("explains the choices behind one button, read with each choice while open", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    expect(BUILT_IN_RULES_INFO.explanation).toBe(
      "Highest precision pairs a name or date of birth with an SSN, ZIP " +
        "code, or phone number. Published studies of similar rules suggest " +
        "no more than 1 in 100 of its matches are wrong. Broader matching " +
        "adds rules that find more people, with a few more wrong matches.",
    );
    const info = page.getByRole("button", {
      name: "About the built-in rules",
      exact: true,
    });
    await expect.element(info).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(
      info.element().getAttribute("aria-controls") ?? "",
    )!;
    const shown = `${BUILT_IN_RULES_INFO.explanation} How the rules were chosen`;
    await expect.poll(() => panel.textContent).toBe(shown);
    const explanation = page.elementLocator(panel).getByText(shown);
    await expect.element(explanation).not.toBeVisible();
    const floors = [
      page.getByRole("radio", { name: at99 }),
      page.getByRole("radio", { name: at95 }),
    ];
    for (const floor of floors)
      await expect.element(floor).toHaveAccessibleDescription("");

    await activate(control("button", "About the built-in rules"));
    await expect.element(info).toHaveAttribute("aria-expanded", "true");
    await expect.element(explanation).toBeVisible();
    const link = page
      .elementLocator(panel)
      .getByRole("link", { name: "How the rules were chosen" });
    await expect
      .element(link)
      .toHaveAttribute(
        "href",
        "https://data-bridge.org/docs/EXCHANGE_REFERENCE#choosing-the-built-in-rules",
      );
    await expect.element(link).toHaveAttribute("target", "_blank");
    await expect.element(link).toHaveAttribute("rel", "noreferrer");
    for (const floor of floors)
      await expect.element(floor).toHaveAccessibleDescription(shown);

    await activate(control("button", "About the built-in rules"));
    await expect.element(info).toHaveAttribute("aria-expanded", "false");
    for (const floor of floors)
      await expect.element(floor).toHaveAccessibleDescription("");
  });

  /** The tab over a live session, with buttons outside it that set the ssn4
   * column's role as the Columns step sets it, and the key error the inviter
   * screen passes it. */
  function RoleHarness({
    initial,
    file = csv,
  }: {
    initial: InviterEditor;
    file?: AcquiredCsv;
  }) {
    const [editor, setEditor] = useState(initial);
    const setSsn4Role = (role: "ignored" | "match") =>
      setEditor(editorWithColumnDisclosure(editor, file, "ssn4", role).editor);
    return createElement(
      Fragment,
      null,
      createElement(
        "button",
        { type: "button", onClick: () => setSsn4Role("ignored") },
        "Stop matching on ssn4",
      ),
      createElement(
        "button",
        { type: "button", onClick: () => setSsn4Role("match") },
        "Match on ssn4",
      ),
      createElement(KeysTab, {
        editor,
        csv: file,
        expertMode: false,
        onExpertMode: () => undefined,
        onPrecisionFloorSelection: (selection) =>
          setEditor(editorWithPrecisionFloorSelection(editor, selection)),
        onUseBuiltInRules: () => undefined,
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onDeduplicate: () => undefined,
        onImport: () => [],
        keysError: reviewValidation(editor).errors.keys,
        announce: () => undefined,
        onBack: () => undefined,
      }),
    );
  }

  test("disables highest precision while the columns supply none of its rules, keeping it chosen, and enables it again when a column role changes", async () => {
    app.render(
      createElement(RoleHarness, {
        initial: editorWithPrecisionFloorSelection(
          editorFromCsv("Dana Okafor", csv),
          { floor: 99 },
        ),
      }),
    );

    const floor99 = page.getByRole("radio", { name: at99 });
    const floor95 = page.getByRole("radio", { name: at95 });
    const ssn4Key = page.getByRole("checkbox", { name: /SSN4 \+ LN \+ DOB$/ });
    const keyItems = page.getByRole("list").getByRole("listitem");
    await expect.element(floor99).toBeChecked();
    await expect.element(floor99).toBeEnabled();
    await expect.element(ssn4Key).toBeChecked();

    await page.getByRole("button", { name: "Stop matching on ssn4" }).click();
    await expect.element(floor99).toBeDisabled();
    await expect.element(floor99).toBeChecked();
    expect(HIGHEST_PRECISION_UNAVAILABLE_REASON).toBe(
      "Needs stronger identifiers in your file, such as an SSN, ZIP code, " +
        "or phone number.",
    );
    await expect
      .element(floor99)
      .toHaveAccessibleDescription(HIGHEST_PRECISION_UNAVAILABLE_REASON);
    await expect.element(floor95).toBeEnabled();
    expect(keyItems.elements()).toHaveLength(0);
    expect(page.getByRole("alert").query()).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Turn on expert authoring to see which field",
    );

    await page.getByRole("button", { name: "Match on ssn4" }).click();
    await expect.element(floor99).toBeEnabled();
    await expect.element(floor99).toBeChecked();
    await expect.element(floor99).toHaveAccessibleDescription("");
    await expect.element(ssn4Key).toBeChecked();
  });

  test("keeps the Expert authoring message on a file no choice lists a rule for", async () => {
    const uncovered: AcquiredCsv = {
      fileName: "contacts.csv",
      sizeBytes: 64,
      rawRows: [
        { client_id: "1", email: "ann@example.org", phone: "555-123-4567" },
      ],
      columns: ["client_id", "email", "phone"],
      rowCount: 1,
    };
    app.render(
      createElement(RoleHarness, {
        initial: editorWithPrecisionFloorSelection(
          editorFromCsv("Dana Okafor", uncovered),
          { floor: 99 },
        ),
        file: uncovered,
      }),
    );

    await expect
      .element(page.getByRole("radio", { name: at99 }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent(/Turn on expert authoring/);
  });

  test("reseeds the key list on a floor choice", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    const nameAndDate = page.getByRole("checkbox", nameAndDateKey);
    await expect.element(nameAndDate).toBeInTheDocument();
    await expect
      .element(page.getByRole("checkbox", { name: /SSN4 \+ LN4 \+ YOB/ }))
      .toBeInTheDocument();

    await page.getByRole("radio", { name: at99 }).click();
    await expect.element(page.getByRole("radio", { name: at99 })).toBeChecked();
    expect(nameAndDate.query()).toBeNull();
    expect(
      page.getByRole("checkbox", { name: /SSN4 \+ LN4 \+ YOB/ }).query(),
    ).toBeNull();
    await expect
      .element(page.getByRole("checkbox", { name: /SSN4 \+ LN \+ DOB$/ }))
      .toBeChecked();

    await page.getByRole("radio", { name: at95 }).click();
    await expect.element(nameAndDate).toBeChecked();
  });

  test("states no rule-set citation when the keys leave the built-in order", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    app.render(createElement(Harness, { initial: seeded }));

    const firstName = seeded.draft.keys[0].key.name;
    await page.getByRole("button", { name: `Move ${firstName} later` }).click();
    await expect
      .element(page.getByRole("button", { name: `Move ${firstName} earlier` }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/citation/i);
  });

  test("is withheld on keys written in Expert authoring, with a note saying so", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    app.render(
      createElement(Harness, {
        initial: editorWithAuthoredDraft(
          seeded,
          addKey(seeded.draft, "first_name"),
        ),
      }),
    );

    await expect
      .element(
        page.getByRole("note").filter({ hasText: AUTHORED_KEYS_FLOOR_NOTE }),
      )
      .toBeInTheDocument();
    expect(page.getByRole("radio", { name: at99 }).query()).toBeNull();
  });

  test("keeps a key turned off across a floor change and back", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    const kept = page.getByRole("checkbox", { name: /SSN4 \+ LN \+ DOB$/ });
    await kept.click();
    await expect.element(kept).not.toBeChecked();

    await page.getByRole("radio", { name: at99 }).click();
    await expect.element(kept).not.toBeChecked();
    await page.getByRole("radio", { name: at95 }).click();
    await expect.element(kept).not.toBeChecked();
    await expect
      .element(page.getByRole("checkbox", nameAndDateKey))
      .toBeChecked();
  });

  test("marks the three name and date keys less certain, each with a button that explains why", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    for (const rule of [
      /Key \d+ - LN \+ FN \+ DOB \(less certain\)$/,
      /Key \d+ - swap\(LN, FN\) \+ DOB \(less certain\)$/,
      /Key \d+ - split\(LN\) \+ FN \+ DOB \(less certain\)$/,
    ])
      await expect
        .element(page.getByRole("checkbox", { name: rule }))
        .toBeChecked();
    await expect
      .element(page.getByRole("checkbox", { name: /SSN4 \+ LN \+ DOB$/ }))
      .toBeInTheDocument();
    const infoButtons = page.getByRole("button", { name: /less certain$/ });
    expect(
      infoButtons
        .elements()
        .map((button) => button.getAttribute("aria-label") ?? ""),
    ).toStrictEqual([
      "Why LN + FN + DOB is less certain",
      "Why swap(LN, FN) + DOB is less certain",
      "Why split(LN) + FN + DOB is less certain",
    ]);

    const name = lessCertainInfoLabel("LN + FN + DOB");
    const first = page.getByRole("button", { name, exact: true });
    await expect.element(first).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(
      first.element().getAttribute("aria-controls") ?? "",
    )!;
    expect(MATCHING_KEYS_LESS_CERTAIN_REMEDY.checkbox).toBe(
      "To leave one out, turn off its checkbox.",
    );
    const explained = `${LESS_CERTAIN_KEY_COPY.explanation} ${MATCHING_KEYS_LESS_CERTAIN_REMEDY.checkbox}`;
    await expect.poll(() => panel.textContent).toBe(explained);
    const explanation = page.elementLocator(panel).getByText(explained);
    await expect.element(explanation).not.toBeVisible();
    const marked = page.getByRole("checkbox", nameAndDateKey);
    await expect.element(marked).toHaveAccessibleDescription("");

    await activate(control("button", name));
    await expect.element(first).toHaveAttribute("aria-expanded", "true");
    await expect.element(explanation).toBeVisible();
    await expect.element(marked).toHaveAccessibleDescription(explained);

    await activate(control("button", name));
    await expect.element(first).toHaveAttribute("aria-expanded", "false");
    await expect.element(marked).toHaveAccessibleDescription("");
    expect(document.body.textContent).not.toContain(
      LESS_CERTAIN_KEY_COPY.acceptorRemedy,
    );

    await page.getByRole("radio", { name: at99 }).click();
    expect(infoButtons.elements()).toHaveLength(0);
  });

  function authoredNameAndDateKeys() {
    const seeded = editorFromCsv("Dana Okafor", csv);
    return editorWithAuthoredDraft(seeded, {
      ...seeded.draft,
      keys: [
        {
          enabled: true,
          key: {
            name: "my people",
            elements: [
              { field: "first_name" },
              { field: "date_of_birth" },
              { field: "last_name" },
            ],
          },
        },
        {
          enabled: true,
          key: {
            name: "my people with SSN4",
            elements: [
              { field: "first_name" },
              { field: "date_of_birth" },
              { field: "last_name" },
              { field: "ssn4" },
            ],
          },
        },
      ],
    });
  }

  test("marks a key written in Expert authoring on a name and a date of birth alone", async () => {
    app.render(createElement(Harness, { initial: authoredNameAndDateKeys() }));

    await expect
      .element(
        page.getByRole("checkbox", {
          name: "Key 1 - my people (less certain)",
          exact: true,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("checkbox", {
          name: "Key 2 - my people with SSN4",
          exact: true,
        }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: /less certain$/ }).elements(),
    ).toHaveLength(1);
    await expect
      .element(
        page.getByRole("button", {
          name: "Why my people is less certain",
          exact: true,
        }),
      )
      .toBeInTheDocument();
  });

  test("on keys an opened configuration states, the remedy is the configuration's update", async () => {
    app.render(
      createElement(Harness, {
        initial: authoredNameAndDateKeys(),
        keysFromOpenedConfiguration: true,
      }),
    );

    const name = lessCertainInfoLabel("my people");
    const info = page.getByRole("button", { name, exact: true });
    await expect.element(info).toBeInTheDocument();
    const panel = document.getElementById(
      info.element().getAttribute("aria-controls") ?? "",
    )!;
    expect(MATCHING_KEYS_LESS_CERTAIN_REMEDY.openedConfiguration).toBe(
      "To leave them out, delete them from linkage_keys in alcove.yaml, run " +
        "alcove update, and have your partner run alcove apply on what it " +
        "prints.",
    );
    await expect
      .poll(() => panel.textContent)
      .toBe(
        `${LESS_CERTAIN_KEY_COPY.explanation} ` +
          MATCHING_KEYS_LESS_CERTAIN_REMEDY.openedConfiguration,
      );
  });

  /** A loaded document whose field declarations type `retyped` apart from the
   * file's columns. */
  function documentTypingFieldsApart(retyped: ReadonlyArray<LinkageField>) {
    const seeded = editorFromCsv("Dana Okafor", csv);
    const loaded = editorWithImportedTerms(
      seeded,
      csv,
      buildAdvancedTerms(seeded.draft),
    );
    return editorWithAuthoredDraft(loaded, {
      ...loaded.draft,
      importedLinkageFields: (loaded.draft.importedLinkageFields ?? []).map(
        (field) =>
          retyped.find((candidate) => candidate.name === field.name) ?? field,
      ),
    });
  }

  function infoButtonLabels(): Array<string> {
    return page
      .getByRole("button", { name: /less certain$/ })
      .elements()
      .map((button) => button.getAttribute("aria-label") ?? "");
  }

  function labelsOfKeysMarkedByBuiltTerms(editor: InviterEditor) {
    const { linkageFields } = buildAdvancedTerms(editor.draft);
    return editor.draft.keys
      .filter((entry) => linkageKeyIsLessCertain(entry.key, linkageFields))
      .map((entry) => lessCertainInfoLabel(entry.key.name));
  }

  test("marks a key as the built terms type its fields where the document types one apart from its column", async () => {
    const editor = documentTypingFieldsApart([
      { name: "date_of_birth", type: "phone_number" },
    ]);
    app.render(createElement(Harness, { initial: editor }));

    await expect
      .element(page.getByRole("checkbox", nameAndDateKey))
      .toBeChecked();
    const expected = labelsOfKeysMarkedByBuiltTerms(editor);
    expect(expected).toContain(lessCertainInfoLabel("LN + FN + DOB"));
    expect(infoButtonLabels()).toStrictEqual(expected);
  });

  test("leaves a key unmarked as the built terms type its fields where the document types a field as a name", async () => {
    const editor = documentTypingFieldsApart([
      { name: "ssn4", type: "first_name" },
    ]);
    app.render(createElement(Harness, { initial: editor }));

    await expect
      .element(page.getByRole("checkbox", { name: /SSN4 \+ LN \+ DOB$/ }))
      .toBeChecked();
    const expected = labelsOfKeysMarkedByBuiltTerms(editor);
    expect(expected).not.toContain(lessCertainInfoLabel("SSN4 + LN + DOB"));
    expect(infoButtonLabels()).toStrictEqual(expected);
  });

  test("describes the key list with the order the chosen floor gives it", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    app.render(createElement(Harness, { initial: seeded }));

    const keyList = page.getByRole("list");
    await expect
      .element(keyList)
      .toHaveAccessibleDescription(keyOrderHelp(seeded));
    await page.getByRole("radio", { name: at99 }).click();
    await expect
      .element(keyList)
      .toHaveAccessibleDescription(
        keyOrderHelp(editorWithPrecisionFloorSelection(seeded, { floor: 99 })),
      );
  });

  test("offers the built-in rules in place of authored keys, behind a confirm", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    app.render(
      createElement(Harness, {
        initial: editorWithAuthoredDraft(
          seeded,
          addKey(seeded.draft, "first_name"),
        ),
      }),
    );

    await page.getByRole("button", { name: USE_BUILT_IN_RULES_LABEL }).click();
    const confirm = page.getByRole("dialog", {
      name: `${USE_BUILT_IN_RULES_LABEL}?`,
    });
    await expect
      .element(confirm)
      .toMatchTextContent(USE_BUILT_IN_RULES_STATEMENT);
    await confirm
      .getByRole("button", { name: USE_BUILT_IN_RULES_LABEL })
      .click();

    await expect.element(page.getByRole("radio", { name: at95 })).toBeChecked();
    expect(
      page
        .getByRole("note")
        .filter({ hasText: AUTHORED_KEYS_FLOOR_NOTE })
        .query(),
    ).toBeNull();
  });

  test("withholds the built-in rules on a file they supply no key for, keeping the note", async () => {
    const uncovered: AcquiredCsv = {
      fileName: "contacts.csv",
      sizeBytes: 64,
      rawRows: [
        { client_id: "1", email: "ann@example.org", phone: "555-123-4567" },
      ],
      columns: ["client_id", "email", "phone"],
      rowCount: 1,
    };
    const seeded = editorFromCsv("Dana Okafor", uncovered);
    app.render(
      createElement(Harness, {
        initial: editorWithAuthoredDraft(
          seeded,
          addKey(seeded.draft, "email_address"),
        ),
        file: uncovered,
      }),
    );

    await expect
      .element(
        page.getByRole("note").filter({ hasText: AUTHORED_KEYS_FLOOR_NOTE }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: USE_BUILT_IN_RULES_LABEL }).query(),
    ).toBeNull();
  });

  test("names the file and the command for an opened configuration's keys, with no action", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    app.render(
      createElement(Harness, {
        initial: editorWithImportedTerms(
          seeded,
          csv,
          buildAdvancedTerms(seeded.draft),
        ),
        keysFromOpenedConfiguration: true,
      }),
    );

    await expect
      .element(
        page
          .getByRole("note")
          .filter({ hasText: OPENED_CONFIGURATION_KEYS_NOTE }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: USE_BUILT_IN_RULES_LABEL }).query(),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Reset to defaults");
  });

  test("names the file in place of the floor after Reset to defaults, while the keys equal the opened configuration's", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    const opened = editorWithImportedTerms(
      seeded,
      csv,
      buildAdvancedTerms(seeded.draft),
    );
    const reset = resetToRecommended(opened, csv);
    expect(reset.keysAuthored).toBeUndefined();
    app.render(
      createElement(Harness, {
        initial: reset,
        openedConfigurationKeys: canonicalLinkageKeysAndFields(opened),
      }),
    );

    const openedNote = page
      .getByRole("note")
      .filter({ hasText: OPENED_CONFIGURATION_KEYS_NOTE });
    const floor95 = page.getByRole("radio", { name: at95 });
    await expect.element(openedNote).toBeInTheDocument();
    expect(
      document.getElementById("key-order-help")!.textContent,
    ).not.toContain("95%");
    expect(floor95.query()).toBeNull();
    expect(
      page.getByRole("button", { name: USE_BUILT_IN_RULES_LABEL }).query(),
    ).toBeNull();
    expect(
      page
        .getByRole("note")
        .filter({ hasText: AUTHORED_KEYS_FLOOR_NOTE })
        .query(),
    ).toBeNull();
    const info = page.getByRole("button", {
      name: lessCertainInfoLabel("LN + FN + DOB"),
      exact: true,
    });
    const panel = document.getElementById(
      info.element().getAttribute("aria-controls") ?? "",
    )!;
    await expect
      .poll(() => panel.textContent)
      .toBe(
        `${LESS_CERTAIN_KEY_COPY.explanation} ` +
          MATCHING_KEYS_LESS_CERTAIN_REMEDY.openedConfiguration,
      );

    const kept = page.getByRole("checkbox", { name: /SSN4 \+ LN \+ DOB$/ });
    await kept.click();
    await expect.element(floor95).toBeChecked();
    expect(openedNote.query()).toBeNull();

    await kept.click();
    await expect.element(openedNote).toBeInTheDocument();
    expect(floor95.query()).toBeNull();
  });

  test("says on the Expert authoring switch that editing keys there replaces the choice", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    await expect
      .element(page.getByRole("switch", { name: "Expert authoring" }))
      .toHaveAccessibleDescription(
        /Editing keys here replaces the choice of built-in rules above\.$/,
      );
  });
});

/** The tab with Expert authoring on over a live session, its key message
 * read from the session's validation as the inviter screen reads it. */
function ExpertAuthoringHarness({ initial }: { initial: InviterEditor }) {
  const [editor, setEditor] = useState(initial);
  return createElement(KeysTab, {
    editor,
    csv,
    expertMode: true,
    onExpertMode: () => undefined,
    onPrecisionFloorSelection: (selection) =>
      setEditor(editorWithPrecisionFloorSelection(editor, selection)),
    onUseBuiltInRules: () => setEditor(editorWithBuiltInKeys(editor, csv)),
    onKeyEnabled: () => undefined,
    onKeyMoved: () => undefined,
    onAuthoredDraft: (draft) =>
      setEditor(editorWithAuthoredDraft(editor, draft)),
    onStrategy: () => undefined,
    onDeduplicate: () => undefined,
    onImport: () => [],
    keysError: reviewValidation(editor).errors.keys,
    announce: () => undefined,
    onBack: () => undefined,
  });
}

describe("KeysTab: removing every key in Expert authoring", () => {
  test("asks for a key in place of the built-in choice, and offers the built-in rules back", async () => {
    app.render(
      createElement(ExpertAuthoringHarness, {
        initial: editorFromCsv("Dana Okafor", csv),
      }),
    );
    const floor95 = page.getByRole("radio", {
      name: precisionFloorLabel(95),
    });
    await expect.element(floor95).toBeChecked();

    await page.getByRole("button", { name: "Remove all keys" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent(
        /^There are no linkage keys\. Add a key in expert authoring\.$/,
      );
    expect(document.body.textContent).not.toContain("cannot supply");
    await expect
      .element(
        page.getByRole("note").filter({ hasText: AUTHORED_KEYS_FLOOR_NOTE }),
      )
      .toBeInTheDocument();
    expect(floor95.query()).toBeNull();

    await page.getByRole("button", { name: USE_BUILT_IN_RULES_LABEL }).click();
    await page
      .getByRole("dialog", { name: `${USE_BUILT_IN_RULES_LABEL}?` })
      .getByRole("button", { name: USE_BUILT_IN_RULES_LABEL })
      .click();

    await expect.element(floor95).toBeChecked();
    expect(page.getByRole("alert").query()).toBeNull();
  });
});

describe("KeysTab: a key element's split left unfinished", () => {
  test("names the key under the key list rather than asking for a key", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    const keyName = "Last name";
    app.render(
      createElement(ExpertAuthoringHarness, {
        initial: editorWithAuthoredDraft(seeded, {
          ...seeded.draft,
          keys: [
            {
              key: { name: keyName, elements: [{ field: "last_name" }] },
              enabled: true,
            },
          ],
        }),
      }),
    );
    // Wait out the card's opening transition: a click aimed inside it scrolls
    // the clipped panel rather than the page, the panel's growth then carries
    // "Add a transform" below the viewport, and the menu hides its dropdown.
    await openDisclosure(keyName);
    await expect
      .element(disclosureToggle(keyName))
      .toHaveAttribute("aria-expanded", "true");
    expect(document.body.textContent).not.toContain("Finish, fix, or remove");

    await userEvent.click(
      page.getByRole("button", { name: "Add a transform" }),
    );
    await userEvent.click(page.getByRole("menuitem", { name: "Split on" }));
    const unfinished = page.getByText(
      "Finish, fix, or remove the highlighted transform steps in Key 1 " +
        "before generating.",
      { exact: true },
    );
    await expect.element(unfinished).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(
      "Enable at least one linkage key.",
    );

    const delimiter = page.getByRole("textbox", { name: "Delimiter pattern" });
    await userEvent.fill(delimiter, "-");
    await expect.element(unfinished).not.toBeInTheDocument();

    await userEvent.clear(delimiter);
    await expect.element(unfinished).toBeInTheDocument();
  });
});

describe("KeysTab: the single-pass disclosure note", () => {
  function renderSinglePass(algorithm: "psi" | "psi-c") {
    const seeded = editorFromCsv("Dana Okafor", csv);
    const editor: InviterEditor = {
      ...seeded,
      draft: { ...seeded.draft, algorithm, linkageStrategy: "single-pass" },
    };
    app.render(
      createElement(KeysTab, {
        editor,
        csv,
        expertMode: false,
        onExpertMode: () => undefined,
        onPrecisionFloorSelection: () => undefined,
        onUseBuiltInRules: () => undefined,
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onDeduplicate: () => undefined,
        onImport: () => [],
        keysError: undefined,
        announce: () => undefined,
        onBack: () => undefined,
      }),
    );
  }

  test("shows on psi terms choosing single-pass", async () => {
    renderSinglePass("psi");
    await expect
      .element(page.getByText(SINGLE_PASS_DISCLOSURE_TITLE))
      .toBeInTheDocument();
  });

  test("is withheld on count-only terms, which run the cascade's rounds", async () => {
    renderSinglePass("psi-c");
    await expect
      .element(page.getByRole("heading", { name: "Matching settings" }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain(
      SINGLE_PASS_DISCLOSURE_TITLE,
    );
    expect(document.body.textContent).not.toContain(
      SINGLE_PASS_DISCLOSURE_BODY,
    );
  });
});
