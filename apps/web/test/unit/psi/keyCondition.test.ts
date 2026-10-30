import { describe, expect, test } from "vitest";

import {
  keyConditionRefusal,
  safeParseLinkageTerms,
  summarizeInvitation,
} from "@alcove/core";

import {
  KEY_CONDITION_CONTROL,
  keyConditionOptions,
  keyConditionRefusalMessage,
  withKeyCondition,
} from "../../../src/psi/authoring/keyCondition.js";
import {
  addElement,
  addKey,
  buildAdvancedTerms,
  removeAllKeys,
  seedAdvancedInvite,
  updateKeyAt,
  validateAdvancedInvite,
} from "../../../src/psi/authoring/advancedInvite.js";
import {
  declarableFieldNames,
  keyIsSupplyable,
} from "../../../src/psi/authoring/advancedInviteDraft.js";

import type { LinkageField, LinkageKey } from "@alcove/core";
import type { AdvancedInviteDraft } from "../../../src/psi/authoring/advancedInvite.js";

const DECLARED: Array<LinkageField> = [
  { name: "first_name", type: "first_name" },
  { name: "last_name", type: "last_name" },
  { name: "ssn4", type: "ssn4" },
  { name: "date_of_birth", type: "date_of_birth" },
  { name: "intake_dob", type: "date_of_birth" },
];

const NAMES_AND_SSN4: LinkageKey = {
  name: "FN + LN + SSN4",
  elements: [
    { field: "first_name" },
    { field: "last_name" },
    { field: "ssn4" },
  ],
};

// A seeded draft holding one key, FN + LN + SSN4, as the editor builds it.
function draftWithNamesAndSsn4(
  columns: Array<string> = ["first_name", "last_name", "ssn4", "dob"],
) {
  const { draft, seed } = seedAdvancedInvite("County Health Dept", columns);
  let next = addKey(removeAllKeys(draft), "first_name");
  next = addElement(next, 0, "last_name");
  next = addElement(next, 0, "ssn4");
  return { draft: next, seed };
}

function expectedRefusal(draft: AdvancedInviteDraft) {
  const refusal = keyConditionRefusal(buildAdvancedTerms(draft));
  if (refusal === undefined) throw new Error("expected core to refuse");
  return refusal;
}

describe("the missing-field control's choices", () => {
  test("offers each date of birth field, labeled by type and by name where they differ", () => {
    expect(keyConditionOptions(DECLARED, NAMES_AND_SSN4)).toEqual([
      { value: "date_of_birth", label: "Date of birth" },
      { value: "intake_dob", label: "Date of birth (intake_dob)" },
    ]);
  });

  test("leaves out a field the key already matches on", () => {
    const readsDob: LinkageKey = {
      ...NAMES_AND_SSN4,
      elements: [...NAMES_AND_SSN4.elements, { field: "date_of_birth" }],
    };
    expect(keyConditionOptions(DECLARED, readsDob)).toEqual([
      { value: "intake_dob", label: "Date of birth (intake_dob)" },
    ]);
  });

  test("keeps the key's current choice visible after an edit refuses it", () => {
    const stale = withKeyCondition(
      { ...NAMES_AND_SSN4, elements: [{ field: "date_of_birth" }] },
      "date_of_birth",
    );
    expect(keyConditionOptions(DECLARED, stale)).toContainEqual({
      value: "date_of_birth",
      label: "Date of birth",
    });
    const undeclared = withKeyCondition(NAMES_AND_SSN4, "gone");
    expect(keyConditionOptions(DECLARED, undeclared)).toContainEqual({
      value: "gone",
      label: "gone",
    });
  });

  test("labels a current choice of a type it does not offer as the Field choice does", () => {
    const declared: Array<LinkageField> = [
      ...DECLARED,
      { name: "intake_ssn4", type: "ssn4" },
    ];
    const key = withKeyCondition(
      { ...NAMES_AND_SSN4, elements: [{ field: "first_name" }] },
      "intake_ssn4",
    );
    expect(keyConditionOptions(declared, key)).toContainEqual({
      value: "intake_ssn4",
      label: "Last 4 of Social Security number (intake_ssn4)",
    });
    expect(
      keyConditionOptions(declared, withKeyCondition(key, "ssn4")),
    ).toContainEqual({
      value: "ssn4",
      label: "Last 4 of Social Security number",
    });
  });

  test("setting and clearing the choice adds and removes the condition", () => {
    const set = withKeyCondition(NAMES_AND_SSN4, "date_of_birth");
    expect(set.condition).toEqual({ missingField: "date_of_birth" });
    const cleared = withKeyCondition(set, null);
    expect(cleared).toEqual(NAMES_AND_SSN4);
    expect(Object.hasOwn(cleared, "condition")).toBe(false);
  });

  test("the label and description name no schema key", () => {
    for (const copy of [
      KEY_CONDITION_CONTROL.label,
      KEY_CONDITION_CONTROL.description,
      KEY_CONDITION_CONTROL.placeholder,
    ])
      expect(copy).not.toMatch(/_|missingField|condition/);
  });
});

describe("a key authored with the control", () => {
  test("builds terms that keep the date of birth field and state the condition", () => {
    const { draft, seed } = draftWithNamesAndSsn4();
    const authored = updateKeyAt(draft, 0, (key) =>
      withKeyCondition(key, "date_of_birth"),
    );
    const terms = buildAdvancedTerms(authored);
    expect(terms.linkageKeys).toHaveLength(1);
    expect(terms.linkageKeys[0].condition).toEqual({
      missingField: "date_of_birth",
    });
    expect(terms.linkageFields.map((field) => field.name)).toContain(
      "date_of_birth",
    );
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    const validation = validateAdvancedInvite(authored, seed);
    expect(validation.errors).toEqual({});
    expect(validation.canGenerate).toBe(true);
    expect(summarizeInvitation({ linkageTerms: terms }).linkageKeys[0]).toEqual(
      expect.objectContaining({
        condition: expect.stringContaining("no valid date of birth"),
      }),
    );
  });

  test("on a file with no date of birth column, declares the built-in field and can generate", () => {
    const { draft, seed } = draftWithNamesAndSsn4([
      "first_name",
      "last_name",
      "ssn4",
    ]);
    const authored = updateKeyAt(draft, 0, (key) =>
      withKeyCondition(key, "date_of_birth"),
    );
    const terms = buildAdvancedTerms(authored);
    expect(terms.linkageFields).toContainEqual({
      name: "date_of_birth",
      type: "date_of_birth",
    });
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    const validation = validateAdvancedInvite(authored, seed);
    expect(validation.errors).toEqual({});
    expect(validation.canGenerate).toBe(true);
  });

  test("clearing the choice builds the key's terms without the condition", () => {
    const { draft } = draftWithNamesAndSsn4();
    const set = updateKeyAt(draft, 0, (key) =>
      withKeyCondition(key, "date_of_birth"),
    );
    const cleared = updateKeyAt(set, 0, (key) => withKeyCondition(key, null));
    expect(buildAdvancedTerms(cleared)).toEqual(buildAdvancedTerms(draft));
  });
});

const SCHEMA_WORDS = /missing_field|linkage_fields|date_of_birth|algorithm/;

// `draft` with a key that is off ahead of its keys: the refused key is Key 2
// in the list but the first key of the built terms.
function behindAKeyThatIsOff(draft: AdvancedInviteDraft): AdvancedInviteDraft {
  return {
    ...draft,
    keys: [
      {
        key: { name: "SSN4 alone", elements: [{ field: "ssn4" }] },
        enabled: false,
      },
      ...draft.keys,
    ],
  };
}

describe("Generate is held where core refuses, in the web app's words", () => {
  test("for a field outside the agreed linkage fields", () => {
    const { draft, seed } = draftWithNamesAndSsn4([
      "first_name",
      "last_name",
      "ssn4",
    ]);
    const authored = updateKeyAt(behindAKeyThatIsOff(draft), 1, (key) =>
      withKeyCondition(key, "intake_dob"),
    );
    const refusal = expectedRefusal(authored);
    expect(refusal.rule).toBe("undeclared");
    const validation = validateAdvancedInvite(authored, seed);
    expect(validation.canGenerate).toBe(false);
    expect(validation.errors.keys).toBe(
      keyConditionRefusalMessage(refusal, authored.keys),
    );
    expect(validation.errors.keys).toBe(
      'Key 2 is set to "Match only where a field is missing" for a field ' +
        "that is not one of this exchange's linkage fields. Open that key " +
        "and choose another field, or clear the choice.",
    );
    expect(validation.errors.keys).not.toMatch(SCHEMA_WORDS);
  });

  test("for a field of a type the condition does not admit", () => {
    const { draft, seed } = draftWithNamesAndSsn4();
    const authored = updateKeyAt(
      behindAKeyThatIsOff(removeElementNamed(draft, "ssn4")),
      1,
      (key) => withKeyCondition(key, "ssn4"),
    );
    const refusal = expectedRefusal(authored);
    expect(refusal.rule).toBe("fieldType");
    const validation = validateAdvancedInvite(authored, seed);
    expect(validation.canGenerate).toBe(false);
    expect(validation.errors.keys).toBe(
      keyConditionRefusalMessage(refusal, authored.keys),
    );
    expect(validation.errors.keys).toBe(
      'Key 2 is set to "Match only where a field is missing" for a field ' +
        "other than a date of birth, which Alcove does not support. Open " +
        "that key and clear the choice.",
    );
    expect(validation.errors.keys).not.toMatch(SCHEMA_WORDS);
  });

  test("for a key that also matches on the field", () => {
    const { draft, seed } = draftWithNamesAndSsn4();
    const authored = updateKeyAt(
      behindAKeyThatIsOff(addElement(draft, 0, "date_of_birth")),
      1,
      (key) => withKeyCondition(key, "date_of_birth"),
    );
    const refusal = expectedRefusal(authored);
    expect(refusal.rule).toBe("readsField");
    const message = validateAdvancedInvite(authored, seed).errors.keys;
    expect(message).toBe(keyConditionRefusalMessage(refusal, authored.keys));
    expect(message).toBe(
      "Key 2 matches on a date of birth and is also set to match only " +
        "where that date of birth is missing, so it can never match. Open " +
        "that key and remove the date of birth element, or clear the choice.",
    );
    expect(message).not.toMatch(SCHEMA_WORDS);
  });

  test("admits a condition on a count-only draft", () => {
    const { draft, seed } = draftWithNamesAndSsn4();
    const authored = updateKeyAt(
      behindAKeyThatIsOff({ ...draft, algorithm: "psi-c" }),
      1,
      (key) => withKeyCondition(key, "date_of_birth"),
    );
    expect(validateAdvancedInvite(authored, seed).errors.keys).toBeUndefined();
  });

  test("names no key where the refusal does not locate one", () => {
    expect(
      keyConditionRefusalMessage(
        { rule: "undeclared", message: "", path: ["linkageKeys"] },
        [],
      ),
    ).toMatch(/^A linkage key is set to /);
    expect(
      keyConditionRefusalMessage(
        { rule: "readsField", message: "", path: ["linkageKeys", 3] },
        [],
      ),
    ).toMatch(/^A linkage key matches on a date of birth/);
  });
});

describe("whether a key can be supplied from the file", () => {
  test("needs no column for its condition's field where the built-in fields declare it", () => {
    const withoutDob = draftWithNamesAndSsn4([
      "first_name",
      "last_name",
      "ssn4",
    ]).draft;
    const declarable = declarableFieldNames(
      withoutDob.metadata,
      withoutDob.standardization,
    );
    expect(
      keyIsSupplyable(
        NAMES_AND_SSN4,
        declarable,
        undefined,
        withoutDob.metadata,
      ),
    ).toBe(true);
    expect(
      keyIsSupplyable(
        withKeyCondition(NAMES_AND_SSN4, "date_of_birth"),
        declarable,
        undefined,
        withoutDob.metadata,
      ),
    ).toBe(true);
    expect(
      keyIsSupplyable(
        withKeyCondition(NAMES_AND_SSN4, "intake_dob"),
        declarable,
        undefined,
        withoutDob.metadata,
      ),
    ).toBe(false);

    const withDob = draftWithNamesAndSsn4().draft;
    expect(
      keyIsSupplyable(
        withKeyCondition(NAMES_AND_SSN4, "date_of_birth"),
        declarableFieldNames(withDob.metadata, withDob.standardization),
        undefined,
        withDob.metadata,
      ),
    ).toBe(true);
  });

  test("needs no column for its condition's field where an imported document declares it", () => {
    const withoutDob = draftWithNamesAndSsn4([
      "first_name",
      "last_name",
      "ssn4",
    ]).draft;
    expect(
      keyIsSupplyable(
        withKeyCondition(NAMES_AND_SSN4, "intake_dob"),
        declarableFieldNames(withoutDob.metadata, withoutDob.standardization),
        [{ name: "intake_dob", type: "date_of_birth" }],
        withoutDob.metadata,
      ),
    ).toBe(true);
  });

  test("cannot supply a condition's field no cleaning names where the file has a date column", () => {
    // Core would read that column into the field with no cleaning, so an
    // empty date would count as a value.
    const withDob = draftWithNamesAndSsn4().draft;
    expect(
      keyIsSupplyable(
        withKeyCondition(NAMES_AND_SSN4, "intake_dob"),
        declarableFieldNames(withDob.metadata, withDob.standardization),
        [{ name: "intake_dob", type: "date_of_birth" }],
        withDob.metadata,
      ),
    ).toBe(false);
  });
});

function removeElementNamed(
  draft: AdvancedInviteDraft,
  field: string,
): AdvancedInviteDraft {
  return updateKeyAt(draft, 0, (key) => ({
    ...key,
    elements: key.elements.filter((element) => element.field !== field),
  }));
}
