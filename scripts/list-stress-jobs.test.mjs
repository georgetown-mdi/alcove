import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  GROUPED,
  NIGHTLY_MINUTES,
  WEEKLY_MINUTES,
  listStressJobs,
} from "./list-stress-jobs.mjs";

const SCRIPT = fileURLToPath(new URL("list-stress-jobs.mjs", import.meta.url));
const DIRECTORY = "/checkout/packages/core";
const WALLS = "test/stress/psiRoundWalls.stress.test.ts";
const SOLO_NIGHTLY = [
  "test/stress/canonicalLargeArray.stress.test.ts",
  "test/stress/recordPastStringCap.stress.test.ts",
];

/** A `vitest list --filesOnly --json` listing of the given relative paths. */
const listing = (relativePaths) =>
  relativePaths.map((path) => ({
    file: `${DIRECTORY}/${path}`,
    projectName: "stress",
  }));

const SAMPLE = listing([
  ...Object.keys(WEEKLY_MINUTES),
  ...GROUPED,
  ...SOLO_NIGHTLY,
]);

const nightlyJobs = [
  {
    name: "short files",
    files: GROUPED.join(" "),
    minutes: NIGHTLY_MINUTES,
  },
  ...SOLO_NIGHTLY.map((file) => ({
    name: file,
    files: file,
    minutes: NIGHTLY_MINUTES,
    wallsSizes: "",
  })),
];

const weeklyJobs = Object.entries(WEEKLY_MINUTES)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([file, minutes]) => ({
    name: file,
    files: file,
    minutes,
    wallsSizes: file === WALLS ? "4194304" : "",
  }));

describe("listStressJobs", () => {
  test("the nightly tier groups the short files and gives every other non-weekly file a job", () => {
    expect(listStressJobs(SAMPLE, DIRECTORY, "nightly")).toEqual(nightlyJobs);
  });

  test("the weekly tier lists only the named engine files, with their own limits", () => {
    expect(listStressJobs(SAMPLE, DIRECTORY, "weekly")).toEqual(weeklyJobs);
  });

  test("the weekly job for the walls file pins the round size", () => {
    const walls = listStressJobs(SAMPLE, DIRECTORY, "weekly").filter(
      (job) => job.files === WALLS,
    );
    expect(walls).toEqual([
      { name: WALLS, files: WALLS, minutes: 270, wallsSizes: "4194304" },
    ]);
  });

  test("the all tier is the nightly jobs then the weekly jobs", () => {
    expect(listStressJobs(SAMPLE, DIRECTORY, "all")).toEqual([
      ...nightlyJobs,
      ...weeklyJobs,
    ]);
  });

  test("a file added under test/stress joins the nightly tier", () => {
    const added = "test/stress/addedLater.stress.test.ts";
    const jobs = listStressJobs(
      [...SAMPLE, ...listing([added])],
      DIRECTORY,
      "nightly",
    );
    expect(jobs.map((job) => job.files)).toContain(added);
    expect(listStressJobs(SAMPLE, DIRECTORY, "weekly")).toEqual(
      listStressJobs([...SAMPLE, ...listing([added])], DIRECTORY, "weekly"),
    );
  });

  test("no file is in two jobs, and none is dropped", () => {
    const jobs = listStressJobs(SAMPLE, DIRECTORY, "all");
    const covered = jobs.flatMap((job) => job.files.split(" ")).sort();
    expect(covered).toEqual(
      SAMPLE.map((each) => each.file.slice(DIRECTORY.length + 1)).sort(),
    );
  });

  test("a named file the listing lacks is refused, naming it", () => {
    const withoutWalls = SAMPLE.filter((each) => !each.file.endsWith(WALLS));
    expect(() => listStressJobs(withoutWalls, DIRECTORY, "nightly")).toThrow(
      `the stress project lists no ${WALLS}`,
    );
  });

  test("an unknown tier is refused", () => {
    expect(() => listStressJobs(SAMPLE, DIRECTORY, "monthly")).toThrow(
      "no stress tier monthly",
    );
    expect(() => listStressJobs(SAMPLE, DIRECTORY, undefined)).toThrow(
      "no stress tier undefined",
    );
  });
});

describe("the command line", () => {
  const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const input = JSON.stringify(
    SAMPLE.map((each) => ({
      ...each,
      file: each.file.replace(DIRECTORY, root),
    })),
  );

  /** Runs the script from the repository root with the listing on stdin. */
  const run = (tier) =>
    spawnSync(process.execPath, [SCRIPT, tier], {
      cwd: root,
      input,
      encoding: "utf8",
    });

  test("prints the tier's jobs as one line of JSON, paths relative to the working directory", () => {
    const result = run("weekly");
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual(weeklyJobs);
  });

  test("exits non-zero with the reason on stderr for an unknown tier", () => {
    const result = run("monthly");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no stress tier monthly");
    expect(result.stdout).toBe("");
  });
});
