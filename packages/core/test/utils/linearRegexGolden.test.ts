import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  compileLinearRegex,
  patternConformsToDialect,
  patternWeightedSize,
} from "../../src/utils/linearRegex";
import { goldenCases, goldenProfile } from "./linearRegexGoldenCases";

// Golden values for the regex engine both parties run: for each case in
// linearRegexGoldenCases.ts, whether core accepts the pattern, its weighted
// size, whether it matches the empty string, and each operation's result and
// search charge, as core's linearRegex.ts derives them on the installed re2js.
// re2js has no exact pin, so a release that changes any of these fails here
// and is reviewed before it lands. To accept a reviewed change, regenerate:
//
//   node packages/core/test/utils/generate-linear-regex-golden.mjs
//
// Each row's columns are GOLDEN_ROW_COLUMNS in linearRegexGoldenCases.ts.

const golden = readFileSync(
  new URL("./linear-regex-golden.jsonl", import.meta.url),
  "utf8",
)
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const core = {
  compileLinearRegex,
  patternConformsToDialect,
  patternWeightedSize,
};
const cases = goldenCases();

describe("linear regex golden values on the installed re2js", () => {
  test("the golden file has one line per case, in order", () => {
    expect(golden.map((line) => line.pattern)).toEqual(
      cases.map((goldenCase) => goldenCase.pattern),
    );
  });

  test.each(
    cases.map(
      (goldenCase, index) =>
        [index, JSON.stringify(goldenCase.pattern), goldenCase] as const,
    ),
  )("case %i: pattern %s", (index, _pattern, goldenCase) => {
    expect(goldenProfile(core, goldenCase)).toEqual(golden[index]);
  });
});
