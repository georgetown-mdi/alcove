#!/usr/bin/env node
// Tallies how many scheduled runs in a row each scheduled workflow has ended
// red, from `gh run list`, against the docs/TESTING.md rule that a scheduled
// run red for more than three nights becomes a blocking item.
//
//   node scripts/scheduled-run-streak.mjs [<workflow file>...]
//
// With no argument it reads every workflow under .github/workflows that has a
// `schedule` trigger. Only runs the schedule started count: a manual dispatch
// on a branch says nothing about the branch the schedule watches. A run still
// in progress is left out, and any ending other than success -- failure,
// cancelled, timed out -- counts as red. It reads the runs through `gh`, so it
// needs a token that can read this repository's Actions runs. It exits 0 once
// every workflow is reported, red or not, and 2 when one could not be read;
// deciding what to file is the reader's.

import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readWorkflows, parseWorkflow } from "./lib/workflows.mjs";

/** Red runs in a row past which a scheduled workflow is a blocking item. */
export const BLOCKING_STREAK = 3;

/** How many recent scheduled runs are read per workflow. */
const RUN_LIMIT = 40;

/**
 * The red streak ending at the newest completed run of `runs` (`gh run list`
 * JSON, any order): how many completed runs in a row did not succeed, the run
 * ids, and the start time of the oldest of them.
 */
export function redStreak(runs) {
  const completed = runs
    .filter((run) => run.status === "completed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const red = [];
  for (const run of completed) {
    if (run.conclusion === "success") break;
    red.push(run);
  }
  return {
    count: red.length,
    runIds: red.map((run) => run.databaseId),
    since: red.at(-1)?.createdAt ?? null,
    lastGreen: completed[red.length]?.createdAt ?? null,
  };
}

/** One report line for `workflow` and its {@link redStreak} result. */
export function formatStreak(workflow, streak) {
  if (streak.count === 0)
    return `${workflow}: green (last run succeeded${streak.lastGreen ? ` ${streak.lastGreen}` : ""})`;
  const verdict =
    streak.count > BLOCKING_STREAK
      ? `BLOCKING: red for more than ${BLOCKING_STREAK} runs`
      : "red";
  return (
    `${workflow}: ${verdict}, ${streak.count} run${streak.count === 1 ? "" : "s"} ` +
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

function scheduledRuns(workflow) {
  const result = spawnSync(
    "gh",
    [
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
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `gh run list --workflow ${workflow} failed: ${result.stderr.trim()}`,
    );
  return JSON.parse(result.stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const named = process.argv.slice(2);
  const workflows = named.length > 0 ? named : scheduledWorkflows(root);
  for (const workflow of workflows) {
    try {
      console.log(formatStreak(workflow, redStreak(scheduledRuns(workflow))));
    } catch (err) {
      console.log(
        `${workflow}: could not be read: ${err instanceof Error ? err.message : err}`,
      );
      process.exitCode = 2;
    }
  }
}
