import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  linkageTermsFromRuleSet,
  precisionFloorLabel,
} from "@alcove/core";

import {
  IMPORTED_CITATION_DROP_TITLE,
  SEEDED_CITATION_DROP_TITLE,
  USE_BUILT_IN_RULES_LABEL,
  addKey,
  buildAdvancedTerms,
  draftFromTerms,
  draftHasOfferedKeys,
  draftOffersBuiltInKeys,
  draftWithBuiltInKeys,
  removeKey,
  seededCitationDropNotice,
  validateAdvancedInvite,
} from "@psi/authoring/advancedInvite";
import {
  USE_BUILT_IN_RULES_STATEMENT,
  editorCitationDrop,
  editorFromCsv,
  editorOffersBuiltInKeys,
  editorOffersUseBuiltInRules,
  editorWithAuthoredDraft,
  editorWithBuiltInKeys,
  editorWithColumnDisclosure,
  editorWithColumnType,
  editorWithFieldSteps,
  editorWithImportedTerms,
  editorWithKeyEnabled,
  editorWithKeyMoved,
  editorWithPastedConfiguration,
  editorWithPrecisionFloorSelection,
  enabledKeys,
  guidedKeysAnnouncement,
  keyOrderHelp,
} from "@psi/inviterEditor";
import { answersRows } from "@psi/inviterModel";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { PrecisionFloorSelection, Standardization } from "@alcove/core";
import type { AdvancedInviteDraft } from "@psi/authoring/advancedInvite";

function csvOf(row: Record<string, string>): AcquiredCsv {
  return {
    fileName: "clients.csv",
    sizeBytes: 1024,
    rawRows: [row],
    columns: Object.keys(row),
    rowCount: 1,
  };
}

// A full SSN, both names and a date of birth: rules in both bands, and the
// three name + date rules marked less certain.
const withSsn = csvOf({
  client_id: "1",
  ssn: "123-45-6789",
  first_name: "Ann",
  last_name: "Lee",
  dob: "01/02/1990",
  program_code: "A",
});

// Names and a date of birth alone: no rule at 99% is built from these.
const namesAndDate = csvOf({
  client_id: "1",
  first_name: "Ann",
  last_name: "Lee",
  dob: "01/02/1990",
});

const AT_99: PrecisionFloorSelection = { floor: 99 };

const NAME_AND_DATE_RULES = [
  "LN + FN + DOB",
  "swap(LN, FN) + DOB",
  "split(LN) + FN + DOB",
];

function keyNames(editor: InviterEditor): Array<string> {
  return editor.draft.keys.map((entry) => entry.key.name);
}

/** The catalog keys `selection` picks for `editor`'s columns, in order. */
function catalogKeyNames(
  editor: InviterEditor,
  selection: PrecisionFloorSelection,
): Array<string> {
  return linkageTermsFromRuleSet(
    DEFAULT_LINKAGE_RULE_SET,
    undefined,
    editor.draft.metadata,
    selection,
  ).linkageKeys.map((key) => key.name);
}

function rulesSelected(editor: InviterEditor, csv: AcquiredCsv): string {
  const row = answersRows(editor, csv).find(
    (entry) => entry.label === "Rules selected",
  );
  if (row === undefined) throw new Error("no Rules selected row");
  return row.value;
}

describe("the seeded draft", () => {
  test("opens at the 95% floor", () => {
    const editor = editorFromCsv("Dana", withSsn);
    expect(editor.draft.precisionFloorSelection).toStrictEqual(
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(keyNames(editor)).toStrictEqual(
      catalogKeyNames(editor, DEFAULT_PRECISION_FLOOR_SELECTION),
    );
    expect(buildAdvancedTerms(editor.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  });
});

describe("choosing a precision floor", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("at 99% keeps a rule at the floor and drops one below it", () => {
    const at99 = editorWithPrecisionFloorSelection(seeded, AT_99);
    expect(keyNames(at99)).toContain("SSN + LN + DOB");
    expect(keyNames(at99)).not.toContain("SSN + FN");
    for (const rule of NAME_AND_DATE_RULES)
      expect(keyNames(at99)).not.toContain(rule);
    expect(keyNames(at99)).toStrictEqual(catalogKeyNames(at99, AT_99));
    expect(at99.draft.precisionFloorSelection).toStrictEqual(AT_99);
  });

  test("at 95% keeps a rule above the floor and one at it", () => {
    const at95 = editorWithPrecisionFloorSelection(
      editorWithPrecisionFloorSelection(seeded, AT_99),
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(keyNames(at95)).toContain("SSN + LN + DOB");
    expect(keyNames(at95)).toContain("SSN + FN");
    expect(keyNames(at95)).toStrictEqual(keyNames(seeded));
  });

  test("emits the catalog's citation at either floor", () => {
    for (const selection of [AT_99, DEFAULT_PRECISION_FLOOR_SELECTION]) {
      const chosen = editorWithPrecisionFloorSelection(seeded, selection);
      expect(buildAdvancedTerms(chosen.draft).linkageRuleSet).toStrictEqual(
        DEFAULT_LINKAGE_RULE_SET.reference,
      );
      expect(editorCitationDrop(chosen, false)).toBeUndefined();
    }
  });

  test("keeps a key turned off across a floor change and back", () => {
    const offAt = keyNames(seeded).indexOf("SSN + LN + DOB");
    const narrowed = editorWithKeyEnabled(seeded, offAt, false);
    const isOff = (editor: InviterEditor) =>
      editor.draft.keys.find((entry) => entry.key.name === "SSN + LN + DOB")
        ?.enabled === false;

    const at99 = editorWithPrecisionFloorSelection(narrowed, AT_99);
    expect(isOff(at99)).toBe(true);
    expect(enabledKeys(at99.draft)).toHaveLength(at99.draft.keys.length - 1);

    const back = editorWithPrecisionFloorSelection(
      at99,
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(isOff(back)).toBe(true);
    expect(back.draft.keys).toStrictEqual(narrowed.draft.keys);
  });

  test("turns on a key the new selection adds", () => {
    const at99 = editorWithPrecisionFloorSelection(seeded, AT_99);
    const at95 = editorWithPrecisionFloorSelection(
      at99,
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    const added = at95.draft.keys.filter(
      (entry) => !keyNames(at99).includes(entry.key.name),
    );
    expect(added.map((entry) => entry.key.name)).toContain("SSN + FN");
    expect(added.every((entry) => entry.enabled)).toBe(true);
  });

  test("takes the order from the catalog, not from a key moved by hand", () => {
    const moved = editorWithKeyMoved(seeded, 0, 1);
    const at99 = editorWithPrecisionFloorSelection(moved, AT_99);
    expect(keyNames(at99)).toStrictEqual(catalogKeyNames(at99, AT_99));
  });

  test("holds across a column edit, which reconciles at the chosen floor", () => {
    const at99 = editorWithPrecisionFloorSelection(seeded, AT_99);
    const edited = editorWithColumnDisclosure(
      at99,
      withSsn,
      "program_code",
      "payload",
    ).editor;
    expect(edited.draft.precisionFloorSelection).toStrictEqual(AT_99);
    expect(keyNames(edited)).toStrictEqual(keyNames(at99));
  });
});

describe("the name + date rules marked less certain", () => {
  test("are listed on at the 95% floor the draft opens at", () => {
    for (const csv of [withSsn, namesAndDate]) {
      const seeded = editorFromCsv("Dana", csv);
      for (const rule of NAME_AND_DATE_RULES) {
        const entry = seeded.draft.keys.find((key) => key.key.name === rule);
        expect(entry?.enabled).toBe(true);
      }
      expect(buildAdvancedTerms(seeded.draft).linkageRuleSet).toStrictEqual(
        DEFAULT_LINKAGE_RULE_SET.reference,
      );
    }
  });

  test("are what a file of names and a date of birth alone matches on", () => {
    expect(keyNames(editorFromCsv("Dana", namesAndDate))).toStrictEqual(
      NAME_AND_DATE_RULES,
    );
  });
});

describe("the geography rules on the guided list", () => {
  const withGeography = csvOf({
    client_id: "1",
    first_name: "Ann",
    last_name: "Lee",
    dob: "01/02/1990",
    zip: "02139",
    state: "Massachusetts",
    county: "Middlesex County",
  });
  const seeded = editorFromCsv("Dana", withGeography);
  const ZIP3_RULE = "LN + FN + DOB + ZIP3";
  const STATE_RULE = "LN + FN + DOB + STATE";
  const COUNTY_RULE = "LN + FN + DOB + COUNTY";

  test("are listed on, in the catalog's order, before the name + date rule", () => {
    expect(keyNames(seeded)).toStrictEqual(
      catalogKeyNames(seeded, DEFAULT_PRECISION_FLOOR_SELECTION),
    );
    expect(keyNames(seeded)).toStrictEqual([
      "LN + FN + DOB + ZIP5",
      ZIP3_RULE,
      "ZIP5 + soundex(LN) + FN + DOB",
      "ZIP5 + LN + FN + DOB +/-1 year",
      STATE_RULE,
      COUNTY_RULE,
      ...NAME_AND_DATE_RULES,
      "LN + FN + YOB + MOB + ZIP5",
    ]);
    expect(enabledKeys(seeded.draft)).toHaveLength(seeded.draft.keys.length);
  });

  test("are left out at the 99% floor", () => {
    const at99 = editorWithPrecisionFloorSelection(seeded, AT_99);
    for (const rule of [ZIP3_RULE, STATE_RULE, COUNTY_RULE])
      expect(keyNames(at99)).not.toContain(rule);
  });

  test("clean the state and county fields the terms declare", () => {
    const terms = buildAdvancedTerms(seeded.draft);
    expect(terms.linkageFields.map((field) => field.name)).toEqual(
      expect.arrayContaining(["zip_code", "state", "county"]),
    );
    const outputs = seeded.draft.standardization.map((entry) => entry.output);
    expect(outputs).toEqual(
      expect.arrayContaining(["zip_code", "state", "county"]),
    );
  });
});

describe("the street number rule on the guided list", () => {
  const STREET_NUMBER_RULE = "LN + FN + DOB + street number + ZIP5";
  const withStreetNumber = csvOf({
    client_id: "1",
    first_name: "Ann",
    last_name: "Lee",
    dob: "01/02/1990",
    house_number: "123",
    zip: "02139",
  });
  const seeded = editorFromCsv("Dana", withStreetNumber);

  test.each([DEFAULT_PRECISION_FLOOR_SELECTION, AT_99])(
    "is listed first, before the ZIP5 rule, at %o",
    (selection) => {
      const selected = editorWithPrecisionFloorSelection(seeded, selection);
      expect(keyNames(selected)).toStrictEqual(
        catalogKeyNames(selected, selection),
      );
      expect(keyNames(selected).slice(0, 2)).toStrictEqual([
        STREET_NUMBER_RULE,
        "LN + FN + DOB + ZIP5",
      ]);
      expect(enabledKeys(selected.draft)).toHaveLength(
        selected.draft.keys.length,
      );
      expect(buildAdvancedTerms(selected.draft).linkageRuleSet).toStrictEqual(
        DEFAULT_LINKAGE_RULE_SET.reference,
      );
    },
  );

  test("is not listed for a file with no street number column", () => {
    const zipOnly = editorFromCsv(
      "Dana",
      csvOf({
        client_id: "1",
        first_name: "Ann",
        last_name: "Lee",
        dob: "01/02/1990",
        zip: "02139",
      }),
    );
    expect(keyNames(zipOnly)).not.toContain(STREET_NUMBER_RULE);
  });

  test("cleans the street number field the terms declare", () => {
    const terms = buildAdvancedTerms(seeded.draft);
    expect(terms.linkageFields.map((field) => field.name)).toContain(
      "street_number",
    );
    expect(seeded.draft.standardization.map((entry) => entry.output)).toContain(
      "street_number",
    );
  });
});

describe("keys written in Expert authoring or loaded from a document", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("are not reseeded by a floor choice", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(editorWithPrecisionFloorSelection(authored, AT_99)).toBe(authored);
    const imported = editorWithImportedTerms(
      seeded,
      withSsn,
      buildAdvancedTerms(seeded.draft),
    );
    expect(imported.draft.precisionFloorSelection).toBeUndefined();
    expect(editorWithPrecisionFloorSelection(imported, AT_99)).toBe(imported);
  });

  test("are named on Review & create as selected by no floor", () => {
    const imported = editorWithImportedTerms(
      seeded,
      withSsn,
      buildAdvancedTerms(seeded.draft),
    );
    expect(rulesSelected(imported, withSsn)).toBe(
      "Keys written in Expert authoring or loaded from a document",
    );
  });
});

describe("replacing authored keys with the built-in rules", () => {
  const seeded = editorFromCsv("Dana", withSsn);
  const at99 = editorWithPrecisionFloorSelection(seeded, AT_99);

  test("lists the default selection's rules, all on, and opens the floor choice again", () => {
    const authored = editorWithAuthoredDraft(
      at99,
      addKey(at99.draft, "first_name"),
    );
    const guided = editorWithBuiltInKeys(authored, withSsn);
    expect(guided.keysAuthored).toBeUndefined();
    expect(guided.draft.precisionFloorSelection).toStrictEqual(
      DEFAULT_PRECISION_FLOOR_SELECTION,
    );
    expect(guided.draft.keys).toStrictEqual(seeded.draft.keys);
    expect(buildAdvancedTerms(guided.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(editorCitationDrop(guided, false)).toBeUndefined();
    expect(
      editorWithPrecisionFloorSelection(guided, AT_99).draft
        .precisionFloorSelection,
    ).toStrictEqual(AT_99);
  });

  test("keeps the columns, their sharing and every setting outside the keys, fields and cleaning", () => {
    const edited = editorWithColumnDisclosure(
      seeded,
      withSsn,
      "program_code",
      "payload",
    ).editor;
    const authored = editorWithAuthoredDraft(edited, {
      ...addKey(edited.draft, "first_name"),
      lifetimeSeconds: 3 * 24 * 60 * 60,
      outputDirection: "inviter",
      algorithm: "psi-c",
      deduplicate: true,
      linkageStrategy: "single-pass",
      legalAgreement: {
        reference: "DUA-7",
        purpose: "Program evaluation",
        expirationDate: "2099-01-01",
      },
      includeOwnColumns: "all",
      includeMatchingKey: true,
    });
    const guided = editorWithBuiltInKeys(authored, withSsn);
    expect(withoutKeysFieldsAndCleaning(guided.draft)).toStrictEqual(
      withoutKeysFieldsAndCleaning(authored.draft),
    );
    expect(guided.draft.metadata).toStrictEqual(edited.draft.metadata);
    expect(guided.seed).toBe(authored.seed);
    expect(guided.transport).toBe(authored.transport);
  });

  test("takes an imported document's citation and fields with its keys", () => {
    const misdescribed = buildAdvancedTerms(seeded.draft);
    misdescribed.linkageKeys = [...misdescribed.linkageKeys].reverse();
    const imported = editorWithImportedTerms(seeded, withSsn, misdescribed);
    expect(editorCitationDrop(imported, false)?.title).toBe(
      IMPORTED_CITATION_DROP_TITLE,
    );
    const guided = editorWithBuiltInKeys(imported, withSsn);
    expect(guided.draft.importedRuleSetCitation).toBeUndefined();
    expect(guided.draft.importedLinkageFields).toBeUndefined();
    expect(buildAdvancedTerms(guided.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(validateAdvancedInvite(guided.draft, guided.seed).canGenerate).toBe(
      true,
    );
  });

  test("builds valid terms from a document that named a field its own way", () => {
    const terms = buildAdvancedTerms(seeded.draft);
    const rename = (name: string) => (name === "last_name" ? "surname" : name);
    const { linkageRuleSet: _citation, ...uncited } = terms;
    const renamed = {
      ...uncited,
      linkageFields: terms.linkageFields.map((field) => ({
        ...field,
        name: rename(field.name),
      })),
      linkageKeys: terms.linkageKeys.map((key) => ({
        ...key,
        elements: key.elements.map((element) => ({
          ...element,
          field: rename(element.field),
        })),
      })),
    };
    const guided = editorWithBuiltInKeys(
      editorWithImportedTerms(seeded, withSsn, renamed),
      withSsn,
    );
    expect(validateAdvancedInvite(guided.draft, guided.seed).canGenerate).toBe(
      true,
    );
    expect(buildAdvancedTerms(guided.draft).linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  });

  test("states in its confirm what replaces the keys", () => {
    expect(USE_BUILT_IN_RULES_STATEMENT).toBe(
      "This replaces the keys, fields and cleaning with the ones a new " +
        "invitation starts with for your file, all turned on, and sets " +
        'Built-in rules to "Highest certainty, followed by others". The ' +
        "invitation will cite the built-in rules. Your " +
        "columns and other settings stay. This cannot be undone.",
    );
  });
});

/** `draft` less what the built-in rules replace. */
function withoutKeysFieldsAndCleaning(draft: AdvancedInviteDraft) {
  const {
    keys: _keys,
    standardization: _standardization,
    precisionFloorSelection: _selection,
    importedLinkageFields: _fields,
    importedRuleSetCitation: _citation,
    ...rest
  } = draft;
  return rest;
}

/** `standardization` with the steps of the transformation for `output`
 * rewritten by `steps`. */
function withSteps(
  standardization: Standardization,
  output: string,
  steps: (
    current: NonNullable<Standardization[number]["steps"]>,
  ) => NonNullable<Standardization[number]["steps"]>,
): Standardization {
  return standardization.map((transformation) =>
    transformation.output === output
      ? { ...transformation, steps: steps(transformation.steps ?? []) }
      : transformation,
  );
}

describe("the built-in rules as a reset to a new invitation's keys, fields and cleaning", () => {
  // Every key-gated type beside the backbone, so the reset has phone, email
  // and ZIP cleaning to drop or keep.
  const everyType = csvOf({
    client_id: "1",
    ssn: "123-45-6789",
    first_name: "Ann",
    last_name: "Lee",
    dob: "1990-01-02",
    phone: "555-123-4567",
    email: "ann@example.org",
    zip: "20001",
  });
  const fresh = editorFromCsv("Dana", everyType);

  function expectFreshSeed(guided: InviterEditor) {
    expect(guided.keysAuthored).toBeUndefined();
    expect(guided.draft.keys).toStrictEqual(fresh.draft.keys);
    expect(guided.draft.standardization).toStrictEqual(
      fresh.draft.standardization,
    );
    expect(guided.draft.precisionFloorSelection).toStrictEqual(
      fresh.draft.precisionFloorSelection,
    );
    expect(guided.draft.importedLinkageFields).toBeUndefined();
    expect(guided.draft.importedRuleSetCitation).toBeUndefined();
    const terms = buildAdvancedTerms(guided.draft);
    expect(terms).toStrictEqual(buildAdvancedTerms(fresh.draft));
    expect(terms.linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  }

  test("restores edited first_name cleaning on an authored draft", () => {
    const firstNameSteps =
      fresh.draft.standardization.find(
        (transformation) => transformation.output === "first_name",
      )?.steps ?? [];
    const authored = editorWithFieldSteps(
      editorWithAuthoredDraft(fresh, addKey(fresh.draft, "first_name")),
      "first_name",
      [...firstNameSteps, ...firstNameSteps.slice(0, 1)],
    );
    expect(authored.draft.standardization).not.toStrictEqual(
      fresh.draft.standardization,
    );
    expectFreshSeed(editorWithBuiltInKeys(authored, everyType));
  });

  test("restores a cut-down phone pipeline on an authored draft", () => {
    const keyed = editorWithAuthoredDraft(
      fresh,
      addKey(fresh.draft, "phone_number"),
    );
    const phoneSteps = keyed.draft.standardization.find(
      (transformation) => transformation.output === "phone_number",
    )?.steps;
    expect(phoneSteps?.length).toBeGreaterThan(1);
    const authored = editorWithFieldSteps(
      keyed,
      "phone_number",
      (phoneSteps ?? []).slice(0, 1),
    );
    expectFreshSeed(editorWithBuiltInKeys(authored, everyType));
  });

  test("replaces a loaded document's own cleaning and citation", () => {
    const cited = buildAdvancedTerms(fresh.draft);
    expect(cited.linkageRuleSet).toBeDefined();
    const loaded = editorWithPastedConfiguration(
      fresh,
      everyType,
      cited,
      withSteps(fresh.draft.standardization, "first_name", (steps) =>
        steps.slice(1),
      ),
    ).editor;
    expect(loaded.draft.importedRuleSetCitation?.kind).toBe("cited");
    expect(loaded.draft.standardization).not.toStrictEqual(
      fresh.draft.standardization,
    );
    expectFreshSeed(editorWithBuiltInKeys(loaded, everyType));
  });

  test("replaces a loaded document that cites no rules", () => {
    const { linkageRuleSet: _citation, ...uncited } = buildAdvancedTerms(
      fresh.draft,
    );
    const loaded = editorWithPastedConfiguration(
      fresh,
      everyType,
      uncited,
      withSteps(fresh.draft.standardization, "last_name", () => []),
    ).editor;
    expect(loaded.draft.importedRuleSetCitation).toStrictEqual({
      kind: "uncited",
    });
    expect(buildAdvancedTerms(loaded.draft).linkageRuleSet).toBeUndefined();
    expectFreshSeed(editorWithBuiltInKeys(loaded, everyType));
  });

  test("infers the date-of-birth format from the file as a new invitation does", () => {
    const authored = editorWithAuthoredDraft(
      fresh,
      addKey(fresh.draft, "first_name"),
    );
    const dobSteps = (editor: InviterEditor) =>
      editor.draft.standardization.find(
        (transformation) => transformation.output === "date_of_birth",
      )?.steps;
    expect(dobSteps(editorWithBuiltInKeys(authored, everyType))).toStrictEqual(
      dobSteps(fresh),
    );
    expect(
      dobSteps(editorWithBuiltInKeys(authored, everyType)),
    ).not.toStrictEqual(
      dobSteps(editorFromCsv("Dana", { ...everyType, rawRows: [] })),
    );
  });

  describe("on a file the built-in rules supply no key for", () => {
    const uncovered = csvOf({
      client_id: "1",
      email: "ann@example.org",
      phone: "555-123-4567",
    });
    const seeded = editorFromCsv("Dana", uncovered);
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "email_address"),
    );

    test("is not offered", () => {
      expect(seeded.draft.keys).toStrictEqual([]);
      expect(editorOffersBuiltInKeys(authored)).toBe(false);
      expect(editorOffersBuiltInKeys(fresh)).toBe(true);
    });

    test("leaves the session unchanged if called anyway", () => {
      expect(editorWithBuiltInKeys(authored, uncovered)).toBe(authored);
      expect(draftWithBuiltInKeys(authored.draft)).toBe(authored.draft);
    });
  });
});

describe("the key order help", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("at 95% names the highest-certainty rules first, then the others", () => {
    expect(keyOrderHelp(seeded)).toBe(
      "Records are matched on these keys, tried in order, and earlier keys " +
        "match first. The built-in keys list the highest-certainty rules " +
        "first, then the others.",
    );
  });

  test("at 99% names the highest-certainty rules only", () => {
    expect(keyOrderHelp(editorWithPrecisionFloorSelection(seeded, AT_99))).toBe(
      "Records are matched on these keys, tried in order, and earlier keys " +
        "match first. The built-in keys are only the highest-certainty rules.",
    );
  });

  test("for authored keys says only that they are tried in the order listed", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(keyOrderHelp(authored)).toBe(
      "Records are matched on these keys, tried in the order listed, and " +
        "earlier keys match first.",
    );
  });
});

describe("the announcement after a floor choice", () => {
  test("counts the keys listed and the keys on", () => {
    const seeded = editorFromCsv("Dana", withSsn);
    const count = seeded.draft.keys.length;
    expect(guidedKeysAnnouncement(seeded)).toBe(
      `The key list shows ${String(count)} built-in rules your file ` +
        "supplies, all turned on.",
    );
    expect(guidedKeysAnnouncement(editorWithKeyEnabled(seeded, 0, false))).toBe(
      `The key list shows ${String(count)} built-in rules your file ` +
        `supplies, ${String(count - 1)} turned on.`,
    );
  });

  test("states an empty list", () => {
    const empty = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", namesAndDate),
      AT_99,
    );
    expect(empty.draft.keys).toHaveLength(0);
    expect(guidedKeysAnnouncement(empty)).toBe(
      "The key list shows no built-in rules.",
    );
  });
});

describe("Review & create", () => {
  test("names the floor the keys were selected with", () => {
    const seeded = editorFromCsv("Dana", withSsn);
    expect(rulesSelected(seeded, withSsn)).toBe(
      precisionFloorLabel(DEFAULT_PRECISION_FLOOR_SELECTION.floor),
    );
    expect(
      rulesSelected(editorWithPrecisionFloorSelection(seeded, AT_99), withSsn),
    ).toBe("Highest certainty only");
  });
});

describe("a seeded draft's dropped citation", () => {
  const seeded = editorFromCsv("Dana", withSsn);

  test("is not dropped by turning one key off", () => {
    const narrowed = editorWithKeyEnabled(seeded, 0, false);
    expect(buildAdvancedTerms(narrowed.draft).linkageRuleSet).toBeDefined();
    expect(editorCitationDrop(narrowed, false)).toBeUndefined();
  });

  test("is noticed when a key moves out of order, and restored by moving it back", () => {
    const moved = editorWithKeyMoved(seeded, 0, 1);
    expect(buildAdvancedTerms(moved.draft).linkageRuleSet).toBeUndefined();
    const drop = editorCitationDrop(moved, false);
    expect(drop?.title).toBe(SEEDED_CITATION_DROP_TITLE);
    expect(drop?.notice).toBe(
      "A key was moved out of the built-in order, so these keys are no " +
        "longer drawn from the built-in rule set, and the terms you create " +
        "will not cite it, so they will not tell your partner that these " +
        "keys are the built-in rules. Move the keys back into their built-in " +
        "order to keep the citation, or create the invitation without it.",
    );
    const restored = editorWithKeyMoved(moved, 1, -1);
    expect(editorCitationDrop(restored, false)).toBeUndefined();
  });

  test("is noticed when a key is added in Expert authoring, naming the way back", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(buildAdvancedTerms(authored.draft).linkageRuleSet).toBeUndefined();
    expect(
      seededCitationDropNotice(
        authored.draft,
        authored.seed,
        editorOffersUseBuiltInRules(authored, false),
      ),
    ).toBe(
      "A key was added or changed in Expert authoring, so these keys are no " +
        "longer drawn from the built-in rule set, and the terms you create " +
        "will not cite it, so they will not tell your partner that these " +
        "keys are the built-in rules. To keep the citation, choose Use the " +
        "built-in rules on Matching keys, which replaces the keys, fields " +
        "and cleaning with the ones a new invitation starts with, or create " +
        "the invitation without it.",
    );
  });

  test("names no action where Matching keys withholds the built-in rules", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(draftOffersBuiltInKeys(authored.draft)).toBe(true);
    const notice = seededCitationDropNotice(
      authored.draft,
      authored.seed,
      false,
    );
    expect(notice).toBe(
      "A key was added or changed in Expert authoring, so these keys are no " +
        "longer drawn from the built-in rule set, and the terms you create " +
        "will not cite it, so they will not tell your partner that these " +
        "keys are the built-in rules.",
    );
  });

  test("does not offer the built-in rules where the columns supply no key", () => {
    const named = editorFromCsv("Dana", namesAndDate);
    expect(buildAdvancedTerms(named.draft).linkageRuleSet).toBeDefined();
    const retyped = editorWithColumnType(
      named,
      namesAndDate,
      "dob",
      "other",
    ).editor;
    expect(draftHasOfferedKeys(retyped.draft)).toBe(false);
    expect(draftOffersBuiltInKeys(retyped.draft)).toBe(false);
    const authored = editorWithAuthoredDraft(
      retyped,
      addKey(retyped.draft, "first_name"),
    );
    expect(buildAdvancedTerms(authored.draft).linkageRuleSet).toBeUndefined();
    const notice = seededCitationDropNotice(
      authored.draft,
      authored.seed,
      editorOffersUseBuiltInRules(authored, false),
    );
    expect(notice).toBe(
      "A key was added or changed in Expert authoring, so these keys are no " +
        "longer drawn from the built-in rule set, and the terms you create " +
        "will not cite it, so they will not tell your partner that these " +
        "keys are the built-in rules. The built-in rules supply no key for " +
        "this file's columns as they are now.",
    );
    expect(notice).not.toContain(USE_BUILT_IN_RULES_LABEL);
  });

  test("is noticed when every key is off", () => {
    let allOff = seeded;
    for (const index of seeded.draft.keys.keys())
      allOff = editorWithKeyEnabled(allOff, index, false);
    expect(
      seededCitationDropNotice(
        allOff.draft,
        allOff.seed,
        editorOffersUseBuiltInRules(allOff, false),
      ),
    ).toContain("Turn a linkage key back on to keep the citation");
  });

  test("is noticed for keys authored after a floor that offers the file none", () => {
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", namesAndDate),
      AT_99,
    );
    expect(at99.draft.keys).toHaveLength(0);
    expect(editorCitationDrop(at99, false)).toBeUndefined();
    const authored = editorWithAuthoredDraft(
      at99,
      addKey(at99.draft, "first_name"),
    );
    expect(editorCitationDrop(authored, false)?.notice).toContain(
      USE_BUILT_IN_RULES_LABEL,
    );
  });

  test("is not stated for a file the built-in rules never supplied", () => {
    const unmatchable = csvOf({
      client_id: "1",
      first_name: "Ann",
      program_code: "A",
    });
    const seededBare = editorFromCsv("Dana", unmatchable);
    expect(buildAdvancedTerms(seededBare.draft).linkageRuleSet).toBeUndefined();
    const authored = editorWithAuthoredDraft(
      seededBare,
      addKey(seededBare.draft, "first_name"),
    );
    expect(editorCitationDrop(authored, false)).toBeUndefined();
  });

  test("leaves an imported draft's drop to the imported notice", () => {
    const misdescribed = buildAdvancedTerms(seeded.draft);
    misdescribed.linkageKeys = [...misdescribed.linkageKeys].reverse();
    const imported = editorWithAuthoredDraft(
      seeded,
      draftFromTerms(misdescribed, seeded.seed, 3600, withSsn.rawRows),
    );
    expect(
      seededCitationDropNotice(
        imported.draft,
        imported.seed,
        editorOffersUseBuiltInRules(imported, false),
      ),
    ).toBeUndefined();
    expect(editorCitationDrop(imported, false)?.title).toBe(
      IMPORTED_CITATION_DROP_TITLE,
    );
  });
});

describe("an authored draft a column edit leaves the catalog offering no key", () => {
  test("states the citation its new keys drop", () => {
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", withSsn),
      AT_99,
    );
    const narrowed = editorWithAuthoredDraft(at99, removeKey(at99.draft, 0));
    expect(buildAdvancedTerms(narrowed.draft).linkageRuleSet).toBeDefined();

    const retyped = editorWithColumnType(
      narrowed,
      withSsn,
      "ssn",
      "other",
    ).editor;
    expect(retyped.draft.precisionFloorSelection).toStrictEqual(AT_99);
    expect(draftHasOfferedKeys(retyped.draft)).toBe(false);

    const allOff = {
      ...retyped.draft,
      keys: retyped.draft.keys.map((entry) => ({ ...entry, enabled: false })),
    };
    const rewritten = editorWithAuthoredDraft(
      retyped,
      addKey(allOff, "first_name"),
    );
    expect(
      validateAdvancedInvite(rewritten.draft, rewritten.seed).canGenerate,
    ).toBe(true);
    expect(buildAdvancedTerms(rewritten.draft).linkageRuleSet).toBeUndefined();
    const drop = editorCitationDrop(rewritten, false);
    expect(drop?.title).toBe(SEEDED_CITATION_DROP_TITLE);
    expect(drop?.notice).toContain(USE_BUILT_IN_RULES_LABEL);
  });
});
