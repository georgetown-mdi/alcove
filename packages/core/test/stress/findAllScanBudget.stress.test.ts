import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildKeyStrings,
  StandardizedDataset,
  StandardizedField,
  transformWorkSpentDerivingKey,
} from "../../src/standardization";
import { UsageError } from "../../src/errors";
import { getLogger } from "../../src/utils/logger";
import {
  compileLinearRegex,
  patternWeightedSize,
} from "../../src/utils/linearRegex";

import type {
  LinkageKey,
  TransformStep,
} from "../../src/config/linkageTermsSchema";

// The figures docs/spec/CHANNEL_SECURITY.md states for the find-all rescan
// charge and for the work budget's dearest charged unit. Rescanning shapes are
// timed unbudgeted and on the exchange path under the budget, which is why this
// is the opt-in tier: unbudgeted they run for seconds. Timings are printed
// rather than asserted, since they are the machine's; outcomes are asserted.

const VALUE_BOUND = 4096;
const WORK_BUDGET_PER_ROW = 8 * 1024 * 4096;
const RESCANNING = (bound: number): string => `(?:[^#]*[^#]{0,${bound}}#|.)`;

// The same pseudo-random [a-z0-9 ] text on every run, with no "#" in it.
function textOfLength(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 ";
  let seed = 7;
  let text = "";
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    text += alphabet[seed % alphabet.length];
  }
  return text;
}

function datasetOf(notes: string): StandardizedDataset {
  const field = new StandardizedField("notes", "notes", [], [{ notes }]);
  return new StandardizedDataset(
    [field],
    [{ name: "notes", elements: [{ field: "notes" }] }],
  );
}

function keyOver(step: TransformStep): LinkageKey {
  return { name: "notes", elements: [{ field: "notes", transform: [step] }] };
}

function findAllStep(
  operation: "replace_regex" | "split_on",
  pattern: string,
): TransformStep {
  return operation === "replace_regex"
    ? { function: "replace_regex", params: { pattern, replacement: "" } }
    : { function: "split_on", params: { delimiter: pattern } };
}

function timed<T>(run: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = run();
  return { result, ms: +(performance.now() - start).toFixed(1) };
}

const host = {
  node: process.version,
  // The package exports no ./package.json, so it is read beside the build.
  re2js: (
    JSON.parse(
      readFileSync(
        join(
          dirname(createRequire(import.meta.url).resolve("re2js")),
          "..",
          "package.json",
        ),
        "utf8",
      ),
    ) as { version: string }
  ).version,
  cpus: cpus().length,
  date: new Date().toISOString().slice(0, 10),
};

describe("find-all scan charge calibration", () => {
  afterEach(() => vi.restoreAllMocks());

  test.each([
    { pattern: "(?:[^#]*#|.)", length: VALUE_BOUND, unbudgeted: true },
    { pattern: RESCANNING(40), length: 200, unbudgeted: true },
    { pattern: RESCANNING(40), length: VALUE_BOUND, unbudgeted: true },
    { pattern: RESCANNING(405), length: 1024, unbudgeted: true },
    // Unbudgeted, this one runs for minutes; only the budgeted run is timed.
    { pattern: RESCANNING(405), length: VALUE_BOUND, unbudgeted: false },
  ])(
    "the rescanning shape $pattern over $length characters, under the budget",
    ({ pattern, length, unbudgeted: timeUnbudgeted }) => {
      vi.spyOn(getLogger("cleaning"), "warn").mockImplementation(() => {});
      const value = textOfLength(length);
      const re = compileLinearRegex(pattern);
      for (const operation of ["replace_regex", "split_on"] as const) {
        const unbudgeted = timeUnbudgeted
          ? timed(() =>
              operation === "replace_regex"
                ? re.replaceAll(value, "")
                : re.split(value),
            )
          : undefined;
        const budgeted = timed(() => {
          try {
            return buildKeyStrings(
              keyOver(findAllStep(operation, pattern)),
              datasetOf(value),
              0,
              false,
              0,
            );
          } catch (err) {
            return err;
          }
        });
        console.log(
          JSON.stringify({
            ...host,
            operation,
            weightedSize: patternWeightedSize(pattern),
            length,
            unbudgetedMs: unbudgeted?.ms,
            budgetedMs: budgeted.ms,
            spent:
              budgeted.result instanceof Set
                ? transformWorkSpentDerivingKey(
                    keyOver(findAllStep(operation, pattern)),
                    datasetOf(value),
                    0,
                  )
                : undefined,
            outcome:
              budgeted.result instanceof UsageError
                ? "refused"
                : budgeted.result === null
                  ? "dropped"
                  : "derived",
          }),
        );
        // A 200-character value is inside the budget's reach and derives its
        // keys; every longer one is stopped, refused where the key's fate is
        // the refusal and dropped where split_on, the declared fan-out
        // producer, makes it the drop.
        if (length <= 200) expect(budgeted.result).toBeInstanceOf(Set);
        else if (operation === "replace_regex")
          expect(budgeted.result).toBeInstanceOf(UsageError);
        else expect(budgeted.result).toBeNull();
      }
    },
    300_000,
  );

  test.each([
    ["replace_regex", "[^A-Za-z0-9]+"],
    ["replace_regex", "\\s+"],
    ["replace_regex", "[aeiou]"],
    ["split_on", "\\s*;\\s*"],
    ["split_on", "[,;]"],
  ] as const)(
    "an ordinary %s (%s) at the value bound derives its keys well inside the budget",
    (operation, pattern) => {
      const value = textOfLength(VALUE_BOUND);
      const step = findAllStep(operation, pattern);
      const derived = timed(() =>
        buildKeyStrings(keyOver(step), datasetOf(value), 0, false, 0),
      );
      const spent = transformWorkSpentDerivingKey(
        keyOver(step),
        datasetOf(value),
        0,
      );
      console.log(
        JSON.stringify({
          ...host,
          operation,
          pattern,
          weightedSize: patternWeightedSize(pattern),
          length: VALUE_BOUND,
          ms: derived.ms,
          spent,
          shareOfBudget: +(spent / WORK_BUDGET_PER_ROW).toFixed(5),
        }),
      );
      expect(derived.result).not.toBeNull();
      expect(spent).toBeLessThan(WORK_BUDGET_PER_ROW / 100);
    },
  );

  test("the dearest charged unit among the regex steps", () => {
    // What one charged unit costs on each regex step, over the shapes that
    // cost the most per value: the at-cap alternation and case-folded window
    // the weighted-size cap was calibrated on, the rescanning shape, and
    // parse_date's longest format. Every step is charged what it reads and
    // produces, and the find-all steps their rescans as well. A step that
    // crosses the budget is read at the crossing. The residual per-row ceiling
    // is the budget times the dearest unit.
    const alternation = Array.from(
      { length: 333 },
      (_unused, i) =>
        "abcdefghijklmnopqrstuvwxyz"[i % 26] +
        "abcdefghijklmnopqrstuvwxyz0123456789"[(i * 7) % 36],
    ).join("|");
    const patterns = [
      alternation,
      "(?i)" + ".{0,9}".repeat(55) + "z",
      RESCANNING(40),
    ];
    const steps: TransformStep[] = [
      ...patterns.flatMap((pattern): TransformStep[] => [
        findAllStep("replace_regex", pattern),
        findAllStep("split_on", pattern),
        { function: "extract_regex", params: { pattern } },
        { function: "filter_regex", params: { pattern } },
      ]),
      {
        function: "parse_date",
        params: { inputFormat: "MM".repeat(128), outputFormat: "YYYYMMDD" },
      },
    ];
    const values = [
      textOfLength(VALUE_BOUND),
      "1".repeat(VALUE_BOUND),
      "1".repeat(256),
    ];
    let dearest = { nsPerUnit: 0, function: "" };
    for (const step of steps) {
      const pattern = String(
        step.params?.pattern ??
          step.params?.delimiter ??
          step.params?.inputFormat,
      );
      for (const value of values) {
        const key = keyOver(step);
        const dataset = datasetOf(value);
        const spend = (): number => {
          try {
            return transformWorkSpentDerivingKey(key, dataset, 0);
          } catch {
            return WORK_BUDGET_PER_ROW;
          }
        };
        const runs = Array.from({ length: 3 }, () => timed(spend));
        const median = [...runs].sort((a, b) => a.ms - b.ms)[1];
        const nsPerUnit = (median.ms * 1e6) / median.result;
        console.log(
          JSON.stringify({
            ...host,
            function: step.function,
            weightedSize:
              step.function === "parse_date"
                ? undefined
                : patternWeightedSize(pattern),
            valueLength: value.length,
            medianMs: median.ms,
            spent: median.result,
            nsPerUnit: +nsPerUnit.toFixed(1),
          }),
        );
        if (nsPerUnit > dearest.nsPerUnit)
          dearest = { nsPerUnit, function: step.function };
      }
    }
    console.log(
      JSON.stringify({
        ...host,
        dearest: dearest.function,
        nsPerUnit: +dearest.nsPerUnit.toFixed(1),
        residualSecondsPerRowKey: +(
          (WORK_BUDGET_PER_ROW * dearest.nsPerUnit) /
          1e9
        ).toFixed(1),
      }),
    );
    expect(dearest.nsPerUnit).toBeGreaterThan(0);
  });
});
