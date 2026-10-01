import { describe, expect, test, vi } from "vitest";

import {
  MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE,
  REGEX_STEP_PATTERN_PARAM,
  findTransformRegexRefusal,
} from "../../src/config/transformRegexDialect";
import { STANDARDIZATION_FUNCTION_DESCRIPTORS } from "../../src/standardization";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import { patternWeightedSize } from "../../src/utils/linearRegex";

// A terms shape holding a single element transform, enough for the gate walk.
const termsWith = (
  transform: Array<{ function: string; params?: Record<string, unknown> }>,
): Pick<LinkageTerms, "linkageKeys"> => ({
  linkageKeys: [{ name: "k", elements: [{ field: "ssn", transform }] }],
});

const rejects = (...args: Parameters<typeof findTransformRegexRefusal>) =>
  findTransformRegexRefusal(...args) !== undefined;

// --- Parity with the regex-tier descriptors ----------------------------------

test("REGEX_STEP_PATTERN_PARAM matches exactly the regex-tier function descriptors", () => {
  const regexTierNames = Object.values(STANDARDIZATION_FUNCTION_DESCRIPTORS)
    .filter((d) => d.tier === "regex")
    .map((d) => d.name)
    .sort();
  expect(Object.keys(REGEX_STEP_PATTERN_PARAM).sort()).toEqual(regexTierNames);

  // Each mapped param name is a real (camelCase) param of that function's
  // descriptor, so the gate reads the param the factory actually compiles.
  for (const [fn, param] of Object.entries(REGEX_STEP_PATTERN_PARAM)) {
    const descriptor = STANDARDIZATION_FUNCTION_DESCRIPTORS[fn];
    expect(descriptor).toBeDefined();
    expect(Object.keys(descriptor.params.shape)).toContain(param);
  }
});

// --- Refusal walk ------------------------------------------------------------

describe("findTransformRegexRefusal", () => {
  test("admits in-dialect raw patterns under the size cap (including a former-ReDoS one)", () => {
    expect(
      rejects(
        termsWith([
          { function: "filter_regex", params: { pattern: "^\\d{9}$" } },
          { function: "replace_regex", params: { pattern: "[^0-9]" } },
          { function: "split_on", params: { delimiter: "[;,]" } },
          { function: "filter_regex", params: { pattern: "(a+)+$" } },
        ]),
      ),
    ).toBe(false);
  });

  test("refuses a pattern outside the dialect (backreference)", () => {
    expect(
      rejects(
        termsWith([
          { function: "filter_regex", params: { pattern: "(a)\\1" } },
        ]),
      ),
    ).toBe(true);
  });

  test("refuses a split_on delimiter outside the dialect (lookahead)", () => {
    expect(
      rejects(
        termsWith([{ function: "split_on", params: { delimiter: "a(?=b)" } }]),
      ),
    ).toBe(true);
  });

  test("does not screen parse_date (its generated regex is always in-dialect)", () => {
    // A format that expands to 24 adjacent `(\d{1,2})` groups -- a backtracking
    // bomb on new RegExp -- is NOT a raw-pattern step, so the walk ignores it; the
    // linear-time engine and the format-length cap bound it instead.
    expect(
      rejects(
        termsWith([
          { function: "parse_date", params: { inputFormat: "MM".repeat(24) } },
        ]),
      ),
    ).toBe(false);
  });

  test("skips a raw-pattern step with no pattern param", () => {
    expect(rejects(termsWith([{ function: "filter_regex", params: {} }]))).toBe(
      false,
    );
  });

  test("coerces a non-string pattern before checking, matching the factory", () => {
    // String(5) === "5", an in-dialect literal -> conformant, as the factory runs.
    expect(
      rejects(
        termsWith([{ function: "filter_regex", params: { pattern: 5 } }]),
      ),
    ).toBe(false);
  });

  test("rejects (fail closed) when the conformance budget is exhausted", () => {
    // A zero budget exhausts before the first pattern is checked, so any terms set
    // with a raw-pattern step rejects closed -- the DoS bound against a terms set
    // packed with patterns.
    expect(
      rejects(
        termsWith([
          { function: "filter_regex", params: { pattern: "^\\d+$" } },
        ]),
        { totalBudgetMs: 0 },
      ),
    ).toBe(true);
  });

  test("measures its budget on the monotonic clock, not the system clock", () => {
    const conformant = termsWith([
      { function: "filter_regex", params: { pattern: "^\\d+$" } },
      { function: "replace_regex", params: { pattern: "[^0-9]" } },
    ]);
    const systemClock = vi.spyOn(Date, "now");
    try {
      // A system clock stepping an hour forward between reads: a walk timed on
      // it would spend the whole budget before reaching the first pattern and
      // refuse terms it never checked.
      let reading = Date.UTC(2026, 0, 1);
      systemClock.mockImplementation(() => (reading += 3_600_000));
      expect(rejects(conformant)).toBe(false);

      // And an hour backward between reads, the fail-open direction: a walk
      // timed on it sees a negative elapsed time, so no budget ever runs out.
      systemClock.mockImplementation(() => (reading -= 3_600_000));
      expect(
        rejects(conformant, {
          totalBudgetMs: 0,
        }),
      ).toBe(true);
    } finally {
      systemClock.mockRestore();
    }
  });

  test("rejects an oversized in-dialect source on length, before compiling it", () => {
    // An IN-DIALECT pattern longer than maxPatternLength. The gate must reject it
    // on length WITHOUT compiling: RE2JS.compile's cost is super-linear in source
    // length, so a ~150KB in-dialect pattern would otherwise stall validation for
    // seconds (the schema's over-length refine cannot interrupt that compile).
    const oversized = "a".repeat(2000); // in-dialect, > the 1000 bound
    expect(
      rejects(
        termsWith([
          { function: "replace_regex", params: { pattern: oversized } },
        ]),
        { maxPatternLength: 1000 },
      ),
    ).toBe(true);
    // Without the bound the same pattern is compiled and refused on weighted
    // size instead; the production caller (LinkageTermsSchema) always passes
    // the bound, so it is refused before compiling.
    expect(
      findTransformRegexRefusal(
        termsWith([
          { function: "replace_regex", params: { pattern: oversized } },
        ]),
      ),
    ).toMatchObject({ reason: "size" });
  });
});

// --- Weighted-size cap -------------------------------------------------------

describe("the transform-pattern weighted-size cap", () => {
  // a{n} compiles to n + 2 instructions with no capture group, so a{998} sits
  // exactly at the cap and a{999} one past it.
  const atCap = "a{998}";
  const pastCap = "a{999}";

  test("a pattern at the cap is admitted and one past it refused", () => {
    expect(patternWeightedSize(atCap)).toBe(
      MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE,
    );
    expect(patternWeightedSize(pastCap)).toBe(
      MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE + 1,
    );
    expect(
      findTransformRegexRefusal(
        termsWith([{ function: "filter_regex", params: { pattern: atCap } }]),
      ),
    ).toBeUndefined();
    expect(
      findTransformRegexRefusal({
        linkageKeys: [
          { name: "k0", elements: [{ field: "ssn" }] },
          {
            name: "k1",
            elements: [
              { field: "ssn" },
              {
                field: "dob",
                transform: [
                  { function: "to_upper_case" },
                  { function: "split_on", params: { delimiter: pastCap } },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      reason: "size",
      keyIndex: 1,
      elementIndex: 1,
      stepIndex: 1,
      paramKey: "delimiter",
      weightedSize: MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE + 1,
    });
  });

  test("weights a capture group above the same repetition left non-capturing", () => {
    const capturing = patternWeightedSize("(a{0,9})(b{0,9})");
    const nonCapturing = patternWeightedSize("(?:a{0,9})(?:b{0,9})");
    expect(capturing).toBeGreaterThanOrEqual(3 * nonCapturing);
    // A body admitted bare is refused once its repetitions capture.
    const bare = "(?:.{0,9}){30}";
    const captured = "(.{0,9}){30}";
    expect(
      rejects(
        termsWith([{ function: "extract_regex", params: { pattern: bare } }]),
      ),
    ).toBe(false);
    expect(
      findTransformRegexRefusal(
        termsWith([
          { function: "extract_regex", params: { pattern: captured } },
        ]),
      ),
    ).toMatchObject({ reason: "size" });
  });

  test("counts nested repetitions by their product, not their sum", () => {
    // Nested bounds 30 x 30 against the same two bounds side by side.
    const nested = patternWeightedSize("(?:a{0,30}){0,30}");
    const flat = patternWeightedSize("a{0,30}a{0,30}");
    expect(nested).toBeGreaterThan(MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE);
    expect(flat).toBeLessThan(MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE);
    expect(nested).toBeGreaterThanOrEqual(30 * 30);
  });

  // Each pattern compiles in about 200 ms unloaded; the timeout leaves room
  // for a loaded container.
  test(
    "refuses the measured worst cases the cap was calibrated against",
    {
      timeout: 30_000,
    },
    () => {
      for (const pattern of [
        "(.{0,999})".repeat(99) + "z",
        "^" + ".{0,999}".repeat(123) + "z$",
      ]) {
        expect(pattern.length).toBeLessThanOrEqual(1000);
        expect(
          findTransformRegexRefusal(
            termsWith([{ function: "extract_regex", params: { pattern } }]),
            { maxPatternLength: 1000 },
          ),
        ).toMatchObject({ reason: "size" });
      }
    },
  );
});
