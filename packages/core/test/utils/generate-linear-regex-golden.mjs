// Writes linear-regex-golden.jsonl beside this script: one line per case in
// linearRegexGoldenCases.ts, holding what core's linearRegex.ts derives for it
// on the installed re2js. Run it only to accept a reviewed engine change:
//
//   node packages/core/test/utils/generate-linear-regex-golden.mjs
//
// Node loads the two .ts files by stripping their types.

import { writeFileSync } from "node:fs";

import {
  compileLinearRegex,
  patternConformsToDialect,
  patternWeightedSize,
} from "../../src/utils/linearRegex.ts";
import { goldenCases, goldenProfile } from "./linearRegexGoldenCases.ts";

const core = {
  compileLinearRegex,
  patternConformsToDialect,
  patternWeightedSize,
};
const lines = goldenCases().map((goldenCase) =>
  JSON.stringify(goldenProfile(core, goldenCase)),
);
writeFileSync(
  new URL("./linear-regex-golden.jsonl", import.meta.url),
  `${lines.join("\n")}\n`,
);
