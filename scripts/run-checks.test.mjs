import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CHECKS,
  INDEPENDENT,
  OUT_OF_CHECK_ALL,
  SEPARATE_WORKFLOW_STEPS,
  SHARED,
  assertRunnable,
  inventory,
  poolSize,
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
    { script: "a", group: SHARED, usesBuild: true, description: "" },
    {
      script: "b",
      group: SHARED,
      buildFrom: "a",
      usesBuild: true,
      description: "",
    },
    { script: "c", group: INDEPENDENT, description: "" },
  ];

  it("skips the check reading a build whose maker failed, and runs the rest", async () => {
    const ran = [];
    const lines = [];
    const results = await runAll(
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

  it("runs the dependent check when the build succeeded", async () => {
    const ran = [];
    await runAll(
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

  it("refuses a check reading the build of one that is not shared", () => {
    expect(() =>
      assertRunnable([
        { script: "a", group: INDEPENDENT, description: "" },
        { script: "b", group: SHARED, buildFrom: "a", description: "" },
      ]),
    ).toThrow("b reads the build of a");
  });
});

describe("the two groups", () => {
  it("puts every check in one of them, and every builder in the shared one", () => {
    for (const check of CHECKS) {
      expect([SHARED, INDEPENDENT], check.script).toContain(check.group);
    }
    expect(() => assertRunnable(CHECKS)).not.toThrow();
  });

  it("refuses a check with no group", () => {
    expect(() =>
      assertRunnable([{ script: "unsorted", description: "" }]),
    ).toThrow("unsorted has group undefined");
  });

  it("runs the checks that rewrite tracked files or build output alone", () => {
    const shared = CHECKS.filter((check) => check.group === SHARED).map(
      (check) => check.script,
    );
    expect(shared).toEqual(
      expect.arrayContaining([
        "check:routetree",
        "check:vectors",
        "check:deploy-trigger-graph",
      ]),
    );
  });

  it("never runs a shared check beside another, and ends the shared group before the pool starts", async () => {
    const running = new Set();
    const overlaps = [];
    const started = [];
    let widest = 0;
    await runAll(
      "/nonexistent-root",
      () => {},
      CHECKS,
      async (check) => {
        const sharedRunning = [...running].filter(
          (script) =>
            CHECKS.find((entry) => entry.script === script).group === SHARED,
        );
        if (check.group === SHARED ? running.size > 0 : sharedRunning.length) {
          overlaps.push(`${check.script} beside ${[...running].join(", ")}`);
        }
        started.push(check);
        running.add(check.script);
        widest = Math.max(widest, running.size);
        await new Promise((wake) => setTimeout(wake, 2));
        running.delete(check.script);
        return { script: check.script, ok: true, seconds: 0, output: "" };
      },
      4,
    );

    expect(overlaps).toEqual([]);
    const lastShared = started.findLastIndex((check) => check.group === SHARED);
    const firstIndependent = started.findIndex(
      (check) => check.group === INDEPENDENT,
    );
    expect(lastShared).toBeLessThan(firstIndependent);
    expect(widest).toBe(4);
  });

  it("runs check:routetree before the checks that load the web vitest config, which regenerate a stale route tree", async () => {
    const ran = [];
    await runAll(
      "/nonexistent-root",
      () => {},
      CHECKS,
      (check) => {
        ran.push(check.script);
        return { script: check.script, ok: true, seconds: 0 };
      },
    );
    for (const loader of ["check:config-integrity", "test:scripts"]) {
      expect(ran.indexOf("check:routetree"), loader).toBeLessThan(
        ran.indexOf(loader),
      );
    }
  });

  it("runs the shared group in list order", async () => {
    const ran = [];
    await runAll(
      "/nonexistent-root",
      () => {},
      CHECKS,
      (check) => {
        ran.push(check.script);
        return { script: check.script, ok: true, seconds: 0 };
      },
      1,
    );
    const shared = CHECKS.filter((check) => check.group === SHARED).map(
      (check) => check.script,
    );
    expect(ran.slice(0, shared.length)).toEqual(shared);
  });

  it("returns the results in list order whatever order they end in", async () => {
    const checks = ["slow", "fast"].map((script) => ({
      script,
      group: INDEPENDENT,
      description: "",
    }));
    const results = await runAll(
      "/nonexistent-root",
      () => {},
      checks,
      async (check) => {
        await new Promise((wake) =>
          setTimeout(wake, check.script === "slow" ? 30 : 0),
        );
        return { script: check.script, ok: true, seconds: 0 };
      },
      2,
    );
    expect(results.map((result) => result.script)).toEqual(["slow", "fast"]);
  });

  it("sizes the pool from the CPU count, capped", () => {
    expect(poolSize(1)).toBe(1);
    expect(poolSize(2)).toBe(2);
    expect(poolSize(64)).toBe(poolSize(1024));
    expect(poolSize(64)).toBeLessThan(64);
  });
});

describe("the pool's output", () => {
  // Each prints three lines to stdout and stderr in turn, 15 ms apart, so two
  // run side by side interleave their writes.
  const talker = (name) => ({
    script: name,
    group: INDEPENDENT,
    description: `${name} talks`,
    command: [
      process.execPath,
      "-e",
      `let n = 0; const tick = () => { const stream = n % 2 ? process.stderr : process.stdout; stream.write("${name} line " + n + "\\n"); if (++n < 3) setTimeout(tick, 15); }; tick();`,
    ],
  });

  it("prints each check's output whole, under its own header", async () => {
    const lines = [];
    const results = await runAll(
      ROOT,
      (line) => lines.push(...line.split("\n")),
      [talker("left"), talker("right")],
      runCheck,
      2,
    );

    expect(results.every((result) => result.ok)).toBe(true);
    for (const name of ["left", "right"]) {
      const header = lines.findIndex(
        (line) => line === `[${name === "left" ? 1 : 2}/2] ${name}`,
      );
      expect(header, lines.join("\n")).toBeGreaterThanOrEqual(0);
      expect(lines.slice(header + 1, header + 5)).toEqual([
        `  ${name} talks`,
        `${name} line 0`,
        `${name} line 1`,
        `${name} line 2`,
      ]);
    }
  });

  it("fails a check that exits non-zero and prints what it said", async () => {
    const lines = [];
    const [result] = await runAll(
      ROOT,
      (line) => lines.push(line),
      [
        {
          script: "loud-failure",
          group: INDEPENDENT,
          description: "",
          command: [
            process.execPath,
            "-e",
            'console.error("the reason"); process.exit(3)',
          ],
        },
      ],
      runCheck,
      2,
    );
    expect(result.ok).toBe(false);
    expect(lines.join("\n")).toContain("the reason");
  });

  it("fails a check whose command cannot start, with the reason", async () => {
    const result = await runCheck(
      {
        script: "absent",
        command: [resolve(ROOT, "no-such-command-anywhere")],
      },
      ROOT,
      { buffer: true },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("could not be started");
  });

  it("keeps the other checks' output when one crashes the runner", async () => {
    const lines = [];
    const checks = ["before", "crash", "after"].map((script) => ({
      script,
      group: INDEPENDENT,
      description: "",
    }));
    const results = await runAll(
      "/nonexistent-root",
      (line) => lines.push(line),
      checks,
      async (check) => {
        if (check.script === "crash") throw new Error("runner fault");
        return {
          script: check.script,
          ok: true,
          seconds: 0,
          output: `${check.script} said this`,
        };
      },
      3,
    );
    expect(results.map((result) => result.ok)).toEqual([true, false, true]);
    const printed = lines.join("\n");
    expect(printed).toContain("before said this");
    expect(printed).toContain("after said this");
    expect(printed).toContain("runner fault");
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

  it("states the run's wall-clock time when given it", () => {
    const summary = summarize(
      [{ script: "linkcheck", ok: true, seconds: 1.24, load: 0.5 }],
      8,
      12.5,
    );
    expect(summary).toContain("1 of 1 checks passed in 1.2s, on 8 CPUs;");
    expect(summary).toContain("The run took 12.5s;");
  });

  it("records the load average a real check started under", async () => {
    const result = await runCheck(
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
