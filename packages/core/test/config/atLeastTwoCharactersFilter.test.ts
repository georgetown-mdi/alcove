import { describe, expect, test } from "vitest";

import { summarizeInvitation } from "../../src/consent/invitationSummary";
import { inferMetadata } from "../../src/config/metadata";
import {
  AT_LEAST_TWO_CHARACTERS_LABEL,
  isAtLeastTwoCharactersFilter,
} from "../../src/config/transformParamDisplay";
import { defaultStepsForType } from "../../src/defaults/builtInStandardization";
import { getDefaultLinkageTerms } from "../../src/defaults/builtInLinkageTerms";

import type {
  LinkageTerms,
  TransformStep,
} from "../../src/config/linkageTermsSchema";

const BUILT_IN_PATTERN = "^.{2,}$";

interface StepUnderTest {
  function: string;
  params?: unknown;
}

const filterOn = (pattern: unknown): StepUnderTest => ({
  function: "filter_regex",
  params: { pattern },
});

describe("isAtLeastTwoCharactersFilter", () => {
  test("recognizes the pattern the built-in last-name cleaning declares", () => {
    const steps = defaultStepsForType("last_name") ?? [];
    expect(steps.filter(isAtLeastTwoCharactersFilter)).toHaveLength(1);
  });

  test("recognizes the step every built-in full-first-name key declares", () => {
    const metadata = inferMetadata(
      ["ssn", "first_name", "last_name", "dob"],
      [],
    );
    const keys = getDefaultLinkageTerms("Inviter", metadata).linkageKeys;
    const recognized = keys.flatMap((key) =>
      key.elements.flatMap((element) =>
        (element.transform ?? []).filter(isAtLeastTwoCharactersFilter),
      ),
    );
    expect(recognized.length).toBeGreaterThan(0);
  });

  test.each([
    ["a larger minimum", filterOn("^.{3,}$")],
    ["no end anchor", filterOn("^.{2,}")],
    ["no start anchor", filterOn(".{2,}$")],
    ["a trailing space", filterOn("^.{2,}$ ")],
    ["a different spelling of the same set", filterOn("^..+$")],
    ["a non-string pattern", filterOn(2)],
    ["no params", { function: "filter_regex" }],
    ["an empty params object", { function: "filter_regex", params: {} }],
    [
      "an extra param beside the pattern",
      {
        function: "filter_regex",
        params: { pattern: BUILT_IN_PATTERN, replacement: "" },
      },
    ],
    [
      "another function declaring the pattern",
      { function: "extract_regex", params: { pattern: BUILT_IN_PATTERN } },
    ],
    [
      "a pattern inherited from the prototype",
      {
        function: "filter_regex",
        params: Object.create({ pattern: BUILT_IN_PATTERN }) as unknown,
      },
    ],
  ] satisfies Array<[string, StepUnderTest]>)("refuses %s", (_name, step) => {
    expect(isAtLeastTwoCharactersFilter(step)).toBe(false);
  });

  test("accepts the exact pattern alone", () => {
    expect(isAtLeastTwoCharactersFilter(filterOn(BUILT_IN_PATTERN))).toBe(true);
  });
});

describe("the consent summary's description of the two-character filter", () => {
  const baseTerms = getDefaultLinkageTerms(
    "Inviter",
    inferMetadata(["ssn", "first_name", "last_name", "dob"], []),
  );
  const termsWith = (transform: Array<TransformStep>): LinkageTerms => ({
    ...baseTerms,
    linkageKeys: [
      { name: "first name", elements: [{ field: "first_name", transform }] },
    ],
  });
  const transformFor = (step: StepUnderTest) =>
    summarizeInvitation({
      linkageTerms: termsWith([step as TransformStep]),
    }).linkageKeys[0].elements[0].transforms[0];

  test("the built-in pattern reads in plain words, its pattern still listed", () => {
    const transform = transformFor(filterOn(BUILT_IN_PATTERN));
    expect(transform.description).toContain(AT_LEAST_TWO_CHARACTERS_LABEL);
    expect(transform.description).not.toMatch(/pattern/);
    expect(transform.params).toEqual([`pattern: ${BUILT_IN_PATTERN}`]);
  });

  test("any other pattern keeps the glossary line that calls it a pattern", () => {
    const transform = transformFor(filterOn("^.{3,}$"));
    expect(transform.description).toBe(
      "Drops values that do not match a pattern, removing them from matching.",
    );
    expect(transform.params).toEqual(["pattern: ^.{3,}$"]);
  });

  test("a partner's step with the built-in pattern and an extra param stays raw", () => {
    const transform = transformFor({
      function: "filter_regex",
      params: { pattern: BUILT_IN_PATTERN, note: "x" },
    });
    expect(transform.description).not.toContain(AT_LEAST_TWO_CHARACTERS_LABEL);
  });
});
