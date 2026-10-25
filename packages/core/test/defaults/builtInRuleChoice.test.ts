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

import type { LinkageKey } from "../../src/config/linkageTermsSchema";
import type { PrecisionFloor } from "../../src/defaults/builtInLinkageTerms";

const keysOf = (floor: PrecisionFloor): Array<LinkageKey> =>
  structuredClone(
    linkageKeysAtPrecisionFloor(DEFAULT_LINKAGE_RULE_SET, { floor }),
  );

describe("builtInRuleChoiceOf", () => {
  test.each(PRECISION_FLOORS)(
    "names the %i floor for its own keys",
    (floor) => {
      expect(builtInRuleChoiceOf(keysOf(floor))).toBe(floor);
    },
  );

  test("names the broader choice for the terms every path that authors nothing runs", () => {
    expect(
      builtInRuleChoiceOf(getDefaultLinkageTerms(undefined).linkageKeys),
    ).toBe(95);
  });

  test("names no choice for a subset of one", () => {
    for (const floor of PRECISION_FLOORS) {
      const keys = keysOf(floor);
      expect(builtInRuleChoiceOf(keys.slice(1))).toBeUndefined();
      expect(builtInRuleChoiceOf(keys.slice(0, -1))).toBeUndefined();
    }
    // An input with no email column narrows the broader keys to a subset.
    const narrowed = getDefaultLinkageTerms(
      undefined,
      inferMetadata(["ssn", "first_name", "last_name", "dob", "phone"], []),
    ).linkageKeys;
    expect(narrowed.length).toBeLessThan(keysOf(95).length);
    expect(builtInRuleChoiceOf(narrowed)).toBeUndefined();
  });

  test("names no choice for an edited list", () => {
    const renamed = keysOf(99);
    renamed[0].name = "SSN + last name + date of birth";
    expect(builtInRuleChoiceOf(renamed)).toBeUndefined();

    const added = keysOf(99);
    added.push({
      name: "LN + DOB",
      elements: [{ field: "last_name" }, { field: "date_of_birth" }],
    });
    expect(builtInRuleChoiceOf(added)).toBeUndefined();

    const elementEdited = keysOf(95);
    elementEdited[0].elements[0] = { field: "ssn4" };
    expect(builtInRuleChoiceOf(elementEdited)).toBeUndefined();
  });

  test("names no choice for a reordered list", () => {
    for (const floor of PRECISION_FLOORS) {
      const keys = keysOf(floor);
      expect(
        builtInRuleChoiceOf([keys[1], keys[0], ...keys.slice(2)]),
      ).toBeUndefined();
      expect(builtInRuleChoiceOf([...keys].reverse())).toBeUndefined();
    }
  });

  test("names no choice for expert-authored keys", () => {
    expect(
      builtInRuleChoiceOf([
        {
          name: "member number and birth date",
          elements: [{ field: "member_number" }, { field: "birth_date" }],
        },
      ]),
    ).toBeUndefined();
    expect(builtInRuleChoiceOf([])).toBeUndefined();
  });

  test("is unmoved by property order, the canonical compare's equality", () => {
    const reordered = keysOf(99).map(
      ({ elements, name, ...rest }) =>
        ({ ...rest, elements, name }) as LinkageKey,
    );
    expect(builtInRuleChoiceOf(reordered)).toBe(99);
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

  test("words each choice by its label", () => {
    expect(builtInRuleChoiceStatement(99)).toBe(
      'The linkage keys are the built-in "highest precision" rules.',
    );
    expect(builtInRuleChoiceStatement(95)).toBe(
      'The linkage keys are the built-in "broader matching" rules.',
    );
  });
});
