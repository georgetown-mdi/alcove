import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { fileDurations, formatSlowest } from "./slowest-test-files.mjs";

const SCRIPT = fileURLToPath(
  new URL("./slowest-test-files.mjs", import.meta.url),
);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The report shape is vitest's JSON reporter's: testResults, each with the
// module's absolute name, startTime and endTime in ms, and assertionResults.
const result = (name, startTime, endTime, tests = 1, status = "passed") => ({
  name: join(ROOT, name),
  startTime,
  endTime,
  status,
  assertionResults: Array.from({ length: tests }, () => ({})),
});

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("fileDurations", () => {
  test("ranks every file of every report, slowest first, relative to the root", () => {
    const rows = fileDurations(
      [
        { testResults: [result("apps/cli/test/a.test.ts", 100, 1_100, 3)] },
        {
          testResults: [
            result("apps/web/test/b.test.ts", 0, 5_000, 2, "failed"),
            result("apps/web/test/c.test.ts", 10, 20),
          ],
        },
      ],
      ROOT,
    );
    expect(rows).toEqual([
      {
        file: "apps/web/test/b.test.ts",
        durationMs: 5_000,
        tests: 2,
        status: "failed",
      },
      {
        file: "apps/cli/test/a.test.ts",
        durationMs: 1_000,
        tests: 3,
        status: "passed",
      },
      {
        file: "apps/web/test/c.test.ts",
        durationMs: 10,
        tests: 1,
        status: "passed",
      },
    ]);
  });
});

describe("formatSlowest", () => {
  test("lists only the top rows and says how many it left out", () => {
    const rows = [5_000, 4_000, 3_000].map((durationMs, index) => ({
      file: `f${index}.test.ts`,
      durationMs,
      tests: 1,
      status: "passed",
    }));
    const table = formatSlowest(rows, { top: 2, title: "unit" });
    expect(table).toContain("### Slowest test files: unit");
    expect(table).toContain("2 of 3 files.");
    expect(table).toContain("| 1 | `f0.test.ts` | 5.0 | 1 | passed |");
    expect(table).toContain("| 2 | `f1.test.ts` | 4.0 | 1 | passed |");
    expect(table).not.toContain("f2.test.ts");
  });

  test("says when there was no report to read", () => {
    expect(formatSlowest([])).toContain("No vitest JSON report was found.");
  });
});

describe("the command", () => {
  test("reads every report in a directory and prints the table", () => {
    const dir = mkdtempSync(join(tmpdir(), "slowest-test-files-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "cli-1.json"),
      JSON.stringify({ testResults: [result("x.test.ts", 0, 2_500)] }),
    );
    writeFileSync(
      join(dir, "web-2.json"),
      JSON.stringify({ testResults: [result("y.test.ts", 0, 7_500)] }),
    );
    writeFileSync(join(dir, "notes.txt"), "not a report");
    const run = spawnSync(process.execPath, [SCRIPT, "--top", "5", dir], {
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.indexOf("`y.test.ts` | 7.5")).toBeGreaterThan(-1);
    expect(run.stdout.indexOf("`y.test.ts`")).toBeLessThan(
      run.stdout.indexOf("`x.test.ts`"),
    );
  });

  test("refuses a run with no report path", () => {
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage:");
  });
});
