import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  builtInRuleChoiceOf,
  getDefaultLinkageTerms,
  linkageTermsFromRuleSet,
} from "../../src/defaults/builtInLinkageTerms";

import type { BuiltInLinkageRuleSet } from "../../src/defaults/builtInLinkageTerms";

import type { ColumnMetadata, Metadata } from "../../src/config/metadata";
import type { LinkageKey } from "../../src/config/linkageTermsSchema";
import type { SemanticType } from "../../src/types";

const col = (
  name: string,
  type: SemanticType,
  role: ColumnMetadata["role"] = "linkage",
): ColumnMetadata => ({ name, type, role, isPayload: false });

/** Every object or array reachable within `value` that an edit could still
 * change in place, each named from `path` so a failure states where it sits. */
const unfrozenPathsWithin = (value: unknown, path: string): string[] => {
  if (typeof value !== "object" || value === null) return [];
  const paths = Object.isFrozen(value) ? [] : [path];
  for (const [key, held] of Object.entries(value)) {
    const heldPath = Array.isArray(value)
      ? `${path}[${key}]`
      : `${path}.${key}`;
    paths.push(...unfrozenPathsWithin(held, heldPath));
  }
  return paths;
};

describe("DEFAULT_LINKAGE_RULE_SET", () => {
  test("is frozen through its contents", () => {
    // The set is aliased into every terms document derived from it, so a set
    // frozen at its top level alone would let one in-place edit move what
    // later derivations draw.
    expect(DEFAULT_LINKAGE_RULE_SET.linkageKeys.length).toBeGreaterThan(1);
    expect(DEFAULT_LINKAGE_RULE_SET.linkageFields.length).toBeGreaterThan(1);
    expect(
      unfrozenPathsWithin(DEFAULT_LINKAGE_RULE_SET, "DEFAULT_LINKAGE_RULE_SET"),
    ).toStrictEqual([]);
  });

  test("holds no rule-set name or version", () => {
    expect(Object.keys(DEFAULT_LINKAGE_RULE_SET).sort()).toStrictEqual([
      "linkageFields",
      "linkageKeys",
      "ruleBands",
    ]);
  });
});

describe("linkageTermsFromRuleSet", () => {
  test("emits terms holding the rules alone, with and without metadata", () => {
    const metadata: Metadata = [
      col("s", "ssn"),
      col("l", "last_name"),
      col("d", "date_of_birth"),
    ];
    for (const terms of [
      getDefaultLinkageTerms("Party A"),
      getDefaultLinkageTerms("Party A", metadata),
    ])
      expect(Object.keys(terms)).not.toContain("linkageRuleSet");
  });

  test("a file with a full SSN column and no ssn4 column keeps the SSN4 keys", () => {
    const terms = getDefaultLinkageTerms("Party A", [
      col("s", "ssn"),
      col("l", "last_name"),
      col("d", "date_of_birth"),
    ]);
    expect(terms.linkageKeys.map((key) => key.name)).toEqual(
      expect.arrayContaining(["SSN4 + LN + DOB", "SSN4 + LN4 + YOB + MOB"]),
    );
    expect(terms.linkageFields.map((field) => field.name)).toContain("ssn4");
  });

  test("a file with neither SSN column keeps no SSN or SSN4 key", () => {
    const terms = getDefaultLinkageTerms("Party A", [
      col("f", "first_name"),
      col("l", "last_name"),
      col("d", "date_of_birth"),
    ]);
    const fields = terms.linkageFields.map((field) => field.name);
    expect(fields).not.toContain("ssn4");
    expect(fields).not.toContain("ssn");
    expect(terms.linkageKeys.length).toBeGreaterThan(0);
  });

  test("an SSN column not roled for linkage supplies no SSN4 key", () => {
    const terms = getDefaultLinkageTerms("Party A", [
      col("s", "ssn", "payload"),
      col("l", "last_name"),
      col("d", "date_of_birth"),
    ]);
    expect(terms.linkageFields.map((field) => field.name)).not.toContain(
      "ssn4",
    );
  });

  test("draws its rules from the set it is given, not from the default", () => {
    const ruleSet: BuiltInLinkageRuleSet = {
      linkageFields: [{ name: "ssn", type: "ssn" }],
      linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    };
    const terms = linkageTermsFromRuleSet(ruleSet, "Party A");
    expect(terms.linkageKeys).toEqual(ruleSet.linkageKeys);
    expect(terms.linkageFields).toEqual(ruleSet.linkageFields);
  });

  test("a key is kept, its condition's field declared, where the columns lack that field", () => {
    const conditioned: LinkageKey = {
      name: "SSN",
      elements: [{ field: "ssn" }],
      condition: { missingField: "date_of_birth" },
    };
    const ruleSet: BuiltInLinkageRuleSet = {
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "date_of_birth", type: "date_of_birth" },
      ],
      linkageKeys: [conditioned],
    };
    for (const metadata of [
      [col("s", "ssn")],
      [col("s", "ssn"), col("d", "date_of_birth")],
    ]) {
      const terms = linkageTermsFromRuleSet(ruleSet, "Party A", metadata);
      expect(terms.linkageKeys).toEqual([conditioned]);
      expect(terms.linkageFields).toEqual(ruleSet.linkageFields);
    }
    expect(
      linkageTermsFromRuleSet(ruleSet, "Party A", [col("d", "date_of_birth")])
        .linkageKeys,
    ).toEqual([]);
  });
});

describe("the built-in rules resist mutation", () => {
  test("the declared rules are frozen through their contents, arrays and members alike", () => {
    // An in-place edit of a field's constraints or of a key's elements would
    // move every later derivation and the built-in choice the keys are named
    // by, while the declarations stayed put. Module code is strict, so each
    // attempt throws rather than silently failing.
    const set = DEFAULT_LINKAGE_RULE_SET as unknown as {
      linkageFields: Array<{
        name: string;
        constraints?: { exclude?: Array<string>; validOnly?: boolean };
      }>;
      linkageKeys: Array<{
        name: string;
        elements: Array<{
          field: string;
          transform?: Array<{ function: string; params: { start?: number } }>;
        }>;
      }>;
    };
    const [firstField] = set.linkageFields;
    const [firstKey] = set.linkageKeys;

    expect(() => {
      set.linkageFields.push({ name: "poisoned", type: "ssn" } as never);
    }).toThrow(TypeError);
    expect(() => {
      firstField.name = "poisoned";
    }).toThrow(TypeError);
    expect(() => {
      if (firstField.constraints !== undefined)
        firstField.constraints.validOnly = false;
    }).toThrow(TypeError);
    expect(() => {
      firstField.constraints?.exclude?.push("999999999");
    }).toThrow(TypeError);
    expect(() => {
      set.linkageKeys.reverse();
    }).toThrow(TypeError);
    expect(() => {
      firstKey.elements[0].field = "poisoned";
    }).toThrow(TypeError);
    expect(() => {
      const [transform] = firstKey.elements
        .map((element) => element.transform)
        .filter((entry) => entry !== undefined);
      transform[0].params.start = 99;
    }).toThrow(TypeError);

    // The choice the default terms are named by is the one the untouched set
    // gives.
    expect(builtInRuleChoiceOf(getDefaultLinkageTerms("Party A"))).toBe(95);
  });
});
