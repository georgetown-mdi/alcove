import { describe, expect, test } from "vitest";

import { silentEmptyAnnouncement } from "@components/FieldCoverage";

import type { LinkageField, Standardization } from "@alcove/core";
import type { FieldValueCoverage } from "@psi/workers/nonEmptyAggregate";

const declaredFields: Array<LinkageField> = [
  { name: "first", type: "first_name" },
  { name: "last", type: "last_name" },
  { name: "other_first", type: "first_name" },
];

const standardization: Standardization = [
  { output: "first", input: "FN" },
  { output: "last", input: "LN" },
  { output: "other_first", input: "FN2" },
];

function coverage(
  output: string,
  produced: number,
  overrides: Partial<FieldValueCoverage> = {},
): FieldValueCoverage {
  return {
    output,
    input: "col",
    total: 10,
    produced,
    rate: produced / 10,
    unavailable: false,
    ...overrides,
  };
}

function announce(
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
  overrides: {
    standardization?: Standardization;
    declaredFields?: Array<LinkageField>;
  } = {},
): string {
  return silentEmptyAnnouncement({
    rates,
    standardization: overrides.standardization ?? standardization,
    declaredFields: overrides.declaredFields ?? declaredFields,
  });
}

describe("silentEmptyAnnouncement", () => {
  test("is empty before any coverage has settled", () => {
    expect(announce(null)).toBe("");
  });

  test("is empty when every field produces a value for some row", () => {
    const rates = new Map([
      ["first", coverage("first", 10)],
      ["last", coverage("last", 1)],
    ]);
    expect(announce(rates)).toBe("");
  });

  test("names one silent-empty field by its type label, in the singular", () => {
    const rates = new Map([
      ["first", coverage("first", 0)],
      ["last", coverage("last", 5)],
    ]);
    expect(announce(rates)).toBe(
      "Coverage warning: First name produces no value for any row and cannot match. Check the cleaning steps.",
    );
  });

  test("names several silent-empty fields in standardization order, in the plural", () => {
    const rates = new Map([
      ["last", coverage("last", 0)],
      ["first", coverage("first", 0)],
    ]);
    expect(announce(rates)).toBe(
      "Coverage warning: First name, Last name produce no value for any row and cannot match. Check the cleaning steps.",
    );
  });

  test("de-duplicates fields that share a type label", () => {
    const rates = new Map([
      ["first", coverage("first", 0)],
      ["other_first", coverage("other_first", 0)],
    ]);
    expect(announce(rates)).toBe(
      "Coverage warning: First name produces no value for any row and cannot match. Check the cleaning steps.",
    );
  });

  test("never names a field by its name, which can come from the partner", () => {
    const rates = new Map([["first", coverage("first", 0)]]);
    expect(announce(rates)).not.toContain("first,");
    expect(announce(rates)).not.toContain("Coverage warning: first");
  });

  test("skips an unavailable field and an empty file", () => {
    const rates = new Map([
      ["first", coverage("first", 0, { unavailable: true })],
      ["last", coverage("last", 0, { total: 0, rate: 0 })],
    ]);
    expect(announce(rates)).toBe("");
  });

  test("skips a field with no coverage entry or no declared type", () => {
    const rates = new Map([["last", coverage("last", 0)]]);
    expect(
      announce(rates, {
        declaredFields: [{ name: "first", type: "first_name" }],
      }),
    ).toBe("");
    expect(
      announce(new Map([["first", coverage("first", 0)]]), {
        declaredFields: [],
      }),
    ).toBe("");
    expect(announce(new Map())).toBe("");
  });

  test("ignores coverage for an output the standardization does not list", () => {
    const rates = new Map([["first", coverage("first", 0)]]);
    expect(announce(rates, { standardization: [] })).toBe("");
  });
});
