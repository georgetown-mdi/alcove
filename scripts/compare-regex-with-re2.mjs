#!/usr/bin/env node
// Compares re2js with C++ RE2 over the regex golden cases
// (packages/core/test/utils/linearRegexGoldenCases.ts): for each pattern,
// whether each engine compiles it and, per input, the first match's group
// spans, whether the whole input matches, and every match a find-all loop
// reaches. A difference is an re2js departure from RE2, the engine
// docs/spec/PROTOCOL.md names. From an installed checkout (npm ci), on a
// machine with Python 3 and internet access:
//
//   node scripts/compare-regex-with-re2.mjs [--python <interpreter>]
//
// It installs google-re2 at GOOGLE_RE2_VERSION into a virtual environment in a
// temporary directory, runs re2-reference.py there, prints each pattern whose
// outcomes differ with both engines' outcomes (on its first three differing
// inputs), and exits 1 on any difference.
// re2js_reference.yaml runs it on a pull request that moves re2js's version.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RE2JS } from "re2js";

import { goldenCases } from "../packages/core/test/utils/linearRegexGoldenCases.ts";

/** The google-re2 release the comparison installs, which bundles its C++ RE2. */
export const GOOGLE_RE2_VERSION = "1.1.20240702";

const REFERENCE_PROGRAM = join(
  dirname(fileURLToPath(import.meta.url)),
  "re2-reference.py",
);
const SHOWN_CHARACTERS = 300;
const SHOWN_INPUTS = 3;

/**
 * The cases as both engines receive them: each input NFC-normalized, as the
 * golden profile runs it.
 */
export function comparisonCases() {
  return goldenCases().map(({ pattern, inputs }) => ({
    pattern,
    inputs: inputs.map((input) => input.normalize("NFC")),
  }));
}

// Code-point index of each UTF-16 index of `text`, so spans compare with the
// reference's, which counts code points.
function codePointIndexes(text) {
  const indexes = new Array(text.length + 1);
  let codePoints = 0;
  for (let i = 0; i <= text.length; i++) {
    indexes[i] = codePoints;
    const unit = text.charCodeAt(i);
    const pairs =
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    if (!pairs) codePoints++;
  }
  return indexes;
}

function inputOutcome(re, input) {
  const at = codePointIndexes(input);
  const span = (matcher, group) =>
    matcher.start(group) < 0
      ? null
      : [at[matcher.start(group)], at[matcher.end(group)]];
  try {
    const first = re.matcher(input);
    const search = first.find()
      ? Array.from({ length: first.groupCount() + 1 }, (_, group) =>
          span(first, group),
        )
      : null;
    const findAll = [];
    const each = re.matcher(input);
    while (each.find()) {
      findAll.push(span(each, 0));
      if (findAll.length > input.length + 1)
        throw new Error("find-all loop did not advance");
    }
    return { search, fullmatch: re.matcher(input).matches(), findAll };
  } catch (err) {
    return { throws: err instanceof Error ? err.constructor.name : "value" };
  }
}

/** What re2js does with one case, in the reference program's shape. */
export function re2jsOutcome({ pattern, inputs }) {
  let re;
  try {
    re = RE2JS.compile(pattern);
  } catch (err) {
    return { pattern, compiles: false, error: String(err?.message ?? err) };
  }
  return {
    pattern,
    compiles: true,
    inputs: inputs.map((input) => inputOutcome(re, input)),
  };
}

function shown(value) {
  const text = JSON.stringify(value);
  return text.length <= SHOWN_CHARACTERS
    ? text
    : `${text.slice(0, SHOWN_CHARACTERS)}... (${text.length} characters)`;
}

function compileOutcome(outcome) {
  return outcome.compiles ? "compiles" : `rejects (${outcome.error})`;
}

/**
 * The patterns whose outcomes differ between re2js and the reference, and the
 * patterns and inputs left out because RE2 cannot be given a lone surrogate.
 * Throws when the reference does not answer the same cases in the same order.
 */
export function compareOutcomes(cases, re2js, reference) {
  if (reference.cases.length !== cases.length)
    throw new Error(
      `the reference answered ${reference.cases.length} cases, not ${cases.length}`,
    );
  const differences = [];
  let skippedPatterns = 0;
  let skippedInputs = 0;
  cases.forEach(({ pattern, inputs }, index) => {
    const ours = re2js[index];
    const theirs = reference.cases[index];
    if (theirs.pattern !== pattern)
      throw new Error(
        `case ${index}: the reference answered pattern ${shown(theirs.pattern)}, not ${shown(pattern)}`,
      );
    if (theirs.unencodable) {
      skippedPatterns++;
      return;
    }
    if (ours.compiles !== theirs.compiles) {
      differences.push({
        pattern,
        re2js: compileOutcome(ours),
        re2: compileOutcome(theirs),
      });
      return;
    }
    if (!ours.compiles) return;
    const inputDifferences = [];
    inputs.forEach((input, inputIndex) => {
      const theirInput = theirs.inputs[inputIndex];
      if (theirInput === "unencodable") {
        skippedInputs++;
        return;
      }
      const ourInput = ours.inputs[inputIndex];
      if (JSON.stringify(ourInput) !== JSON.stringify(theirInput))
        inputDifferences.push({ input, re2js: ourInput, re2: theirInput });
    });
    if (inputDifferences.length > 0)
      differences.push({ pattern, inputs: inputDifferences });
  });
  return { differences, skippedPatterns, skippedInputs };
}

/** The report lines for {@link compareOutcomes}'s differences. */
export function formatDifferences(differences) {
  const lines = [];
  for (const difference of differences) {
    lines.push(`pattern ${shown(difference.pattern)}`);
    if (difference.inputs === undefined) {
      lines.push(`  re2js: ${difference.re2js}`, `  RE2:   ${difference.re2}`);
      continue;
    }
    for (const { input, re2js, re2 } of difference.inputs.slice(
      0,
      SHOWN_INPUTS,
    ))
      lines.push(
        `  input ${shown(input)}`,
        `    re2js: ${shown(re2js)}`,
        `    RE2:   ${shown(re2)}`,
      );
    if (difference.inputs.length > SHOWN_INPUTS)
      lines.push(
        `  and ${difference.inputs.length - SHOWN_INPUTS} more inputs differ`,
      );
  }
  return lines;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function main(argv) {
  const pythonFlag = argv.indexOf("--python");
  const python = pythonFlag >= 0 ? argv[pythonFlag + 1] : "python3";
  if (python === undefined) throw new Error("--python names no interpreter");
  const scratch = mkdtempSync(join(tmpdir(), "re2-compare-"));
  try {
    const venv = join(scratch, "venv");
    const venvPython =
      process.platform === "win32"
        ? join(venv, "Scripts", "python.exe")
        : join(venv, "bin", "python");
    run(python, ["-m", "venv", venv]);
    run(venvPython, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-deps",
      "--only-binary=:all:",
      `google-re2==${GOOGLE_RE2_VERSION}`,
    ]);
    const cases = comparisonCases();
    const casesPath = join(scratch, "cases.json");
    const referencePath = join(scratch, "reference.json");
    writeFileSync(casesPath, JSON.stringify(cases));
    run(venvPython, ["-I", REFERENCE_PROGRAM, casesPath, referencePath]);
    const reference = JSON.parse(readFileSync(referencePath, "utf8"));
    const { differences, skippedPatterns, skippedInputs } = compareOutcomes(
      cases,
      cases.map(re2jsOutcome),
      reference,
    );
    console.log(
      `re2js against ${reference.engine}: ${cases.length} patterns, ${differences.length} differ; ` +
        `${skippedPatterns} patterns and ${skippedInputs} inputs left out for a lone surrogate`,
    );
    for (const line of formatDifferences(differences)) console.log(line);
    return differences.length === 0 ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
