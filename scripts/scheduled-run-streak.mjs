#!/usr/bin/env node
// Tallies how many scheduled runs in a row each scheduled workflow has ended
// red, from `gh run list`, against the docs/TESTING.md rule that a workflow red
// for more than BLOCKING_STREAK scheduled runs becomes a blocking item.
//
//   node scripts/scheduled-run-streak.mjs [<workflow file>...]
//
// With no argument it reads every workflow under .github/workflows that has a
// `schedule` trigger. Only runs the schedule started count: a manual dispatch
// on a branch says nothing about the branch the schedule watches. A run still
// in progress is left out; a `failure` or `timed_out` run is red, a `success`
// green, and any other ending, such as `cancelled` or `skipped`, neither
// breaks nor extends a streak. A workflow in TIERED_WORKFLOWS gets one streak
// per tier, since GitHub does not record which cron started a run. It reads
// the runs through `gh`, so it needs a token that can read this repository's
// Actions runs. It exits 0 once every workflow is reported, red or not, and 2
// when one could not be read; deciding what to file is the reader's.

import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readWorkflows, parseWorkflow } from "./lib/workflows.mjs";

/** Red scheduled runs in a row past which a workflow or tier is blocking. */
export const BLOCKING_STREAK = 3;

/** How many recent scheduled runs are read per workflow. */
const RUN_LIMIT = 40;

const RED_CONCLUSIONS = new Set(["failure", "timed_out"]);

/**
 * The red streak ending at the newest completed run of `runs` (`gh run list`
 * JSON, any order): how many red runs in a row since the newest success, the
 * run ids, and the start time of the oldest of them.
 */
export function redStreak(runs) {
  const decided = runs
    .filter(
      (run) =>
        run.status === "completed" &&
        (run.conclusion === "success" || RED_CONCLUSIONS.has(run.conclusion)),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const red = [];
  for (const run of decided) {
    if (run.conclusion === "success") break;
    red.push(run);
  }
  return {
    count: red.length,
    runIds: red.map((run) => run.databaseId),
    since: red.at(-1)?.createdAt ?? null,
    lastGreen: decided[red.length]?.createdAt ?? null,
  };
}

/**
 * Workflows whose crons start different jobs, by file name: `tierOf` names a
 * run's tier from its job names, or returns undefined for a run that ended
 * before starting a tier's jobs, which then counts toward no tier.
 */
export const TIERED_WORKFLOWS = {
  "nightly_core_stress.yaml": {
    tiers: ["nightly", "weekly"],
    tierOf: (jobNames) => {
      if (jobNames.includes("Core PSI stress (short files)")) return "nightly";
      if (jobNames.some((name) => name.startsWith("Core PSI stress (")))
        return "weekly";
      return undefined;
    },
  },
};

/**
 * One `{ name, streak }` per streak `workflow` has: one for the workflow, or
 * one per tier, named `<workflow> (<tier>)`, for a workflow in
 * {@link TIERED_WORKFLOWS}, whose runs then need `jobNames`.
 */
export function workflowStreaks(workflow, runs) {
  const tiered = TIERED_WORKFLOWS[workflow];
  if (tiered === undefined)
    return [{ name: workflow, streak: redStreak(runs) }];
  return tiered.tiers.map((tier) => ({
    name: `${workflow} (${tier})`,
    streak: redStreak(
      runs.filter((run) => tiered.tierOf(run.jobNames ?? []) === tier),
    ),
  }));
}

/** One report line for `name` and its {@link redStreak} result. */
export function formatStreak(name, streak) {
  if (streak.count === 0)
    return `${name}: green (last scheduled run succeeded${streak.lastGreen ? ` ${streak.lastGreen}` : ""})`;
  const verdict =
    streak.count > BLOCKING_STREAK
      ? `BLOCKING: red for more than ${BLOCKING_STREAK} scheduled runs`
      : "red";
  return (
    `${name}: ${verdict}, ${streak.count} scheduled run${streak.count === 1 ? "" : "s"} ` +
    `since ${streak.since}` +
    `${streak.lastGreen ? `, last green ${streak.lastGreen}` : ", no green run in the window read"}` +
    ` (runs ${streak.runIds.join(", ")})`
  );
}

/** The workflow files under `root` whose `on:` includes a schedule. */
export function scheduledWorkflows(root) {
  return readWorkflows(root)
    .filter(({ path, source }) => {
      const on = parseWorkflow(path, source)?.on;
      return on !== null && typeof on === "object" && "schedule" in on;
    })
    .map(({ path }) => basename(path));
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`,
    );
  return JSON.parse(result.stdout);
}

function scheduledRuns(workflow) {
  const runs = gh([
    "run",
    "list",
    "--workflow",
    workflow,
    "--event",
    "schedule",
    "--limit",
    String(RUN_LIMIT),
    "--json",
    "databaseId,status,conclusion,createdAt",
  ]);
  if (TIERED_WORKFLOWS[workflow] === undefined) return runs;
  return runs
    .filter((run) => run.status === "completed")
    .map((run) => ({
      ...run,
      jobNames: gh([
        "run",
        "view",
        String(run.databaseId),
        "--json",
        "jobs",
      ]).jobs.map((job) => job.name),
    }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const named = process.argv.slice(2);
  const workflows = named.length > 0 ? named : scheduledWorkflows(root);
  for (const workflow of workflows) {
    try {
      for (const { name, streak } of workflowStreaks(
        workflow,
        scheduledRuns(workflow),
      ))
        console.log(formatStreak(name, streak));
    } catch (err) {
      console.log(
        `${workflow}: could not be read: ${err instanceof Error ? err.message : err}`,
      );
      process.exitCode = 2;
    }
  }
}
