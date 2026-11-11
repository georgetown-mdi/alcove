import { describe, expect, test } from "vitest";

import { linkageKeyHasOneElement } from "../../src/consent/singleElementKey.js";
import { linkageKeyIsLessCertain } from "../../src/consent/lessCertainKey.js";
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

describe("linkageKeyHasOneElement", () => {
  test("marks a key with one element", () => {
    expect(linkageKeyHasOneElement(key("ssn", "tax_id"))).toBe(true);
  });

  test("marks a one-element key whatever its transforms or fuzzy expansion", () => {
    expect(
      linkageKeyHasOneElement({
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

  test("leaves a key with two or more elements, or none, unmarked", () => {
    expect(linkageKeyHasOneElement(key("two", "tax_id", "born"))).toBe(false);
    expect(
      linkageKeyHasOneElement(key("three", "given", "surname", "born")),
    ).toBe(false);
    expect(linkageKeyHasOneElement(key("empty"))).toBe(false);
  });

  test("marks a lone date of birth, which is also less certain", () => {
    const lone = key("born", "born");
    expect(linkageKeyHasOneElement(lone)).toBe(true);
    expect(linkageKeyIsLessCertain(lone, FIELDS)).toBe(true);
  });
});

describe("the consent summary's one-element mark", () => {
  test("marks the one-element keys and only them", () => {
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
    expect(ssnAlone.oneElement).toBe(true);
    expect(ssnAlone.lessCertain).toBe(false);
    expect(ssnAndDob.oneElement).toBe(false);
    expect(dobAlone.oneElement).toBe(true);
    expect(dobAlone.lessCertain).toBe(true);
  });

  test("marks no key of the built-in catalog", () => {
    const keys = DEFAULT_LINKAGE_RULE_SET.linkageKeys;
    expect(keys.length).toBeGreaterThan(0);
    expect(
      keys.filter((k) => linkageKeyHasOneElement(k)).map((k) => k.name),
    ).toStrictEqual([]);
  });
});
