import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  BLOCKING_STREAK,
  formatStreak,
  redStreak,
  scheduledWorkflows,
} from "./scheduled-run-streak.mjs";

// The run shape is `gh run list --json databaseId,status,conclusion,createdAt`.
const run = (databaseId, day, conclusion, status = "completed") => ({
  databaseId,
  status,
  conclusion,
  createdAt: `2026-10-${String(day).padStart(2, "0")}T04:50:00Z`,
});

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("redStreak", () => {
  test("counts the completed runs since the newest success, whatever order gh lists them in", () => {
    const streak = redStreak([
      run(2, 2, "success"),
      run(5, 5, "failure"),
      run(3, 3, "cancelled"),
      run(4, 4, "timed_out"),
      run(1, 1, "failure"),
    ]);
    expect(streak).toEqual({
      count: 3,
      runIds: [5, 4, 3],
      since: "2026-10-03T04:50:00Z",
      lastGreen: "2026-10-02T04:50:00Z",
    });
  });

  test("leaves a run still in progress out of the streak", () => {
    const streak = redStreak([
      run(3, 3, "", "in_progress"),
      run(2, 2, "failure"),
      run(1, 1, "success"),
    ]);
    expect(streak.count).toBe(1);
    expect(streak.runIds).toEqual([2]);
  });

  test("is empty when the newest completed run succeeded", () => {
    const streak = redStreak([run(2, 2, "success"), run(1, 1, "failure")]);
    expect(streak.count).toBe(0);
    expect(streak.lastGreen).toBe("2026-10-02T04:50:00Z");
  });
});

describe("formatStreak", () => {
  const streakOf = (count) =>
    redStreak([
      ...Array.from({ length: count }, (_, index) =>
        run(10 + index, 10 + index, "failure"),
      ),
      run(1, 1, "success"),
    ]);

  test(`calls a streak of ${BLOCKING_STREAK} red but not blocking`, () => {
    const line = formatStreak("nightly.yaml", streakOf(BLOCKING_STREAK));
    expect(line).toMatch(/^nightly\.yaml: red, 3 runs since /);
    expect(line).not.toContain("BLOCKING");
  });

  test(`calls a streak past ${BLOCKING_STREAK} blocking and names its runs`, () => {
    const line = formatStreak("nightly.yaml", streakOf(BLOCKING_STREAK + 1));
    expect(line).toContain("BLOCKING: red for more than 3 runs, 4 runs since");
    expect(line).toContain("(runs 13, 12, 11, 10)");
    expect(line).toContain("last green 2026-10-01T04:50:00Z");
  });

  test("calls a workflow whose last run succeeded green", () => {
    expect(formatStreak("nightly.yaml", streakOf(0))).toMatch(
      /^nightly\.yaml: green/,
    );
  });
});

describe("scheduledWorkflows", () => {
  test("names the workflows with a schedule trigger and no other", () => {
    const root = mkdtempSync(join(tmpdir(), "scheduled-run-streak-"));
    dirs.push(root);
    const workflows = join(root, ".github/workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
      join(workflows, "nightly.yaml"),
      'on:\n  schedule:\n    - cron: "37 4 * * *"\n  workflow_dispatch:\njobs: {}\n',
    );
    writeFileSync(
      join(workflows, "gate.yaml"),
      "on:\n  pull_request:\njobs: {}\n",
    );
    writeFileSync(join(workflows, "push.yaml"), "on: push\njobs: {}\n");
    expect(scheduledWorkflows(root)).toEqual(["nightly.yaml"]);
  });
});
