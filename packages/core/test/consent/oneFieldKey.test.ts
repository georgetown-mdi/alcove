import { describe, expect, test } from "vitest";

import { linkageKeyUsesOneField } from "../../src/consent/oneFieldKey.js";
import { linkageKeyIsLessCertain } from "../../src/consent/lessCertainKey.js";
import { ONE_FIELD_KEY_COPY } from "../../src/consent/consentFacts.js";
import { summarizeInvitation } from "../../src/consent/invitationSummary.js";
import {
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
} from "../../src/defaults/builtInLinkageTerms.js";
import { inferMetadata } from "../../src/config/metadata.js";

import type {
  LinkageField,
  LinkageKey,
  LinkageTerms,
} from "../../src/config/linkageTermsSchema.js";

const FIELDS: Array<LinkageField> = [
  { name: "given", type: "first_name" },
  { name: "surname", type: "last_name" },
  { name: "born", type: "date_of_birth" },
  { name: "tax_id", type: "ssn" },
];

const key = (name: string, ...fields: Array<string>): LinkageKey => ({
  name,
  elements: fields.map((field) => ({ field })),
});

describe("linkageKeyUsesOneField", () => {
  test("marks a key with one element", () => {
    expect(linkageKeyUsesOneField(key("ssn", "tax_id"), FIELDS)).toBe(true);
  });

  test("marks a one-element key whatever its transforms or fuzzy expansion", () => {
    expect(
      linkageKeyUsesOneField(
        {
          elements: [
            {
              field: "surname",
              transform: [
                { function: "substring", params: { start: 1, length: 4 } },
              ],
              generateFuzzyComparisons: "edit_distances",
            },
          ],
        },
        FIELDS,
      ),
    ).toBe(true);
  });

  test("marks a key repeating one field under an alias", () => {
    expect(
      linkageKeyUsesOneField(
        {
          elements: [{ field: "born" }, { field: "born", name: "born2" }],
        },
        FIELDS,
      ),
    ).toBe(true);
  });

  test("leaves a key reading two or more fields, or none, unmarked", () => {
    expect(linkageKeyUsesOneField(key("two", "tax_id", "born"), FIELDS)).toBe(
      false,
    );
    expect(
      linkageKeyUsesOneField(key("three", "given", "surname", "born"), FIELDS),
    ).toBe(false);
    expect(
      linkageKeyUsesOneField(
        {
          elements: [
            { field: "born" },
            { field: "tax_id" },
            { field: "born", name: "born2" },
          ],
        },
        FIELDS,
      ),
    ).toBe(false);
    expect(linkageKeyUsesOneField(key("empty"), FIELDS)).toBe(false);
  });

  test("marks a lone date of birth, which is also less certain", () => {
    const lone = key("born", "born");
    expect(linkageKeyUsesOneField(lone, FIELDS)).toBe(true);
    expect(linkageKeyIsLessCertain(lone, FIELDS)).toBe(true);
  });

  describe("fields that read one input column under the default binding", () => {
    const PARTNER_FIELDS: Array<LinkageField> = [
      { name: "dob", type: "date_of_birth" },
      { name: "DOB", type: "date_of_birth" },
      { name: "first_name", type: "first_name" },
      { name: "last_name", type: "last_name" },
      { name: "ssn", type: "ssn" },
      { name: "ssn4", type: "ssn4" },
    ];

    test("marks two field names of one type", () => {
      expect(
        linkageKeyUsesOneField(key("dobs", "dob", "DOB"), PARTNER_FIELDS),
      ).toBe(true);
    });

    test("marks a field and one derived from its type", () => {
      expect(
        linkageKeyUsesOneField(key("ssns", "ssn", "ssn4"), PARTNER_FIELDS),
      ).toBe(true);
      expect(
        linkageKeyUsesOneField(key("ssns", "ssn4", "ssn"), PARTNER_FIELDS),
      ).toBe(true);
    });

    test("leaves a key needing two or more columns unmarked", () => {
      expect(
        linkageKeyUsesOneField(
          key("names", "first_name", "last_name"),
          PARTNER_FIELDS,
        ),
      ).toBe(false);
      expect(
        linkageKeyUsesOneField(
          key("dobs and name", "dob", "DOB", "last_name"),
          PARTNER_FIELDS,
        ),
      ).toBe(false);
    });

    test("compares a field the declarations lack by its name", () => {
      expect(
        linkageKeyUsesOneField(key("undeclared", "x", "x"), PARTNER_FIELDS),
      ).toBe(true);
      expect(
        linkageKeyUsesOneField(key("undeclared", "x", "y"), PARTNER_FIELDS),
      ).toBe(false);
      expect(
        linkageKeyUsesOneField(key("mixed", "x", "dob"), PARTNER_FIELDS),
      ).toBe(false);
    });
  });
});

describe("the consent summary's one-field mark", () => {
  test("marks the one-field keys and only them", () => {
    const terms: LinkageTerms = {
      ...getDefaultLinkageTerms(
        "Inviter",
        inferMetadata(["ssn", "first_name", "last_name", "dob"], []),
      ),
      linkageFields: FIELDS,
      linkageKeys: [
        key("ssn alone", "tax_id"),
        key("ssn and dob", "tax_id", "born"),
        key("dob alone", "born"),
      ],
    };
    const [ssnAlone, ssnAndDob, dobAlone] = summarizeInvitation({
      linkageTerms: terms,
    }).linkageKeys;
    expect(ssnAlone.oneField).toBe(true);
    expect(ssnAlone.lessCertain).toBe(false);
    expect(ssnAndDob.oneField).toBe(false);
    expect(dobAlone.oneField).toBe(true);
    expect(dobAlone.lessCertain).toBe(true);
  });

  test("marks no key of the built-in catalog", () => {
    const keys = DEFAULT_LINKAGE_RULE_SET.linkageKeys;
    expect(keys.length).toBeGreaterThan(0);
    expect(
      keys
        .filter((k) =>
          linkageKeyUsesOneField(k, DEFAULT_LINKAGE_RULE_SET.linkageFields),
        )
        .map((k) => k.name),
    ).toStrictEqual([]);
  });
});

describe("ONE_FIELD_KEY_COPY", () => {
  test("states the risk with the key and, outside the key list, where to look", () => {
    expect(ONE_FIELD_KEY_COPY).toStrictEqual({
      keyLine:
        "Uses one field, so your partner could guess values and learn which " +
        "are in your file.",
      termsLine:
        "Some of the matching keys use one field, so your partner could " +
        "guess values and learn which are in your file. Open Matching " +
        "strategies to see which keys use one field.",
    });
  });
});
