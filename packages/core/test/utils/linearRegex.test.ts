import { describe, expect, test } from "vitest";

import {
  compileLinearRegex,
  patternConformsToDialect,
  patternWeightedSize,
} from "../../src/utils/linearRegex";
import type { ScanBudget } from "../../src/utils/linearRegex";

// --- Engine operations -------------------------------------------------------

describe("compileLinearRegex operations", () => {
  test("replaceAll replaces every match, with $n group references", () => {
    expect(compileLinearRegex("[^0-9]").replaceAll("(1) 2-3", "")).toBe("123");
    expect(
      compileLinearRegex("^1(\\d{10})$").replaceAll("15551234567", "$1"),
    ).toBe("5551234567");
    expect(compileLinearRegex("(a)(b)").replaceAll("ab", "$2$1")).toBe("ba");
  });

  test("extractFirst returns group 1, else the whole match, else null", () => {
    expect(compileLinearRegex("(\\d{4})$").extractFirst("5551234")).toBe(
      "1234",
    );
    // No capture group: falls back to the whole match.
    expect(compileLinearRegex("\\d+").extractFirst("abc123")).toBe("123");
    expect(compileLinearRegex("(\\d{4})$").extractFirst("12")).toBeNull();
    // Matches but the result is empty -> null (the `|| null` in the contract).
    expect(compileLinearRegex("(x*)").extractFirst("y")).toBeNull();
  });

  test("test is an unanchored match", () => {
    expect(compileLinearRegex("[A-Z]").test("aBc")).toBe(true);
    expect(compileLinearRegex("[A-Z]").test("abc")).toBe(false);
    expect(compileLinearRegex("^\\d{9}$").test("123456789")).toBe(true);
    expect(compileLinearRegex("^\\d{9}$").test("12345678")).toBe(false);
  });

  test("matches is a full (whole-input) match", () => {
    expect(compileLinearRegex("[A-Z]").matches("A")).toBe(true);
    expect(compileLinearRegex("[A-Z]").matches("aBc")).toBe(false);
    // The decisive difference from test(): an alternation branch that matches a
    // zero-width span at the start anchor satisfies the unanchored find but NOT a
    // full match. `^[a]*|]$` is `(^[a]*) | (]$)`; `^[a]*` matches the empty string.
    expect(compileLinearRegex("^[a]*|]$").test("zzz")).toBe(true);
    expect(compileLinearRegex("^[a]*|]$").matches("zzz")).toBe(false);
  });

  test("split returns the parts around matches (RE2 split semantics)", () => {
    expect(compileLinearRegex("[;,]").split("a;b,c")).toEqual(["a", "b", "c"]);
    // Unlike String.prototype.split, capture groups are NOT emitted as parts.
    expect(compileLinearRegex("(\\d)").split("a1b2")).toEqual(["a", "b", ""]);
  });

  test("matchGroups returns [whole, ...groups] or null", () => {
    const re = compileLinearRegex("^(\\d{1,2})/(\\d{1,2})/(\\d{4})$");
    expect(re.matchGroups("1/2/2020")).toEqual(["1/2/2020", "1", "2", "2020"]);
    expect(re.matchGroups("nope")).toBeNull();
  });
});

// --- Dialect conformance -----------------------------------------------------

describe("patternConformsToDialect", () => {
  test("accepts in-dialect patterns, including the bundled defaults", () => {
    for (const pattern of [
      "[^0-9]",
      "^\\d{9}$",
      "(\\d{4})$",
      "[A-Z]",
      "^1(\\d{10})$",
      "^\\d{10}$",
      "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      "(a+)+$", // catastrophic on a backtracking engine; safe and in-dialect here
      "(?P<name>x)", // RE2 named-group syntax
    ]) {
      expect(patternConformsToDialect(pattern)).toBe(true);
    }
  });

  test("rejects patterns outside the dialect (fail closed)", () => {
    for (const pattern of [
      "(a)\\1", // backreference
      "a(?=b)", // lookahead
      "(?<=a)b", // lookbehind
      "\\u00e9", // RE2 uses \\x{...}, not \\uXXXX
      "(", // unparseable
      "[a-", // unparseable
    ]) {
      expect(patternConformsToDialect(pattern)).toBe(false);
    }
  });
});

// --- Dialect semantics that differ from JavaScript RegExp --------------------

describe("RE2 vs JavaScript class semantics", () => {
  test("\\s is ASCII-only -- narrower than JavaScript's Unicode \\s", () => {
    expect(compileLinearRegex("\\s").test("\t")).toBe(true);
    expect(compileLinearRegex("\\s").test(" ")).toBe(true);
    // JavaScript's \s matches each of these (with or without the u flag); RE2 does not.
    for (const ws of ["\u00a0", "\u000b", "\u2028", "\u2029", "\u3000"]) {
      expect(compileLinearRegex("\\s").test(ws)).toBe(false);
    }
  });

  test(". excludes only newline -- it matches CR and Unicode line separators", () => {
    // JavaScript's . (no s flag) also excludes \r, U+2028, U+2029; RE2's does not.
    expect(compileLinearRegex("^.$").matchGroups("\n")).toBeNull();
    for (const ch of ["\r", "\u2028", "\u2029"]) {
      expect(compileLinearRegex("^.$").matchGroups(ch)).not.toBeNull();
    }
  });
});

// --- Replacement-string semantics --------------------------------------------
// The replacement string is not part of the pattern dialect, so the
// cross-engine equivalence tests do not cover it, and two of its
// $-sequences resolve differently here than under String.prototype.replace.
// Both parties hash the same partner-authored terms into their keys, so a
// reimplementation that used a JavaScript RegExp here would derive
// different keys from the same terms rather than fail. PROTOCOL.md states
// the normative rule; these hold it.

describe("replacement-string $-sequences", () => {
  test("a leading-zero group reference is literal", () => {
    // JavaScript resolves "$01" to group 1: "ab".replace(/(a)(b)/g, "$01") is "a".
    expect(compileLinearRegex("(a)(b)").replaceAll("ab", "$01")).toBe("$01");
    expect(compileLinearRegex("(a)").replaceAll("a", "$012")).toBe("$012");
  });

  test("a $<name> naming no group in the pattern is literal", () => {
    // JavaScript substitutes the empty string once the pattern has any named
    // group: "a".replace(/(?<g>a)/g, "$<nope>") is "".
    expect(compileLinearRegex("(?<g>a)").replaceAll("a", "$<nope>")).toBe(
      "$<nope>",
    );
  });

  test("the recognized sequences resolve as JavaScript does", () => {
    const re = compileLinearRegex("(a)(b)");
    expect(re.replaceAll("ab", "$1")).toBe("a");
    expect(re.replaceAll("ab", "$2")).toBe("b");
    expect(re.replaceAll("ab", "$&")).toBe("ab");
    expect(re.replaceAll("xaby", "$`")).toBe("xxy");
    expect(re.replaceAll("xaby", "$'")).toBe("xyy");
    expect(re.replaceAll("ab", "$$")).toBe("$");
    expect(compileLinearRegex("(?<g>a)").replaceAll("a", "$<g>")).toBe("a");
  });

  test("a numbered reference takes two digits only where the group exists", () => {
    const twelve = compileLinearRegex(
      "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)",
    ).replaceAll("abcdefghijkl", "$12");
    expect(twelve).toBe("l");
    // Two groups: "$12" is group 1 followed by a literal "2", and "$3" -- a group
    // the pattern does not have -- stays literal.
    const two = compileLinearRegex("(a)(b)");
    expect(two.replaceAll("ab", "$12")).toBe("a2");
    expect(two.replaceAll("ab", "$3")).toBe("$3");
  });
});

// --- Unicode-property and case-folding semantics -----------------------------
// PROTOCOL.md admits \p{...} property classes and inline (?i) into the
// dialect. re2js bakes its Unicode tables into the published build, and
// both parties hash the same partner pattern into their keys, so an
// update that changes those tables could silently shift which code
// points match. These pin that behavior so a change fails CI instead.
// Verified against re2js 2.8.3.
//
// The standardization pipeline NFC-normalizes input before the engine sees
// it, canonicalizing some of these code points (e.g. KELVIN SIGN U+212A ->
// "K"). These pin the engine layer directly (no NFC), covering the
// dialect's documented surface; the NFC-stable cases (an accented letter,
// LATIN SMALL LETTER LONG S) remain engine-dependent after normalization.

describe("Unicode-property and case-folding semantics (pinned vs re2js drift)", () => {
  test("\\p{L} matches ASCII and accented letters, not digits", () => {
    const re = compileLinearRegex("^\\p{L}+$");
    expect(re.test("Abc")).toBe(true);
    expect(re.test("\u00e9")).toBe(true); // e-acute, NFC-stable
    expect(re.test("123")).toBe(false);
  });

  test("\\p{Nd} matches decimal digits, not letters", () => {
    const re = compileLinearRegex("^\\p{Nd}+$");
    expect(re.test("123")).toBe(true);
    expect(re.test("abc")).toBe(false);
  });

  test("(?i) folds ASCII case", () => {
    expect(compileLinearRegex("(?i)^abc$").test("ABC")).toBe(true);
  });

  test("(?i) applies re2js's Unicode case-folding orbit", () => {
    // Folds drawn from re2js's bundled CASE_ORBIT table -- the surface a
    // Unicode database bump in an upgrade would move. LATIN SMALL LETTER
    // LONG S U+017F is NFC-stable and folds to 's'; KELVIN SIGN U+212A
    // folds to 'k' (NFC also maps it to 'K', so this matters only for the
    // raw engine); LATIN CAPITAL LETTER I WITH DOT ABOVE U+0130 does NOT
    // fold to ASCII 'i'.
    expect(compileLinearRegex("(?i)^s$").test("\u017f")).toBe(true);
    expect(compileLinearRegex("(?i)^k$").test("\u212a")).toBe(true);
    expect(compileLinearRegex("(?i)^i$").test("\u0130")).toBe(false);
  });
});

// --- Linearity (the whole point) ---------------------------------------------

describe("linear-time execution", () => {
  test("a former catastrophic-backtracking pattern matches in linear time", () => {
    // (a+)+$ against a long non-matching input is the textbook ReDoS: on a
    // backtracking engine this is exponential and would hang. The linear-time
    // engine returns promptly; a generous bound makes the linearity a real check
    // (the true time is sub-millisecond) without flaking on a slow CI host.
    const re = compileLinearRegex("(a+)+$");
    const input = "a".repeat(50) + "!";
    const start = performance.now();
    expect(re.test(input)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("a parse_date format with many adjacent groups does not backtrack", () => {
    // 30 adjacent (\d{1,2}) groups -- the parse_date expansion that hangs
    // new RegExp on a non-matching input -- returns promptly here.
    const source = "^" + "(\\d{1,2})".repeat(30) + "$";
    const re = compileLinearRegex(source);
    const start = performance.now();
    expect(re.matchGroups("1".repeat(80) + "x")).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

// --- The find-all scan budget ------------------------------------------------
// replaceAll and split search again after every match. Under a budget, what
// their searches span beyond one pass over the value is charged times the
// pattern's weighted size, and the read past the allowance stops the engine.

class BudgetCrossed extends Error {}

// A budget of `units` that refuses past them, recording what it was charged.
function scanBudget(units: number): ScanBudget & { charged: number } {
  const budget = {
    charged: 0,
    remaining: units,
    charge(spent: number) {
      budget.charged += spent;
      if (budget.charged > units) throw new BudgetCrossed();
    },
  };
  return budget;
}

const WORK_BUDGET_PER_ROW = 8 * 1024 * 4096;
const RESCANNING_PATTERN = "(?:[^#]*[^#]{0,40}#|.)";

describe("find-all operations under a scan budget", () => {
  // Patterns over every engine route the two operations take: a literal prefix
  // and a required literal (searched with indexOf), empty matches, capture
  // groups loaded for a replacement, named groups, case folding, and a value
  // with surrogate pairs.
  const cases: ReadonlyArray<[string, string, string]> = [
    ["[^0-9]", "(1) 2-3 x", ""],
    ["\\s+", "  a  b\tc  ", " "],
    ["x*", "abc", "-"],
    ["^1(\\d{10})$", "15551234567", "$1"],
    ["(a)(b)", "xabyab", "$2$1$`$'$&$$"],
    ["(?<g>a)", "banana", "<$<g>>"],
    ["abc", "zzabczzabc", "!"],
    ["foo|bar", "a foo b bar c", "_"],
    ["(?i)straße", "STRASSE Straße", "S"],
    ["\\p{L}+", "a😀b c", "w"],
    [",\\s*", "a, b,c ,  d", "|"],
  ];

  test.each(cases)(
    "%s gives the unbudgeted result under a budget",
    (pattern, input, replacement) => {
      const re = compileLinearRegex(pattern);
      const weight = patternWeightedSize(pattern);
      const replaced = scanBudget(WORK_BUDGET_PER_ROW);
      expect(re.replaceAll(input, replacement, replaced)).toBe(
        re.replaceAll(input, replacement),
      );
      const split = scanBudget(WORK_BUDGET_PER_ROW);
      expect(re.split(input, split)).toEqual(re.split(input));
      for (const budget of [replaced, split])
        expect(budget.charged % weight).toBe(0);
    },
  );

  test("one pass over the value is not charged", () => {
    // A pattern with no match reads the value once, in one search: the single
    // match the weighted-size cap already bounds.
    const value = "a".repeat(1000);
    for (const pattern of ["[0-9]", "z", "(?:b|c)d"]) {
      const replaced = scanBudget(WORK_BUDGET_PER_ROW);
      compileLinearRegex(pattern).replaceAll(value, "", replaced);
      expect(replaced.charged).toBe(0);
      const split = scanBudget(WORK_BUDGET_PER_ROW);
      compileLinearRegex(pattern).split(value, split);
      expect(split.charged).toBe(0);
    }
  });

  test.each([
    // A program this small runs on the engine's backtracking route at this
    // length, and one over 500 instructions on its automaton route at any.
    { pattern: "(?:[^#]*#|.)", length: 200 },
    { pattern: "(?:[^#]*[^#]{0,300}#|.)", length: 200 },
  ])(
    "the rescanning $pattern is charged the square of the value",
    ({ pattern, length }) => {
      // Each match is one character, found only after the first alternative has
      // read to the end of the value, so the searches span length + (length -
      // 1) + ... + 1 code units. A count that took the operation as one search,
      // rather than one per match, or that missed the engine's reads, would
      // fall short.
      const value = "a".repeat(length);
      const budget = scanBudget(Number.MAX_SAFE_INTEGER);
      compileLinearRegex(pattern).replaceAll(value, "", budget);
      expect(budget.charged).toBeGreaterThanOrEqual(
        ((length * (length + 1)) / 2 - length) * patternWeightedSize(pattern),
      );
    },
  );

  test.each(["replaceAll", "split"] as const)(
    "%s with the weight-87 rescanning shape at 4096 characters crosses the budget",
    (operation) => {
      const re = compileLinearRegex(RESCANNING_PATTERN);
      expect(patternWeightedSize(RESCANNING_PATTERN)).toBe(87);
      const value = "a".repeat(4096);
      const budget = scanBudget(WORK_BUDGET_PER_ROW);
      expect(() =>
        operation === "replaceAll"
          ? re.replaceAll(value, "", budget)
          : re.split(value, budget),
      ).toThrow(BudgetCrossed);
      // Stopped at the read past the allowance, not after the operation ran on.
      expect(budget.charged).toBeGreaterThan(WORK_BUDGET_PER_ROW);
      expect(budget.charged).toBeLessThanOrEqual(WORK_BUDGET_PER_ROW + 87);
    },
    60_000,
  );

  test.each(["(?:[^#]*#|.)", "([^#]*#|(.))"])(
    "a budget already spent stops %s at its first read past one pass, charged its capped size",
    (pattern) => {
      const budget = scanBudget(0);
      expect(() =>
        compileLinearRegex(pattern).replaceAll("aaaa", "", budget),
      ).toThrow(BudgetCrossed);
      expect(budget.charged).toBe(patternWeightedSize(pattern));
    },
  );

  test("a pattern stopped mid-search runs correctly afterwards", () => {
    const re = compileLinearRegex("(?:[^#]*#|.)");
    expect(() => re.replaceAll("a".repeat(500), "", scanBudget(1000))).toThrow(
      BudgetCrossed,
    );
    expect(re.replaceAll("ab#cd", "<$&>")).toBe("<ab#><c><d>");
    expect(re.split("ab#cd", scanBudget(WORK_BUDGET_PER_ROW))).toEqual(
      re.split("ab#cd"),
    );
  });

  test("a budget whose charge does not refuse a crossing still never returns", () => {
    const lenient: ScanBudget = { remaining: 10, charge: () => {} };
    expect(() =>
      compileLinearRegex("(?:[^#]*#|.)").replaceAll(
        "a".repeat(100),
        "",
        lenient,
      ),
    ).toThrow(/read past its allowance but its budget did not refuse it/);
  });
});
