/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement, useState } from "react";

import {
  AUTHORED_KEYS_FLOOR_NOTE,
  OPENED_CONFIGURATION_KEYS_NOTE,
  USE_BUILT_IN_RULES_STATEMENT,
  declaredFieldsFor,
  editorFromCsv,
  editorWithAuthoredDraft,
  editorWithBuiltInKeys,
  editorWithImportedTerms,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithPrecisionFloorSelection,
  keyOrderHelp,
} from "@psi/inviterEditor";

import {
  CONTACT_AND_LOCATION_FIELD_TYPES,
  ONE_STATE_OR_METRO_AREA_HELP,
  ONE_STATE_OR_METRO_AREA_NOT_ASKED,
  ONE_STATE_OR_METRO_AREA_QUESTION,
  precisionFloorStatement,
} from "@alcove/core";

import {
  SEEDED_CITATION_DROP_TITLE,
  USE_BUILT_IN_RULES_LABEL,
  addKey,
  buildAdvancedTerms,
  draftFromTerms,
} from "@psi/authoring/advancedInvite";

import { KeysTab } from "@exchange/KeysTab";
import { consoleAcquiredCsv } from "@console/consoleAcquiredCsv";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";

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
        onPrecisionFloorSelection: () => undefined,
        onUseBuiltInRules: () => undefined,
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
    render(false, false);

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
        onPrecisionFloorSelection: () => undefined,
        onUseBuiltInRules: () => undefined,
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
        onPrecisionFloorSelection: () => undefined,
        onUseBuiltInRules: () => undefined,
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
        onPrecisionFloorSelection: () => undefined,
        onUseBuiltInRules: () => undefined,
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

describe("KeysTab: the precision floor and the coverage question", () => {
  /** The tab over a live session, applying each floor choice through the
   * session model the inviter screen applies it through. */
  function Harness({
    initial,
    file = csv,
    keysFromOpenedConfiguration = false,
  }: {
    initial: InviterEditor;
    file?: AcquiredCsv;
    keysFromOpenedConfiguration?: boolean;
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
      keysFromOpenedConfiguration,
      onKeyEnabled: (index, enabled) =>
        setEditor(editorWithKeyEnabled(editor, index, enabled)),
      onKeyMoved: (index, offset) =>
        setEditor(editorWithKeyMoved(editor, index, offset)),
      onAuthoredDraft: () => undefined,
      onStrategy: () => undefined,
      onAlgorithm: () => undefined,
      onDeduplicate: () => undefined,
      onImport: () => [],
      keysError: undefined,
      announce: () => undefined,
      onBack: () => undefined,
    });
  }

  const at99 = precisionFloorStatement(99);
  const at95 = precisionFloorStatement(95);
  const nameAndDateKey = { name: /Key \d+ - LN \+ FN \+ DOB$/ };

  test("offers each floor in core's words, 95% chosen, with the coverage question and its help", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    const floor99 = page.getByRole("radio", { name: at99.label });
    const floor95 = page.getByRole("radio", { name: at95.label });
    await expect.element(floor95).toBeChecked();
    await expect.element(floor99).not.toBeChecked();
    await expect.element(page.getByText(at99.description)).toBeInTheDocument();
    await expect.element(page.getByText(at95.description)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/tier/i);

    const question = page.getByRole("radiogroup", {
      name: ONE_STATE_OR_METRO_AREA_QUESTION,
    });
    await expect.element(question).toBeInTheDocument();
    await expect
      .element(question.getByRole("radio", { name: "Yes", exact: true }))
      .toBeChecked();
    await expect
      .element(question)
      .toHaveAccessibleDescription(ONE_STATE_OR_METRO_AREA_HELP.join(" "));
  });

  test("reseeds the key list on a floor choice and on the coverage answer", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    const nameAndDate = page.getByRole("checkbox", nameAndDateKey);
    await expect.element(nameAndDate).toBeInTheDocument();
    await expect
      .element(page.getByRole("checkbox", { name: /SSN4 \+ LN4 \+ YOB/ }))
      .toBeInTheDocument();

    await page.getByRole("radio", { name: at99.label }).click();
    await expect
      .element(page.getByRole("radio", { name: at99.label }))
      .toBeChecked();
    expect(nameAndDate.query()).toBeNull();
    expect(
      page.getByRole("checkbox", { name: /SSN4 \+ LN4 \+ YOB/ }).query(),
    ).toBeNull();
    await expect
      .element(page.getByRole("checkbox", { name: /SSN4 \+ LN \+ DOB$/ }))
      .toBeChecked();

    await page.getByRole("radio", { name: at95.label }).click();
    await expect.element(nameAndDate).toBeChecked();

    const answerNo = page
      .getByRole("radiogroup", { name: ONE_STATE_OR_METRO_AREA_QUESTION })
      .getByRole("radio", { name: "No", exact: true });
    await answerNo.click();
    await expect.element(answerNo).toBeChecked();
    expect(nameAndDate.query()).toBeNull();
  });

  test("states a citation the moved keys drop, and clears it once moved back", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    app.render(createElement(Harness, { initial: seeded }));

    const firstName = seeded.draft.keys[0].key.name;
    await page.getByRole("button", { name: `Move ${firstName} later` }).click();

    const notice = page.getByRole("note", { name: SEEDED_CITATION_DROP_TITLE });
    await expect
      .element(notice)
      .toMatchTextContent(
        "Move the keys back into their built-in order to keep the citation",
      );
    await expect
      .element(page.getByRole("status"))
      .toMatchTextContent(SEEDED_CITATION_DROP_TITLE);

    await page
      .getByRole("button", { name: `Move ${firstName} earlier` })
      .click();
    await expect.element(notice).not.toBeInTheDocument();
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
    expect(page.getByRole("radio", { name: at99.label }).query()).toBeNull();
    expect(
      page
        .getByRole("radiogroup", { name: ONE_STATE_OR_METRO_AREA_QUESTION })
        .query(),
    ).toBeNull();
  });

  test("keeps a key turned off across a floor change and back", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    const kept = page.getByRole("checkbox", { name: /SSN4 \+ LN \+ DOB$/ });
    await kept.click();
    await expect.element(kept).not.toBeChecked();

    await page.getByRole("radio", { name: at99.label }).click();
    await expect.element(kept).not.toBeChecked();
    await page.getByRole("radio", { name: at95.label }).click();
    await expect.element(kept).not.toBeChecked();
    await expect
      .element(page.getByRole("checkbox", nameAndDateKey))
      .toBeChecked();
  });

  test("disables the coverage question at 99%, saying where it applies", async () => {
    app.render(
      createElement(Harness, { initial: editorFromCsv("Dana Okafor", csv) }),
    );

    await page.getByRole("radio", { name: at99.label }).click();
    const question = page.getByRole("radiogroup", {
      name: ONE_STATE_OR_METRO_AREA_QUESTION,
    });
    await expect
      .element(question)
      .toHaveAccessibleDescription(ONE_STATE_OR_METRO_AREA_NOT_ASKED);
    await expect
      .element(question.getByRole("radio", { name: "Yes", exact: true }))
      .toBeDisabled();
    await expect
      .element(question.getByRole("radio", { name: "No", exact: true }))
      .toBeDisabled();
  });

  test("describes the key list with the order the chosen floor gives it", async () => {
    const seeded = editorFromCsv("Dana Okafor", csv);
    app.render(createElement(Harness, { initial: seeded }));

    const keyList = page.getByRole("list");
    await expect
      .element(keyList)
      .toHaveAccessibleDescription(keyOrderHelp(seeded));
    await page.getByRole("radio", { name: at99.label }).click();
    await expect.element(keyList).toHaveAccessibleDescription(
      keyOrderHelp(
        editorWithPrecisionFloorSelection(seeded, {
          floor: 99,
          oneStateOrMetroArea: true,
        }),
      ),
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

    await expect
      .element(page.getByRole("radio", { name: at95.label }))
      .toBeChecked();
    expect(
      page
        .getByRole("note")
        .filter({ hasText: AUTHORED_KEYS_FLOOR_NOTE })
        .query(),
    ).toBeNull();
    expect(
      page.getByRole("note", { name: SEEDED_CITATION_DROP_TITLE }).query(),
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
