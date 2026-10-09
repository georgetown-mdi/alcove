import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  BLOCKING_STREAK,
  TIERED_WORKFLOWS,
  formatStreak,
  redStreak,
  scheduledWorkflows,
  workflowStreaks,
} from "./scheduled-run-streak.mjs";
import { parseWorkflow, readWorkflows } from "./lib/workflows.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  test("counts the red runs since the newest success, whatever order gh lists them in", () => {
    const streak = redStreak([
      run(2, 2, "success"),
      run(5, 5, "failure"),
      run(3, 3, "failure"),
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

  test("neither breaks nor extends a streak with a cancelled or skipped run", () => {
    const streak = redStreak([
      run(6, 6, "skipped"),
      run(5, 5, "failure"),
      run(4, 4, "cancelled"),
      run(3, 3, "failure"),
      run(2, 2, "success"),
      run(1, 1, "failure"),
    ]);
    expect(streak.count).toBe(2);
    expect(streak.runIds).toEqual([5, 3]);
    expect(streak.lastGreen).toBe("2026-10-02T04:50:00Z");
    expect(redStreak([run(2, 2, "cancelled"), run(1, 1, "skipped")])).toEqual({
      count: 0,
      runIds: [],
      since: null,
      lastGreen: null,
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

describe("workflowStreaks", () => {
  const STRESS = "nightly_core_stress.yaml";
  const NIGHTLY_JOBS = [
    "List the stress test files",
    "Core PSI stress (short files)",
    "Core PSI stress (test/stress/recordPastStringCap.stress.test.ts)",
  ];
  const WEEKLY_JOBS = [
    "List the stress test files",
    "Core PSI stress (test/stress/psiRoundWalls.stress.test.ts)",
  ];
  const tierRun = (id, day, conclusion, jobNames) => ({
    ...run(id, day, conclusion),
    jobNames,
  });

  test("tallies a weekly tier red every Sunday apart from the green nightlies between", () => {
    const runs = [];
    for (let day = 1; day <= 28; day += 1) {
      runs.push(tierRun(100 + day, day, "success", NIGHTLY_JOBS));
      if (day % 7 === 4)
        runs.push(tierRun(200 + day, day, "failure", WEEKLY_JOBS));
    }
    runs.push(tierRun(1, 1, "success", WEEKLY_JOBS));
    const [nightly, weekly] = workflowStreaks(STRESS, runs);
    expect(nightly.name).toBe(`${STRESS} (nightly)`);
    expect(nightly.streak.count).toBe(0);
    expect(weekly.name).toBe(`${STRESS} (weekly)`);
    expect(weekly.streak.runIds).toEqual([225, 218, 211, 204]);
    expect(formatStreak(weekly.name, weekly.streak)).toContain(
      `${STRESS} (weekly): BLOCKING: red for more than ${BLOCKING_STREAK} scheduled runs`,
    );
  });

  test("counts a run that started no tier job toward every tier", () => {
    const [nightly, weekly] = workflowStreaks(STRESS, [
      tierRun(3, 3, "failure", ["List the stress test files"]),
      tierRun(2, 2, "success", NIGHTLY_JOBS),
      tierRun(1, 1, "success", WEEKLY_JOBS),
    ]);
    expect(nightly.streak.runIds).toEqual([3]);
    expect(weekly.streak.runIds).toEqual([3]);
  });

  test("gives a workflow with one cron one streak under its own name", () => {
    const streaks = workflowStreaks("nightly.yaml", [run(1, 1, "failure")]);
    expect(streaks).toEqual([
      { name: "nightly.yaml", streak: redStreak([run(1, 1, "failure")]) },
    ]);
  });

  test("covers every workflow of this repository with more than one cron", () => {
    const multiCron = readWorkflows(ROOT)
      .filter(({ path, source }) => {
        const schedule = parseWorkflow(path, source)?.on?.schedule;
        return Array.isArray(schedule) && schedule.length > 1;
      })
      .map(({ path }) => path.split("/").at(-1));
    expect(multiCron.sort()).toEqual(Object.keys(TIERED_WORKFLOWS).sort());
  });

  test("matches the job names the stress workflow gives its tiers", () => {
    const source = readFileSync(
      join(ROOT, ".github/workflows", STRESS),
      "utf8",
    );
    expect(source).toContain("name: Core PSI stress (${{ matrix.job.name }})");
    expect(source).toContain('{ name: "short files",');
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
    expect(line).toMatch(/^nightly\.yaml: red, 3 scheduled runs since /);
    expect(line).not.toContain("BLOCKING");
  });

  test(`calls a streak past ${BLOCKING_STREAK} blocking and names its runs`, () => {
    const line = formatStreak("nightly.yaml", streakOf(BLOCKING_STREAK + 1));
    expect(line).toContain(
      "BLOCKING: red for more than 3 scheduled runs, 4 scheduled runs since",
    );
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
