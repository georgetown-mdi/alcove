import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  DEFAULT_PRECISION_FLOOR_SELECTION,
  linkageTermsFromRuleSet,
} from "@alcove/core";

import {
  addKey,
  buildAdvancedTerms,
  draftHasOfferedKeys,
  draftKeysAreBuiltIn,
  draftOffersBuiltInKeys,
  draftWithBuiltInKeys,
  removeKey,
  updateKeyAt,
  validateAdvancedInvite,
} from "@psi/authoring/advancedInvite";

import {
  HIGHEST_PRECISION_UNAVAILABLE_PROBLEM,
  REMOVE_ALL_KEYS_STATEMENT,
  USE_BUILT_IN_RULES_STATEMENT,
  columnEditKeysAnnouncement,
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
  highestPrecisionHeldWithoutRules,
  highestPrecisionUnavailable,
  keyOrderHelp,
} from "@psi/inviterEditor";
import {
  answersRows,
  reviewValidation,
  spineProblems,
} from "@psi/inviterModel";

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

// An email and a phone with no name or date of birth: no built-in rule at
// either floor.
const contactsOnly = csvOf({
  client_id: "1",
  email: "ann@example.org",
  phone: "555-123-4567",
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
  const row = answersRows(editor, csv, "browser").find(
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
      "Keys written in expert authoring or loaded from a document",
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
    expect(imported.draft.importedRuleSetCitation?.kind).toBe("cited");
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
      "Replace your keys, fields, and cleaning with the built-in ones? This " +
        "cannot be undone.",
    );
  });
});

describe("Remove all keys asks first", () => {
  const seeded = editorFromCsv("Dana", withSsn);
  const asksFirst = (editor: InviterEditor) =>
    !draftKeysAreBuiltIn(editor.draft);

  test("not on the guided list at either floor, reordered, with a key off, or emptied", () => {
    expect(seeded.draft.keys.length).toBeGreaterThan(1);
    for (const guided of [
      seeded,
      editorWithPrecisionFloorSelection(seeded, AT_99),
      editorWithKeyMoved(seeded, 0, 1),
      editorWithKeyEnabled(seeded, 0, false),
      editorWithAuthoredDraft(seeded, { ...seeded.draft, keys: [] }),
    ])
      expect(asksFirst(guided)).toBe(false);
  });

  test("over a key added in expert authoring, until Use the built-in rules replaces the keys", () => {
    const authored = editorWithAuthoredDraft(
      seeded,
      addKey(seeded.draft, "first_name"),
    );
    expect(asksFirst(authored)).toBe(true);
    expect(asksFirst(editorWithBuiltInKeys(authored, withSsn))).toBe(false);
  });

  test("over a built-in key changed in expert authoring, until the change is undone", () => {
    const name = seeded.draft.keys[0].key.name;
    const renamed = updateKeyAt(seeded.draft, 0, (key) => ({
      ...key,
      name: `${name} (mine)`,
    }));
    expect(asksFirst(editorWithAuthoredDraft(seeded, renamed))).toBe(true);
    const undone = updateKeyAt(renamed, 0, (key) => ({ ...key, name }));
    expect(asksFirst(editorWithAuthoredDraft(seeded, undone))).toBe(false);
  });

  test("over a key loaded from a document that differs from the built-in ones, and not one equal to them", () => {
    const terms = buildAdvancedTerms(seeded.draft);
    expect(asksFirst(editorWithImportedTerms(seeded, withSsn, terms))).toBe(
      false,
    );
    const rename = (field: string) =>
      field === "last_name" ? "surname" : field;
    const renamed = {
      ...terms,
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
    expect(asksFirst(editorWithImportedTerms(seeded, withSsn, renamed))).toBe(
      true,
    );
  });

  test("over a key added where the columns supply no built-in key", () => {
    const uncovered = editorFromCsv("Dana", contactsOnly);
    expect(draftOffersBuiltInKeys(uncovered.draft)).toBe(false);
    expect(asksFirst(uncovered)).toBe(false);
    expect(
      asksFirst(
        editorWithAuthoredDraft(
          uncovered,
          addKey(uncovered.draft, "email_address"),
        ),
      ),
    ).toBe(true);
  });

  test("not over a built-in key a column edit leaves the columns unable to supply", () => {
    const authored = editorWithAuthoredDraft(seeded, seeded.draft);
    const retyped = editorWithColumnType(
      authored,
      withSsn,
      "ssn",
      "other",
    ).editor;
    expect(retyped.draft.keys).toStrictEqual(authored.draft.keys);
    expect(draftWithBuiltInKeys(retyped.draft).keys.length).toBeLessThan(
      retyped.draft.keys.length,
    );
    expect(asksFirst(retyped)).toBe(false);
  });

  test("with a statement naming the hand-written keys as lost for good", () => {
    expect(REMOVE_ALL_KEYS_STATEMENT).toBe(
      "The keys you added, changed, or loaded from a document are lost. " +
        "This cannot be undone.",
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

  test("under broader matching names the highest-precision rules first, then the rules it adds", () => {
    expect(keyOrderHelp(seeded)).toBe(
      "Records are matched on these keys, tried in order, and earlier keys " +
        "match first. The built-in keys list the highest-precision rules " +
        "first, then the rules broader matching adds.",
    );
  });

  test("under highest precision names its rules only", () => {
    expect(keyOrderHelp(editorWithPrecisionFloorSelection(seeded, AT_99))).toBe(
      "Records are matched on these keys, tried in order, and earlier keys " +
        "match first. The built-in keys are the highest-precision rules only.",
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

  test("states why highest precision lists no rules for these columns", () => {
    const empty = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", namesAndDate),
      AT_99,
    );
    expect(empty.draft.keys).toHaveLength(0);
    expect(guidedKeysAnnouncement(empty)).toBe(
      "The key list shows no built-in rules. Highest precision needs " +
        "stronger identifiers in your file, such as an SSN, ZIP code, or " +
        "phone number.",
    );
  });

  test("states an empty list where no choice lists a rule", () => {
    const empty = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", contactsOnly),
      AT_99,
    );
    expect(empty.draft.keys).toHaveLength(0);
    expect(guidedKeysAnnouncement(empty)).toBe(
      "The key list shows no built-in rules. Your file's columns supply " +
        "none of them.",
    );
  });
});

describe("Review & create", () => {
  test("names the floor the keys were selected with, in lowercase", () => {
    const seeded = editorFromCsv("Dana", withSsn);
    expect(rulesSelected(seeded, withSsn)).toBe("broader matching");
    expect(
      rulesSelected(editorWithPrecisionFloorSelection(seeded, AT_99), withSsn),
    ).toBe("highest precision");
  });
});

describe("highest precision on columns that supply none of its rules", () => {
  /** `editor` with the `ssn` column's role set, as the Columns step sets it. */
  function withSsnRole(editor: InviterEditor, role: "ignored" | "match") {
    return editorWithColumnDisclosure(editor, withSsn, "ssn", role).editor;
  }

  test("is available while the columns supply one of its rules, and not otherwise", () => {
    expect(highestPrecisionUnavailable(editorFromCsv("Dana", withSsn))).toBe(
      false,
    );
    expect(
      highestPrecisionUnavailable(editorFromCsv("Dana", namesAndDate)),
    ).toBe(true);
    expect(
      highestPrecisionUnavailable(editorFromCsv("Dana", contactsOnly)),
    ).toBe(true);
  });

  test("follows a column role change both ways", () => {
    const seeded = editorFromCsv("Dana", withSsn);
    const ignored = withSsnRole(seeded, "ignored");
    expect(highestPrecisionUnavailable(ignored)).toBe(true);
    expect(highestPrecisionUnavailable(withSsnRole(ignored, "match"))).toBe(
      false,
    );
  });

  test("stays chosen over an empty list, with the reason in place of the Expert authoring message, until the columns supply a rule", () => {
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", withSsn),
      AT_99,
    );
    expect(highestPrecisionHeldWithoutRules(at99)).toBe(false);

    const held = withSsnRole(at99, "ignored");
    expect(held.draft.precisionFloorSelection).toStrictEqual(AT_99);
    expect(held.draft.keys).toHaveLength(0);
    expect(highestPrecisionHeldWithoutRules(held)).toBe(true);
    const validation = reviewValidation(held);
    expect(validation.canGenerate).toBe(false);
    expect(validation.errors.keys).toBe(HIGHEST_PRECISION_UNAVAILABLE_PROBLEM);
    expect(HIGHEST_PRECISION_UNAVAILABLE_PROBLEM).toBe(
      "Highest precision needs stronger identifiers in your file, such as " +
        "an SSN, ZIP code, or phone number. Choose broader matching, or set " +
        "a column's type or use so your file supplies one of these.",
    );
    expect(spineProblems(held).map((problem) => problem.message)).toContain(
      HIGHEST_PRECISION_UNAVAILABLE_PROBLEM,
    );

    const refilled = withSsnRole(held, "match");
    expect(refilled.draft.precisionFloorSelection).toStrictEqual(AT_99);
    expect(keyNames(refilled)).toStrictEqual(catalogKeyNames(refilled, AT_99));
    expect(keyNames(refilled).length).toBeGreaterThan(0);
    expect(highestPrecisionHeldWithoutRules(refilled)).toBe(false);
    expect(reviewValidation(refilled).errors.keys).toBeUndefined();
  });

  test("a column edit that empties the list under it says why, and no other column edit speaks of the keys", () => {
    const seeded = editorFromCsv("Dana", withSsn);
    const at99 = editorWithPrecisionFloorSelection(seeded, AT_99);
    const held = withSsnRole(at99, "ignored");
    expect(columnEditKeysAnnouncement(at99, held)).toBe(
      "The key list shows no built-in rules. Highest precision needs " +
        "stronger identifiers in your file, such as an SSN, ZIP code, or " +
        "phone number.",
    );

    const stillHeld = editorWithColumnDisclosure(
      held,
      withSsn,
      "program_code",
      "payload",
    ).editor;
    expect(highestPrecisionHeldWithoutRules(stillHeld)).toBe(true);
    expect(columnEditKeysAnnouncement(held, stillHeld)).toBe("");
    expect(columnEditKeysAnnouncement(held, withSsnRole(held, "match"))).toBe(
      "",
    );
    expect(
      columnEditKeysAnnouncement(seeded, withSsnRole(seeded, "ignored")),
    ).toBe("");
  });

  test("keeps the Expert authoring message where no choice lists a rule", () => {
    const empty = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", contactsOnly),
      AT_99,
    );
    expect(highestPrecisionHeldWithoutRules(empty)).toBe(false);
    expect(reviewValidation(empty).errors.keys).toBe(
      validateAdvancedInvite(empty.draft, empty.seed).errors.keys,
    );
    expect(reviewValidation(empty).errors.keys).toContain("expert authoring");
  });

  test("leaves keys written in Expert authoring to their own message", () => {
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", namesAndDate),
      AT_99,
    );
    const authored = editorWithAuthoredDraft(at99, at99.draft);
    expect(highestPrecisionHeldWithoutRules(authored)).toBe(false);
    expect(reviewValidation(authored).errors.keys).not.toBe(
      HIGHEST_PRECISION_UNAVAILABLE_PROBLEM,
    );
  });
});

describe("the built-in rules on columns that supply no key", () => {
  test("are not offered for keys authored over them", () => {
    const named = editorFromCsv("Dana", namesAndDate);
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
    expect(editorOffersUseBuiltInRules(authored, false)).toBe(false);
  });
});

describe("an authored draft a column edit leaves the catalog offering no key", () => {
  test("generates terms from its new keys", () => {
    const at99 = editorWithPrecisionFloorSelection(
      editorFromCsv("Dana", withSsn),
      AT_99,
    );
    const narrowed = editorWithAuthoredDraft(at99, removeKey(at99.draft, 0));

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
  });
});
