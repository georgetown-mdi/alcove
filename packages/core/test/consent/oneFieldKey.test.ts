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
    expect(linkageKeyUsesOneField(key("ssn", "tax_id"))).toBe(true);
  });

  test("marks a one-element key whatever its transforms or fuzzy expansion", () => {
    expect(
      linkageKeyUsesOneField({
        elements: [
          {
            field: "surname",
            transform: [
              { function: "substring", params: { start: 1, length: 4 } },
            ],
            generateFuzzyComparisons: "edit_distances",
          },
        ],
      }),
    ).toBe(true);
  });

  test("marks a key repeating one field under an alias", () => {
    expect(
      linkageKeyUsesOneField({
        elements: [{ field: "born" }, { field: "born", name: "born2" }],
      }),
    ).toBe(true);
  });

  test("leaves a key reading two or more fields, or none, unmarked", () => {
    expect(linkageKeyUsesOneField(key("two", "tax_id", "born"))).toBe(false);
    expect(
      linkageKeyUsesOneField(key("three", "given", "surname", "born")),
    ).toBe(false);
    expect(
      linkageKeyUsesOneField({
        elements: [
          { field: "born" },
          { field: "tax_id" },
          { field: "born", name: "born2" },
        ],
      }),
    ).toBe(false);
    expect(linkageKeyUsesOneField(key("empty"))).toBe(false);
  });

  test("marks a lone date of birth, which is also less certain", () => {
    const lone = key("born", "born");
    expect(linkageKeyUsesOneField(lone)).toBe(true);
    expect(linkageKeyIsLessCertain(lone, FIELDS)).toBe(true);
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
      keys.filter((k) => linkageKeyUsesOneField(k)).map((k) => k.name),
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
        "strategies to see which.",
    });
  });
});
