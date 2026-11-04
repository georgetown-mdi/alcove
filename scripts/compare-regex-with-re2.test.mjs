import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  checkKnownDifferences,
  compareOutcomes,
  comparisonCases,
  formatDifferences,
  formatKnownDifferenceCheck,
  re2jsOutcome,
  readKnownDifferences,
} from "./compare-regex-with-re2.mjs";

// Hand-written reference outcomes in re2-reference.py's shape, since RE2
// itself runs only where google-re2 installs.
const agreeing = {
  pattern: "a(b)?",
  compiles: true,
  inputs: [
    { search: [[0, 1], null], fullmatch: true, findAll: [[0, 1]] },
    {
      search: [
        [1, 3],
        [2, 3],
      ],
      fullmatch: false,
      findAll: [
        [1, 3],
        [3, 4],
      ],
    },
  ],
};

function compare(cases, referenceCases) {
  return compareOutcomes(cases, cases.map(re2jsOutcome), {
    engine: "google-re2 test",
    cases: referenceCases,
  });
}

describe("re2js outcomes", () => {
  test("spans count code points and an unmatched group is null", () => {
    expect(
      re2jsOutcome({ pattern: "(a)|(b)", inputs: ["\u{1F600}b"] }),
    ).toEqual({
      pattern: "(a)|(b)",
      compiles: true,
      inputs: [
        { search: [[1, 2], null, [1, 2]], fullmatch: false, findAll: [[1, 2]] },
      ],
    });
  });

  // re2-reference.py's find-all loop restarts where a match ended, one code
  // point on after an empty match, and keeps an empty match that abuts the one
  // before it; re2js's own Matcher.find must do the same.
  test("find-all follows the loop the reference program runs", () => {
    expect(
      re2jsOutcome({ pattern: "a*", inputs: ["baaac", "\u{1F600}\u{1F600}"] })
        .inputs[0].findAll,
    ).toEqual([
      [0, 0],
      [1, 4],
      [4, 4],
      [5, 5],
    ]);
    expect(
      re2jsOutcome({ pattern: "", inputs: ["\u{1F600}\u{1F600}"] }).inputs[0]
        .findAll,
    ).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  test("a rejected pattern records the engine's message", () => {
    expect(re2jsOutcome({ pattern: "a{2,1}", inputs: ["a"] })).toMatchObject({
      compiles: false,
      error: expect.stringContaining("{2,1}"),
    });
  });

  test("the cases are the golden cases with NFC inputs", () => {
    const cases = comparisonCases();
    expect(cases.length).toBeGreaterThan(400);
    for (const { inputs } of cases)
      for (const input of inputs) expect(input).toBe(input.normalize("NFC"));
  });
});

describe("comparison against a reference", () => {
  test("agreeing outcomes report no difference", () => {
    const result = compare(
      [{ pattern: "a(b)?", inputs: ["a", "xaba"] }],
      [agreeing],
    );
    expect(result).toEqual({
      differences: [],
      skippedPatterns: 0,
      skippedInputs: 0,
    });
  });

  test("a compile disagreement lists the pattern with both outcomes", () => {
    const { differences } = compare(
      [
        { pattern: "a(b)?", inputs: ["a", "xaba"] },
        { pattern: "\\pN", inputs: ["a"] },
        { pattern: "a{2,1}", inputs: ["a"] },
      ],
      [
        agreeing,
        { pattern: "\\pN", compiles: false, error: "invalid escape" },
        { pattern: "a{2,1}", compiles: true, inputs: ["unencodable"] },
      ],
    );
    expect(differences.map(({ pattern }) => pattern)).toEqual([
      "\\pN",
      "a{2,1}",
    ]);
    expect(differences[0]).toEqual({
      pattern: "\\pN",
      re2js: "compiles",
      re2: "rejects (invalid escape)",
    });
    expect(differences[1].re2).toBe("compiles");
    expect(differences[1].re2js).toMatch(/^rejects \(/);
    expect(formatDifferences(differences.slice(0, 1))).toEqual([
      'pattern "\\\\pN"',
      "  re2js: compiles",
      "  RE2:   rejects (invalid escape)",
    ]);
  });

  test("a match disagreement lists each differing input with both outcomes", () => {
    const reference = {
      ...agreeing,
      inputs: [
        agreeing.inputs[0],
        { ...agreeing.inputs[1], findAll: [[1, 3]] },
      ],
    };
    const { differences } = compare(
      [{ pattern: "a(b)?", inputs: ["a", "xaba"] }],
      [reference],
    );
    expect(differences).toEqual([
      {
        pattern: "a(b)?",
        inputs: [
          {
            input: "xaba",
            re2js: agreeing.inputs[1],
            re2: reference.inputs[1],
          },
        ],
      },
    ]);
    expect(formatDifferences(differences)).toEqual([
      'pattern "a(b)?"',
      '  input "xaba"',
      `    re2js: ${JSON.stringify(agreeing.inputs[1])}`,
      `    RE2:   ${JSON.stringify(reference.inputs[1])}`,
    ]);
  });

  test("a pattern or input RE2 cannot be given is counted, not compared", () => {
    const result = compare(
      [
        { pattern: "\uD800", inputs: ["a"] },
        { pattern: "a(b)?", inputs: ["a", "\uD800", "xaba"] },
      ],
      [
        { pattern: "\uD800", unencodable: true },
        {
          ...agreeing,
          inputs: [agreeing.inputs[0], "unencodable", agreeing.inputs[1]],
        },
      ],
    );
    expect(result).toEqual({
      differences: [],
      skippedPatterns: 1,
      skippedInputs: 1,
    });
  });

  test("a reference answering other cases is refused", () => {
    const cases = [{ pattern: "a(b)?", inputs: ["a", "xaba"] }];
    expect(() => compare(cases, [])).toThrow(/answered 0 cases, not 1/);
    expect(() => compare(cases, [{ ...agreeing, pattern: "b" }])).toThrow(
      /case 0: the reference answered pattern "b"/,
    );
  });

  test("the report shows every differing input and each outcome in full", () => {
    const long = "a".repeat(2000);
    const inputs = ["a", "b", "c", "d", "e"].map((input) => ({
      input,
      re2js: { findAll: [long] },
      re2: null,
    }));
    const lines = formatDifferences([{ pattern: "a", inputs }]);
    expect(lines.filter((line) => line.startsWith("  input "))).toHaveLength(5);
    expect(lines).toContain(
      `    re2js: ${JSON.stringify({ findAll: [long] })}`,
    );
  });
});

describe("known differences", () => {
  const cases = [
    { pattern: "a(b)?", inputs: ["a", "xaba"] },
    { pattern: "\\pN", inputs: ["a"] },
  ];
  const rejecting = { pattern: "\\pN", compiles: false, error: "invalid" };
  const accepting = {
    pattern: "\\pN",
    compiles: true,
    inputs: [{ search: null, fullmatch: false, findAll: [] }],
  };
  const known = [{ pattern: "\\pN", cause: "RE2 has no \\pN" }];

  test("a listed difference passes and the report gives its cause", () => {
    const { differences } = compare(cases, [agreeing, rejecting]);
    expect(checkKnownDifferences(differences, known)).toEqual({
      unlisted: [],
      agreeing: [],
    });
    expect(formatDifferences(differences, known)).toEqual([
      'pattern "\\\\pN"',
      "  known: RE2 has no \\pN",
      "  re2js: compiles",
      "  RE2:   rejects (invalid)",
    ]);
  });

  test("a difference the list does not name fails, naming the pattern", () => {
    const { differences } = compare(cases, [agreeing, rejecting]);
    const check = checkKnownDifferences(differences, []);
    expect(check).toEqual({ unlisted: ["\\pN"], agreeing: [] });
    expect(formatKnownDifferenceCheck(check)).toEqual([
      'differs and is not in re2-known-differences.json: "\\\\pN"',
    ]);
  });

  test("a listed pattern that no longer differs fails, naming it", () => {
    const { differences } = compare(cases, [agreeing, accepting]);
    expect(differences).toEqual([]);
    const check = checkKnownDifferences(differences, known);
    expect(check).toEqual({ unlisted: [], agreeing: ["\\pN"] });
    expect(formatKnownDifferenceCheck(check)).toEqual([
      'in re2-known-differences.json but no longer differs, so remove it: "\\\\pN"',
    ]);
  });

  test("a list naming a pattern twice is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "re2-known-"));
    try {
      const path = join(dir, "known.json");
      writeFileSync(path, JSON.stringify([...known, ...known]));
      expect(() => readKnownDifferences(path)).toThrow(
        /lists pattern .* twice/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the checked-in list names golden patterns, each with a cause", () => {
    const patterns = new Set(comparisonCases().map(({ pattern }) => pattern));
    const listed = readKnownDifferences();
    expect(listed.length).toBeGreaterThan(0);
    for (const { pattern, cause } of listed) {
      expect(patterns.has(pattern), pattern).toBe(true);
      expect(cause, pattern).toMatch(/\S/);
    }
  });
});
