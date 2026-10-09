import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  JSON_REPORT_DIR_VARIABLE,
  jsonReportFile,
} from "./jsonReportReporter.mjs";

const REPORTER = fileURLToPath(
  new URL("./jsonReportReporter.mjs", import.meta.url),
);
const VITEST = fileURLToPath(
  new URL("../../node_modules/vitest/vitest.mjs", import.meta.url),
);

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("jsonReportFile", () => {
  test("names no file when the variable is unset or empty", () => {
    expect(jsonReportFile({}, "/repo/apps/cli")).toBeUndefined();
    expect(
      jsonReportFile({ [JSON_REPORT_DIR_VARIABLE]: "" }, "/repo/apps/cli"),
    ).toBeUndefined();
  });

  test("names a file in the directory after the workspace and process", () => {
    expect(
      jsonReportFile(
        { [JSON_REPORT_DIR_VARIABLE]: "/tmp/reports" },
        "/repo/apps/cli",
      ),
    ).toBe(`/tmp/reports/cli-${process.pid}.json`);
  });
});

// Driven through a real vitest run of a one-file project that registers the
// reporter, since what it writes is vitest's own JSON reporter's output.
describe("a vitest run with the reporter registered", () => {
  const project = () => {
    const root = mkdtempSync(join(tmpdir(), "json-report-reporter-"));
    dirs.push(root);
    writeFileSync(
      join(root, "vitest.config.mjs"),
      `export default { test: { globals: true, include: ["*.test.mjs"], ` +
        `reporters: ["default", ${JSON.stringify(REPORTER)}] } };\n`,
    );
    writeFileSync(
      join(root, "one.test.mjs"),
      `test("passes", () => { expect(1).toBe(1); });\n`,
    );
    return root;
  };

  const run = (root, env) =>
    spawnSync(process.execPath, [VITEST, "run"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, [JSON_REPORT_DIR_VARIABLE]: "", ...env },
    });

  test("writes vitest's JSON report into the directory the variable names", () => {
    const root = project();
    const out = join(root, "reports");
    const result = run(root, { [JSON_REPORT_DIR_VARIABLE]: out });
    expect(result.status, result.stderr).toBe(0);
    const files = readdirSync(out);
    expect(files).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(out, files[0]), "utf8"));
    expect(report.numPassedTests).toBe(1);
    expect(report.testResults.map((each) => each.name)).toEqual([
      join(root, "one.test.mjs"),
    ]);
    expect(report.testResults[0].endTime).toBeGreaterThanOrEqual(
      report.testResults[0].startTime,
    );
  });

  test("writes and prints nothing when the variable is unset", () => {
    const root = project();
    const result = run(root, {});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("JSON report written");
    expect(result.stdout).not.toContain('"numTotalTests"');
    expect(existsSync(join(root, "reports"))).toBe(false);
    // node_modules holds vitest's own results cache, written on every run.
    expect(
      readdirSync(root)
        .filter((entry) => entry !== "node_modules")
        .sort(),
    ).toEqual(["one.test.mjs", "vitest.config.mjs"]);
  });
});
