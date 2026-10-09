import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHECKS,
  OUT_OF_CHECK_ALL,
  SEPARATE_WORKFLOW_STEPS,
  inventory,
  runAll,
  runCheck,
  rootScripts,
  summarize,
} from "./run-checks.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = `${WORKFLOW_DIR}/static_checks.yaml`;
const GUARD_JOB = "repo-guards";

const scripts = rootScripts(ROOT);

function guardJobSteps() {
  const workflow = workflowDocument(ROOT, WORKFLOW);
  return workflow.jobs[GUARD_JOB].steps;
}

describe("the check:all list against the root package.json", () => {
  it("classifies every check:* script as run or not run, and nothing twice", () => {
    const declared = Object.keys(scripts).filter(
      (name) => name.startsWith("check:") && name !== "check:all",
    );
    const classified = [
      ...CHECKS.map((check) => check.script),
      ...OUT_OF_CHECK_ALL.map((check) => check.script),
    ];

    expect(new Set(classified).size).toBe(classified.length);
    expect(
      declared.filter((name) => !classified.includes(name)),
      "a check:* script the runner neither runs nor states a reason for skipping: add it to CHECKS with a one-line description, or to OUT_OF_CHECK_ALL with what keeps it off the list",
    ).toEqual([]);
  });

  it("names only scripts that exist", () => {
    for (const entry of [...CHECKS, ...OUT_OF_CHECK_ALL]) {
      expect(
        Object.keys(scripts),
        `${entry.script} is not a root package.json script`,
      ).toContain(entry.script);
    }
  });

  it("gives every check it runs a one-line description", () => {
    for (const check of CHECKS) {
      expect(check.description.trim(), check.script).not.toBe("");
      expect(check.description, check.script).not.toContain("\n");
    }
  });

  it("gives every excluded check a reason", () => {
    for (const check of OUT_OF_CHECK_ALL) {
      expect(check.reason.trim(), check.script).not.toBe("");
    }
  });

  it("runs the runner from check:all", () => {
    expect(scripts["check:all"]).toBe("node scripts/run-checks.mjs");
  });
});

describe("the repo-guards job against the list", () => {
  it("runs the checks through check:all and nothing else beside the audit", () => {
    const commands = guardJobSteps()
      .map((step) => step.run)
      .filter((run) => typeof run === "string")
      .map((run) => run.trim());
    const separate = SEPARATE_WORKFLOW_STEPS.map((step) => step.command);

    expect(commands).toContain("npm run check:all");
    for (const command of commands) {
      if (command === "npm run check:all") continue;
      expect(
        separate.some((allowed) => command.startsWith(allowed)),
        `${WORKFLOW}'s ${GUARD_JOB} job runs \`${command}\` as a step of its own. A repository check belongs in scripts/run-checks.mjs's list, which check:all drives, so that it runs locally too; a step that cannot go there is added to SEPARATE_WORKFLOW_STEPS with the reason.`,
      ).toBe(true);
    }
  });

  it("hands the merge-gate check a token to read the branch rules with", () => {
    const step = guardJobSteps().find(
      (candidate) => candidate.run?.trim() === "npm run check:all",
    );
    expect(step.env?.GITHUB_TOKEN).toBeTruthy();
  });
});

describe("the shared web build", () => {
  const checks = [
    { script: "a", usesBuild: true, description: "" },
    { script: "b", buildFrom: "a", usesBuild: true, description: "" },
    { script: "c", description: "" },
  ];

  it("skips the check reading a build whose maker failed, and runs the rest", () => {
    const ran = [];
    const lines = [];
    const results = runAll(
      "/nonexistent-root",
      (line) => lines.push(line),
      checks,
      (check) => {
        ran.push(check.script);
        return { script: check.script, ok: check.script !== "a", seconds: 0 };
      },
    );
    expect(ran).toEqual(["a", "c"]);
    expect(results.map((result) => result.ok)).toEqual([false, false, true]);
    expect(lines.join("\n")).toContain("web build it reads failed in a");
  });

  it("runs the dependent check when the build succeeded", () => {
    const ran = [];
    runAll(
      "/nonexistent-root",
      () => {},
      checks,
      (check) => {
        ran.push(check.script);
        return { script: check.script, ok: true, seconds: 0 };
      },
    );
    expect(ran).toEqual(["a", "b", "c"]);
  });
});

describe("reporting", () => {
  it("names every failed check in the summary and counts the passes", () => {
    const summary = summarize(
      [
        { script: "linkcheck", ok: true, seconds: 1.24, load: 0.5 },
        { script: "check:vectors", ok: false, seconds: 9.5, load: 12.25 },
        { script: "test:scripts", ok: false, seconds: 30, load: null },
      ],
      8,
    );

    expect(summary).toContain("1 of 3 checks passed in 40.7s, on 8 CPUs;");
    expect(summary).toContain("Failed: check:vectors, test:scripts.");
    expect(summary).toContain("pass  linkcheck");
  });

  it("states the load average each check started under", () => {
    const lines = summarize(
      [
        { script: "linkcheck", ok: true, seconds: 1.24, load: 0.5 },
        { script: "check:vectors", ok: false, seconds: 9.5, load: 12.25 },
        { script: "test:scripts", ok: true, seconds: 30, load: null },
      ],
      8,
    ).split("\n");

    expect(lines.find((line) => line.includes("linkcheck"))).toMatch(
      /load 0\.50$/,
    );
    expect(lines.find((line) => line.includes("check:vectors"))).toMatch(
      /load 12\.25$/,
    );
    expect(lines.find((line) => line.includes("test:scripts"))).toMatch(
      /load n\/a$/,
    );
  });

  it("records the load average a real check started under", () => {
    const result = runCheck(
      { script: "probe", command: [process.execPath, "-e", ""] },
      ROOT,
    );

    expect(result.ok).toBe(true);
    if (process.platform === "win32") expect(result.load).toBeNull();
    else expect(result.load).toBeGreaterThanOrEqual(0);
  });

  it("lists what runs and what does not with its reason", () => {
    const listed = inventory();

    for (const check of CHECKS) expect(listed).toContain(check.script);
    for (const check of OUT_OF_CHECK_ALL) {
      expect(listed).toContain(check.script);
      expect(listed).toContain(check.reason);
    }
  });
});
