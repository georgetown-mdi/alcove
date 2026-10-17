/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import {
  declaredFieldsFor,
  editorFromCsv,
  editorWithAuthoredDraft,
} from "@psi/inviterEditor";

import { CONTACT_AND_LOCATION_FIELD_TYPES } from "@alcove/core";

import {
  buildAdvancedTerms,
  draftFromTerms,
} from "@psi/authoring/advancedInvite";

import { KeysTab } from "@exchange/KeysTab";
import { consoleAcquiredCsv } from "@console/consoleAcquiredCsv";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv } from "@psi/inviterEditor";

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

function render(expertMode = false) {
  const editor = withDeadDobKey(editorFromCsv("Dana Okafor", csv));
  app.render(
    createElement(KeysTab, {
      editor,
      csv,
      expertMode,
      onExpertMode: () => undefined,
      onKeyEnabled: () => undefined,
      onKeyMoved: () => undefined,
      onAuthoredDraft: () => undefined,
      onStrategy: () => undefined,
      onAlgorithm: () => undefined,
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

describe("KeysTab: the dropped-citation notice", () => {
  test("names the cause on the guided tab, with expert authoring off", async () => {
    // An imported document citing the set this build ships over rules that are not
    // it: the citation is not re-emitted, so the operator is told here -- in the
    // guided tab, since the import that included the citation is not the only way
    // to reach the drop and the key list is what costs and restores it.
    const editor = editorFromCsv("Dana Okafor", csv);
    const misdescribed = buildAdvancedTerms(editor.draft);
    expect(misdescribed.linkageRuleSet).toBeDefined();
    misdescribed.linkageKeys[0] = {
      ...misdescribed.linkageKeys[0],
      name: `${misdescribed.linkageKeys[0].name} (house rules)`,
    };
    const imported = editorWithAuthoredDraft(
      editor,
      draftFromTerms(misdescribed, editor.seed, 3600, csv.rawRows),
    );
    expect(buildAdvancedTerms(imported.draft).linkageRuleSet).toBeUndefined();

    app.render(
      createElement(KeysTab, {
        editor: imported,
        csv,
        expertMode: false,
        onExpertMode: () => undefined,
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onAlgorithm: () => undefined,
        onDeduplicate: () => undefined,
        onImport: () => [],
        keysError: undefined,
        announce: () => undefined,
        onBack: () => undefined,
      }),
    );

    // The visible notice contains the title and the full cause; the persistent live
    // region announces only the short headline (that title), so a screen-reader
    // user is not read the whole body twice -- once live, once in reading order.
    const notice = page.getByRole("note").filter({
      hasText: "The imported rule-set citation will not be included",
    });
    await expect.element(notice).toBeInTheDocument();
    await expect
      .element(notice)
      .toMatchTextContent("the citation cannot be verified");
    await expect
      .element(page.getByRole("status"))
      .toMatchTextContent(
        "The imported rule-set citation will not be included",
      );
    await expect
      .element(page.getByRole("status"))
      .not.toMatchTextContent("the citation cannot be verified");
  });

  test("is absent -- and its live region silent, not unmounted -- while the citation stands", async () => {
    render();

    await expect
      .element(page.getByRole("heading", { name: "Matching keys" }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain(
      "The imported rule-set citation will not be included",
    );
    // The live region stays mounted and empty: a region added only when the notice
    // appears is missed by screen readers that watch only what is already there.
    expect(page.getByRole("status").element().textContent).toBe("");
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
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onAlgorithm: () => undefined,
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
          hasText: "must hold each person's own ZIP code",
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
      "must hold each person's own ZIP code",
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
  const caveat = "must hold each person's own ZIP code";

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
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onAlgorithm: () => undefined,
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
        onKeyEnabled: () => undefined,
        onKeyMoved: () => undefined,
        onAuthoredDraft: () => undefined,
        onStrategy: () => undefined,
        onAlgorithm: () => undefined,
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
