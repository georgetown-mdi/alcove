import { createHash } from "node:crypto";

import type {
  CompiledLinearRegex,
  ScanBudget,
} from "../../src/utils/linearRegex";

// The cases and the profile behind linear-regex-golden.jsonl. Both the test
// (linearRegexGolden.test.ts) and the generator (generate-linear-regex-golden.mjs)
// read them from here; the generator runs under Node's type stripping, so this
// module imports nothing but types and node: built-ins.

/** The core functions a profile runs, passed in so Node can load this file. */
export interface LinearRegexCore {
  compileLinearRegex: (pattern: string) => CompiledLinearRegex;
  patternWeightedSize: (pattern: string) => number;
  patternConformsToDialect: (pattern: string) => boolean;
}

/** One pattern and the inputs it runs on. */
export interface GoldenCase {
  pattern: string;
  inputs: string[];
}

function xorshift(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % n;
  };
}

/**
 * The cases, one family per area of re2js a release is likely to move: the
 * parser, anchors and word boundaries, lazy-DFA state growth, case folding and
 * Unicode classes, and sub-expressions that can never match.
 */
export function goldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const add = (pattern: string, inputs: string[]) =>
    cases.push({ pattern, inputs });
  const rand = xorshift(4242);
  const randomOver = (chars: string[], n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += chars[rand(chars.length)];
    return s;
  };

  // prettier-ignore
  const parserPatterns = [
    "", "a{1000}", "a{1001}", "(a{100}){10}", "(a{100}){11}", "a{2,1}", "a{,3}", "a{", "a{1", "{", "}", "x{0}",
    "\\8", "\\9", "\\1", "\\07", "\\0", "\\012", "\\0123", "\\377", "\\400", "\\x", "\\x4", "\\x41", "\\x{}",
    "\\x{110000}", "\\x{10FFFF}", "\\x{FFFFFFFFF}", "\\C", "\\Q", "\\Qab", "\\Qa\\E*", "\\E", "\\z", "\\Z", "\\G",
    "\\pX", "\\p{}", "\\p{Foo}", "\\p{^Greek}", "\\P{^Greek}", "\\pZ", "\\p{Zs}", "\\p{Braille}", "\\p{Any}",
    "[]a]", "[^]a]", "[]", "[^]", "[a-]", "[-a]", "[z-a]", "[a-\\d]", "[\\d-z]", "[[:foo:]]", "[[:alpha:]",
    "[[=a=]]", "[[.a.]]", "[\\Q]\\E]", "[\\b]", "(?P<n>a)", "(?<n>a)", "(?P<n>a)(?P<n>b)", "(?P<>a)", "(?P<1>a)",
    "(?P<n!>a)", "(?P=n)", "(?P>n)", "(?'n'a)", "(?#c)", "(?=a)", "(?!a)", "(?<=a)", "(?<!a)", "(?i", "(?i)",
    "(?i-)", "(?-)", "(?i-i)", "(?x)a b", "(?U)a+", "(?s).", "(?m)^a$", "(?im-s:a.)", "(?:", "(", ")", "a)", "(a",
    "a**", "a*+", "a++", "a?*", "a{2}{3}", "a{2}*", "*a", "+a", "?a", "a|*", "(|a)", "(a|)", "||", "^*", "$+",
    "\\b*", "(?:)*", "(?:)+", "()", "(())", "\\", "a\\", "\\ä", "\\-", "\\_", "\\@", "\\<", "\\>", "\\k<n>",
    "\\N{LATIN SMALL LETTER A}", "\\u0041", "\\cA", "\\e", "\\h", "\\R", "\\X", "[\\p{Greek}--\\p{Lu}]",
    "[a&&b]", "\\d{1,2}\\d{1,2}", "^(\\d{1,2})/(\\d{1,2})/(\\d{4})$", "^(\\d{4})-(\\d{1,2})-(\\d{1,2})$",
    "^(\\d{2})(\\d{1,2})(\\d{1,2})$", "^[A-Z]$", "^[^A-Z]$", "^[a]*|]$", "^[\\^A-Z]$", "^[A-Z\\-'. ]$",
    "\uD800", "a\uDC00", "\u{1F600}+", "[\uD800-\uDBFF]",
  ];
  // prettier-ignore
  const parserInputs = ["", "a", "aa", "a b", "12/31/2024", "2024-1-5", "\uD800", "\u{1F600}\u{1F600}", "Ab-'. Z"];
  for (const pattern of parserPatterns) add(pattern, parserInputs);

  // prettier-ignore
  const anchorPatterns = [
    "\\b", "\\B", "\\bk\\b", "\\Bk\\B", "^", "$", "^$", "\\A", "\\z", "\\A\\z", "(?m)^", "(?m)$", "(?m)^\\w+$",
    "(?m)^$", "\\b\\w+\\b", "\\B\\w+\\B", "\\b.", ".\\b", "\\b\u00e9", "\u00e9\\b", "\\b\\x{212A}", "(?i)\\bk\\b",
    "\\b_\\b", "\\b0\\b", "^\\s*$", "\\s+$", "^\\s+", "(?s)^.*$", "^.*$", "(?m)\\b$", "(?m)^\\b",
    "\\b(?:a|b)*\\b", "$\\b", "\\b^", "(?:^|\\s)k(?:\\s|$)", "\\b\\B", "^^", "$$", "\\A^", "\\z$", "(?m)\\A^",
    "(?m)$\\z",
  ];
  // prettier-ignore
  const anchorChars = ["k", "K", "a", "_", "0", " ", "\n", "\r", "\t", "\u00e9", "\u212a", "-", ".", "\u00a0",
    "\u{1F600}", "\u2028"];
  // prettier-ignore
  const anchorInputs = ["", "k", " k ", "k\nk", "\nk\n", "\u00e9 k_\u00e9", "akKk", "\r\n", "a b", "k k k\nkk k"];
  for (let i = 0; i < 8; i++)
    anchorInputs.push(randomOver(anchorChars, 1 + rand(30)));
  for (const pattern of anchorPatterns) add(pattern, anchorInputs);

  // Enough states over long inputs to exhaust the lazy DFA's memory budget.
  const longInputs = [
    randomOver(["a", "b"], 2000),
    randomOver(["a", "b"], 4096),
    randomOver(["a", "b", "c"], 4096),
    "a".repeat(4096),
    "ab".repeat(2048),
  ];
  for (const n of [5, 8, 10, 12, 14, 16, 18, 20]) {
    add(`[ab]*a[ab]{${n}}`, longInputs);
    add(`a[ab]{${n}}b`, longInputs);
    add(`(a|b)*?a(?:a|b){${n}}`, longInputs);
    add(`\\ba[ab]{${n}}\\b`, longInputs);
  }
  add("(?:[ab]{1,3}c){1,9}", longInputs);
  add("(?i)[ab]*A[AB]{12}", longInputs);

  // prettier-ignore
  const foldLetters = ["k", "K", "\u212a", "s", "S", "\u017f", "i", "I", "\u0130", "\u0131", "\u03c3", "\u03a3",
    "\u03c2", "\u00df", "\u1e9e", "\u00e5", "\u00c5", "\u212b", "\u01c4", "\u01c5", "\u01c6", "\u1f80", "\u1f88",
    "\u0390", "\u1fd3", "\u03b8", "\u03d1", "\u03f4", "\u{10400}", "\u{10428}", "\u{1E900}", "\u{1E922}", "\ua7ae",
    "\u026a", "\u0345", "\u0399", "\u03b9", "\u00b5", "\u039c", "\u03bc", "\u1c80", "\u0432", "\u0412", "\u2c2f",
    "\u2c5f", "\ua7cb", "\u0264", "\ua7dc", "\u019b", "\u{16E40}", "\u{16E60}", "\u{1E921}"];
  const foldInput =
    foldLetters.join("") +
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const c of foldLetters) {
    add(`(?i)${c}`, [foldInput]);
    add(`(?i)[${c}]`, [foldInput]);
    add(`(?i)[^${c}]`, [foldInput]);
  }
  // prettier-ignore
  const foldClasses = ["(?i)[a-z]", "(?i)[k-s]", "(?i)\\p{Lu}", "(?i)\\p{Ll}", "(?i)\\p{Lt}", "(?i)\\p{Greek}",
    "(?i)[^a-z]", "(?i)\\w", "(?i)\\W", "(?i)[[:upper:]]", "(?i)[[:lower:]]", "(?i)\\P{Lu}", "(?i)strasse",
    "(?i)\u017f+", "(?i)\u03c3+"];
  for (const pattern of foldClasses) {
    add(pattern, [
      foldInput,
      "Stra\u00dfe STRASSE",
      "\u03a3\u0391\u03a3 \u03c3\u03b1\u03c2",
    ]);
  }

  // A class that can never match, in each position the compiler treats apart.
  // prettier-ignore
  const neverMatching = ["[^\\d\\D]", "\\P{Any}", "[^\\x00-\\x{10FFFF}]", "[^\\p{Any}]", "[^\\s\\S]", "[^\\w\\W]"];
  // prettier-ignore
  const shapes = ["X", "(X)", "(X)?", "(X)*", "(X)+", "X?", "X*", "X+", "aX|b", "(aX)?b", "(aX)*b", "(?:aX)?b",
    "a(X)?", "(X|)", "(X){0,3}b", "(?P<n>X)?b", "b(X)??"];
  for (const never of neverMatching) {
    for (const shape of shapes) {
      add(shape.replaceAll("X", never), [
        "",
        "a",
        "b",
        "ab",
        "ba",
        "bb",
        "xyz",
      ]);
    }
  }
  return cases;
}

const REPLACEMENT = "<$&|$1|$<n>>";
const PREFIX_REPLACEMENT = "<$`>";

/**
 * The columns of each row a profile records, one row per input. Each charge
 * is the units a {@link ScanBudget} was charged for the operation, or
 * `[result, units]` where the result differs from the unbudgeted one.
 */
export const GOLDEN_ROW_COLUMNS = [
  "test",
  "matches",
  "extractFirst",
  "matchGroups",
  "split",
  "replaceAll",
  "testCharge",
  "extractFirstCharge",
  "matchGroupsCharge",
  "splitCharge",
  "replaceAllCharge",
  "prefixReplaceAllCharge",
] as const;

// A value longer than this is recorded as its length and SHA-256, which keeps
// the golden file small for the long DFA inputs.
const LITERAL_LIMIT = 64;

function recorded(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= LITERAL_LIMIT) return value;
  const digest = createHash("sha256").update(text).digest("hex");
  return `sha256:${digest.slice(0, 32)}:${text.length}`;
}

function outcome(run: () => unknown): unknown {
  try {
    return recorded(run());
  } catch (err) {
    return { throws: err instanceof Error ? err.constructor.name : "value" };
  }
}

function charged(
  unbudgeted: unknown,
  run: (budget: ScanBudget) => unknown,
): unknown {
  let spent = 0;
  const budget: ScanBudget = {
    remaining: Number.MAX_SAFE_INTEGER,
    charge(units) {
      spent += units;
    },
  };
  const value = outcome(() => run(budget));
  return JSON.stringify(value) === JSON.stringify(unbudgeted)
    ? spent
    : [value, spent];
}

/** What core derives for one case: the line the golden file records. */
export function goldenProfile(
  core: LinearRegexCore,
  { pattern, inputs }: GoldenCase,
): Record<string, unknown> {
  const compiles = core.patternConformsToDialect(pattern);
  if (!compiles) return { pattern, compiles };
  const re = core.compileLinearRegex(pattern);
  return {
    pattern,
    compiles,
    weightedSize: core.patternWeightedSize(pattern),
    matchesEmpty: outcome(() => re.matches("")),
    rows: inputs.map((raw) => {
      const input = raw.normalize("NFC");
      const test = outcome(() => re.test(input));
      const extract = outcome(() => re.extractFirst(input));
      const groups = outcome(() => re.matchGroups(input));
      const split = outcome(() => re.split(input));
      const replace = outcome(() => re.replaceAll(input, REPLACEMENT));
      const prefixReplace = outcome(() =>
        re.replaceAll(input, PREFIX_REPLACEMENT),
      );
      return [
        test,
        outcome(() => re.matches(input)),
        extract,
        groups,
        split,
        replace,
        charged(test, (b) => re.test(input, b)),
        charged(extract, (b) => re.extractFirst(input, b)),
        charged(groups, (b) => re.matchGroups(input, b)),
        charged(split, (b) => re.split(input, b)),
        charged(replace, (b) => re.replaceAll(input, REPLACEMENT, b)),
        charged(prefixReplace, (b) =>
          re.replaceAll(input, PREFIX_REPLACEMENT, b),
        ),
      ];
    }),
  };
}
