import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  PRECISION_FLOORS,
  builtInRuleChoiceOf,
  getDefaultLinkageTerms,
  linkageKeysAtPrecisionFloor,
} from "../../src/defaults/builtInLinkageTerms";
import { builtInRuleChoiceStatement } from "../../src/consent/consentFacts";
import { summarizeInvitation } from "../../src/consent/invitationSummary";
import { inferMetadata } from "../../src/config/metadata";

import type {
  LinkageField,
  LinkageKey,
} from "../../src/config/linkageTermsSchema";
import type { PrecisionFloor } from "../../src/defaults/builtInLinkageTerms";

const keysOf = (floor: PrecisionFloor): Array<LinkageKey> =>
  structuredClone(
    linkageKeysAtPrecisionFloor(DEFAULT_LINKAGE_RULE_SET, { floor }),
  );

const builtInFields = (): Array<LinkageField> =>
  structuredClone(
    DEFAULT_LINKAGE_RULE_SET.linkageFields,
  ) as Array<LinkageField>;

const overBuiltInFields = (linkageKeys: Array<LinkageKey>) => ({
  linkageFields: builtInFields(),
  linkageKeys,
});

const withFields = (
  floor: PrecisionFloor,
  edit: (fields: Array<LinkageField>) => Array<LinkageField>,
) => ({ linkageFields: edit(builtInFields()), linkageKeys: keysOf(floor) });

const redefined = (
  fields: Array<LinkageField>,
  name: string,
  change: Partial<LinkageField>,
): Array<LinkageField> =>
  fields.map((field) =>
    field.name === name ? { ...field, ...change } : field,
  );

describe("builtInRuleChoiceOf", () => {
  test.each(PRECISION_FLOORS)(
    "names the %i floor for its own keys over the built-in fields",
    (floor) => {
      expect(builtInRuleChoiceOf(overBuiltInFields(keysOf(floor)))).toBe(floor);
    },
  );

  test("names the broader choice for the terms every path that authors nothing runs", () => {
    expect(builtInRuleChoiceOf(getDefaultLinkageTerms(undefined))).toBe(95);
  });

  test("names no choice for a subset of one", () => {
    for (const floor of PRECISION_FLOORS) {
      const keys = keysOf(floor);
      expect(
        builtInRuleChoiceOf(overBuiltInFields(keys.slice(1))),
      ).toBeUndefined();
      expect(
        builtInRuleChoiceOf(overBuiltInFields(keys.slice(0, -1))),
      ).toBeUndefined();
    }
    // An input with no email column narrows the broader keys to a subset.
    const narrowed = getDefaultLinkageTerms(
      undefined,
      inferMetadata(["ssn", "first_name", "last_name", "dob", "phone"], []),
    );
    expect(narrowed.linkageKeys.length).toBeLessThan(keysOf(95).length);
    expect(builtInRuleChoiceOf(narrowed)).toBeUndefined();
  });

  test("names no choice for an edited list", () => {
    const renamed = keysOf(99);
    renamed[0].name = "SSN + last name + date of birth";
    expect(builtInRuleChoiceOf(overBuiltInFields(renamed))).toBeUndefined();

    const added = keysOf(99);
    added.push({
      name: "LN + DOB",
      elements: [{ field: "last_name" }, { field: "date_of_birth" }],
    });
    expect(builtInRuleChoiceOf(overBuiltInFields(added))).toBeUndefined();

    const elementEdited = keysOf(95);
    elementEdited[0].elements[0] = { field: "ssn4" };
    expect(
      builtInRuleChoiceOf(overBuiltInFields(elementEdited)),
    ).toBeUndefined();
  });

  test("names no choice for a reordered list", () => {
    for (const floor of PRECISION_FLOORS) {
      const keys = keysOf(floor);
      expect(
        builtInRuleChoiceOf(
          overBuiltInFields([keys[1], keys[0], ...keys.slice(2)]),
        ),
      ).toBeUndefined();
      expect(
        builtInRuleChoiceOf(overBuiltInFields([...keys].reverse())),
      ).toBeUndefined();
    }
  });

  test("names no choice for expert-authored keys", () => {
    expect(
      builtInRuleChoiceOf({
        linkageFields: [
          { name: "member_number", type: "ssn" },
          { name: "birth_date", type: "date_of_birth" },
        ],
        linkageKeys: [
          {
            name: "member number and birth date",
            elements: [{ field: "member_number" }, { field: "birth_date" }],
          },
        ],
      }),
    ).toBeUndefined();
    expect(builtInRuleChoiceOf(overBuiltInFields([]))).toBeUndefined();
  });

  test("is unmoved by property order, the canonical compare's equality", () => {
    const reordered = keysOf(99).map(
      ({ elements, name, ...rest }) =>
        ({ ...rest, elements, name }) as LinkageKey,
    );
    const fieldsReordered = builtInFields().map(
      ({ type, name, ...rest }) => ({ ...rest, type, name }) as LinkageField,
    );
    expect(
      builtInRuleChoiceOf({
        linkageFields: fieldsReordered,
        linkageKeys: reordered,
      }),
    ).toBe(99);
  });

  test.each(PRECISION_FLOORS)(
    "names no choice at the %i floor where a field the keys read is redefined",
    (floor) => {
      expect(
        builtInRuleChoiceOf(
          withFields(floor, (fields) =>
            redefined(fields, "ssn", { type: "phone_number" }),
          ),
        ),
      ).toBeUndefined();
      expect(
        builtInRuleChoiceOf(
          withFields(floor, (fields) =>
            redefined(
              redefined(fields, "first_name", { type: "last_name" }),
              "last_name",
              { type: "first_name" },
            ),
          ),
        ),
      ).toBeUndefined();
      expect(
        builtInRuleChoiceOf(
          withFields(floor, (fields) =>
            redefined(fields, "date_of_birth", { type: "county" }),
          ),
        ),
      ).toBeUndefined();
    },
  );

  test("names no choice where a field the keys read has other constraints", () => {
    expect(
      builtInRuleChoiceOf(
        withFields(99, (fields) =>
          redefined(fields, "ssn", { constraints: { validOnly: true } }),
        ),
      ),
    ).toBeUndefined();
    expect(
      builtInRuleChoiceOf(
        withFields(95, (fields) =>
          redefined(fields, "first_name", {
            constraints: { affixesAllowed: true, allowedCharacters: "A-Z " },
          }),
        ),
      ),
    ).toBeUndefined();
  });

  test("names no choice where a field the keys read is missing", () => {
    for (const floor of PRECISION_FLOORS) {
      expect(
        builtInRuleChoiceOf(
          withFields(floor, (fields) =>
            fields.filter((field) => field.name !== "date_of_birth"),
          ),
        ),
      ).toBeUndefined();
    }
  });

  test("names no choice where a field the keys read is declared twice, once redefined", () => {
    expect(
      builtInRuleChoiceOf(
        withFields(99, (fields) => [
          ...fields,
          { name: "ssn", type: "phone_number" },
        ]),
      ),
    ).toBeUndefined();
  });

  test("still names the choice beside a field no key reads", () => {
    for (const floor of PRECISION_FLOORS) {
      expect(
        builtInRuleChoiceOf(
          withFields(floor, (fields) => [
            ...fields,
            { name: "maiden_name", type: "last_name" },
          ]),
        ),
      ).toBe(floor);
    }
    // No highest-precision key reads the county, so its definition is not
    // compared there.
    expect(
      builtInRuleChoiceOf(
        withFields(99, (fields) =>
          redefined(fields, "county", { type: "state" }),
        ),
      ),
    ).toBe(99);
  });
});

describe("the consent summary's built-in rule choice", () => {
  test.each(PRECISION_FLOORS)(
    "states the %i floor where the keys are its keys",
    (floor) => {
      const terms = {
        ...getDefaultLinkageTerms(undefined),
        linkageKeys: keysOf(floor),
      };
      expect(
        summarizeInvitation({ linkageTerms: terms }).builtInRuleChoice,
      ).toBe(floor);
    },
  );

  test("states nothing where the keys are no choice's keys", () => {
    const terms = {
      ...getDefaultLinkageTerms(undefined),
      linkageKeys: keysOf(95).slice(1),
    };
    expect(
      "builtInRuleChoice" in summarizeInvitation({ linkageTerms: terms }),
    ).toBe(false);
  });

  test("states nothing where a field the keys read is redefined", () => {
    const defaults = getDefaultLinkageTerms(undefined);
    const terms = {
      ...defaults,
      linkageFields: redefined(defaults.linkageFields, "ssn", {
        type: "phone_number",
      }),
    };
    expect(
      "builtInRuleChoice" in summarizeInvitation({ linkageTerms: terms }),
    ).toBe(false);
  });

  test("words each choice by its label", () => {
    expect(builtInRuleChoiceStatement(99)).toBe(
      'The linkage keys are the built-in "highest precision" rules.',
    );
    expect(builtInRuleChoiceStatement(95)).toBe(
      'The linkage keys are the built-in "broader matching" rules.',
    );
  });
});
