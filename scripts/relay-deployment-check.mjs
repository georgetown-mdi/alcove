#!/usr/bin/env node
// Checks the relay host's deployment against main, from what the broker's
// readiness endpoint publishes (infra/broker/README.md, The deployment check).
//
//   node scripts/relay-deployment-check.mjs
//
// Run by nightly_relay_deployment.yaml from a checkout holding main's full
// history as origin/main. It reads the broker's address from
// VITE_SIGNALING_SERVER_URL, the web build's `wss:` URL of the same broker,
// and main's updates from GitHub's repository activity API through `gh`, so
// it needs GH_TOKEN. It prints one line per finding and exits 1 when there is
// any: a field missing or unknown, a last pull run that did not succeed, a
// deployed commit that is not on main, or main holding commits the host lacks
// for longer than MAX_LAG_HOURS.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How long main may hold commits the host has not deployed. A working value,
 * not a measured one: the pull runs daily and skips a commit whose CI has not
 * finished, so this admits one skipped day. */
export const MAX_LAG_HOURS = 48;

/** The headers the broker publishes (packages/peerjs-broker/src/deploymentStatus.ts). */
export const DEPLOYED_COMMIT_HEADER = "alcove-deployed-commit";
export const LAST_PULL_OUTCOME_HEADER = "alcove-last-pull-outcome";
export const LAST_PULL_TIME_HEADER = "alcove-last-pull-time";

/** The value the broker publishes for a field it could not read. */
export const UNKNOWN = "unknown";

/** Outcomes of a pull run that did its job (infra/host-pull/README.md, Outcomes). */
export const SUCCEEDED_OUTCOMES = ["unchanged", "skipped", "updated"];

/** Outcomes of a pull run that did not. */
export const FAILED_OUTCOMES = [
  "refused",
  "failed",
  "rolled-back",
  "rollback-failed",
];

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const HEALTH_TIMEOUT_MS = 30_000;
const ACTIVITY_PAGE_SIZE = 100;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * The readiness endpoint of the broker a `wss:` signaling URL names: the same
 * host and port over `https:`, at `health` under the URL's path.
 * @throws Error when the URL is unset, unparseable or not `wss:`.
 */
export function relayHealthUrl(signalingUrl) {
  if (signalingUrl === undefined || signalingUrl.trim() === "")
    throw new Error(
      "VITE_SIGNALING_SERVER_URL is not set; set the repository variable to the broker's wss: URL",
    );
  let url;
  try {
    url = new URL(signalingUrl.trim());
  } catch {
    throw new Error(
      `VITE_SIGNALING_SERVER_URL is not a URL: ${JSON.stringify(signalingUrl)}`,
    );
  }
  if (url.protocol !== "wss:")
    throw new Error(
      `VITE_SIGNALING_SERVER_URL must be a wss: URL; got ${JSON.stringify(signalingUrl)}`,
    );
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `https://${url.host}${path}health`;
}

/** The three published fields from a response's headers; null for one the
 * response does not have. */
export function deploymentFields(headers) {
  return {
    deployedCommit: headers.get(DEPLOYED_COMMIT_HEADER),
    lastPullOutcome: headers.get(LAST_PULL_OUTCOME_HEADER),
    lastPullTime: headers.get(LAST_PULL_TIME_HEADER),
  };
}

/**
 * Findings about the fields alone, each `{ kind, message }`: `missing` when the
 * broker publishes no such header, `unknown` when it could not read the field
 * or published a value out of shape, and `failed-pull` when the last run did
 * not succeed.
 */
export function fieldFindings(fields) {
  const findings = [];
  const names = {
    deployedCommit: DEPLOYED_COMMIT_HEADER,
    lastPullOutcome: LAST_PULL_OUTCOME_HEADER,
    lastPullTime: LAST_PULL_TIME_HEADER,
  };
  for (const [field, header] of Object.entries(names)) {
    const value = fields[field];
    if (value === null)
      findings.push({
        kind: "missing",
        message: `the host's broker publishes no ${header} header`,
      });
    else if (value === UNKNOWN)
      findings.push({
        kind: "unknown",
        message: `the host's broker reports ${header} as unknown`,
      });
  }
  const commit = fields.deployedCommit;
  if (commit !== null && commit !== UNKNOWN && !COMMIT_PATTERN.test(commit))
    findings.push({
      kind: "unknown",
      message: `${DEPLOYED_COMMIT_HEADER} is not a full commit: ${JSON.stringify(commit)}`,
    });
  const outcome = fields.lastPullOutcome;
  if (outcome !== null && outcome !== UNKNOWN) {
    if (FAILED_OUTCOMES.includes(outcome))
      findings.push({
        kind: "failed-pull",
        message: `the host's last pull run, at ${fields.lastPullTime ?? UNKNOWN}, ended ${outcome}`,
      });
    else if (!SUCCEEDED_OUTCOMES.includes(outcome))
      findings.push({
        kind: "unknown",
        message: `${LAST_PULL_OUTCOME_HEADER} is not an outcome the pull records: ${JSON.stringify(outcome)}`,
      });
  }
  return findings;
}

/**
 * When main first held a commit the deployed commit does not contain: the
 * timestamp of the oldest update of main whose new tip `contains(after)`
 * reports false for. `activities` is the repository activity API's answer for
 * main, in any order. Null when every update is contained.
 */
export function laggingSince(activities, contains) {
  const ordered = [...activities].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  for (const activity of ordered) {
    if (!contains(activity.after)) return activity.timestamp;
  }
  return null;
}

/** A `lag` finding when main has held undeployed commits since `since` for
 * longer than `maxLagHours` at `now`, or null. */
export function lagFinding(since, now, maxLagHours = MAX_LAG_HOURS) {
  if (since === null) return null;
  const hours = (now.getTime() - Date.parse(since)) / 3_600_000;
  if (hours <= maxLagHours) return null;
  return {
    kind: "lag",
    message: `main has held commits the host has not deployed since ${since}, ${Math.floor(hours)} hours, past the ${maxLagHours}-hour limit`,
  };
}

function git(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

/** Whether `ancestor` is `descendant` or one of its ancestors. */
function isAncestor(ancestor, descendant) {
  const result = git(["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git merge-base could not compare ${ancestor} with ${descendant}: ${result.stderr.trim()}`,
  );
}

function readMainActivities() {
  const repository = process.env.GITHUB_REPOSITORY || "georgetown-mdi/alcove";
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${repository}/activity?ref=refs/heads/main&per_page=${ACTIVITY_PAGE_SIZE}`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(
      `could not read main's updates from GitHub: ${(result.stderr || result.error?.message || "").trim()}`,
    );
  return JSON.parse(result.stdout);
}

/** Findings about where the deployed commit stands on main, read from this
 * checkout's origin/main and GitHub's record of main's updates. */
export function historyFindings(deployedCommit, now) {
  const tip = git(["rev-parse", "--verify", "origin/main^{commit}"]);
  if (tip.status !== 0)
    throw new Error(
      "origin/main is not in this checkout; fetch main's history",
    );
  if (tip.stdout.trim() === deployedCommit) return [];
  if (git(["cat-file", "-e", `${deployedCommit}^{commit}`]).status !== 0)
    return [
      {
        kind: "not-on-main",
        message: `the deployed commit ${deployedCommit} is not in this repository's history`,
      },
    ];
  if (!isAncestor(deployedCommit, "origin/main"))
    return [
      {
        kind: "not-on-main",
        message: `the deployed commit ${deployedCommit} is not on main`,
      },
    ];
  // An update whose tip is not on main's current history, such as one a force
  // push replaced, says nothing about when main moved past the deployed commit.
  const updates = readMainActivities().filter(
    (activity) =>
      COMMIT_PATTERN.test(activity.after) &&
      git(["cat-file", "-e", `${activity.after}^{commit}`]).status === 0 &&
      isAncestor(activity.after, "origin/main"),
  );
  const since = laggingSince(updates, (after) =>
    isAncestor(after, deployedCommit),
  );
  if (since === null)
    return [
      {
        kind: "unread",
        message: `main is past ${deployedCommit}, but GitHub's record of main's updates does not say since when`,
      },
    ];
  const lag = lagFinding(since, now);
  return lag === null ? [] : [lag];
}

async function main() {
  const healthUrl = relayHealthUrl(process.env.VITE_SIGNALING_SERVER_URL);
  const response = await fetch(healthUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status !== 200)
    throw new Error(`${healthUrl} answered HTTP ${response.status}`);
  const fields = deploymentFields(response.headers);
  const findings = fieldFindings(fields);
  if (
    fields.deployedCommit !== null &&
    COMMIT_PATTERN.test(fields.deployedCommit)
  )
    findings.push(...historyFindings(fields.deployedCommit, new Date()));

  const lines = [
    `${healthUrl}`,
    `deployed commit: ${fields.deployedCommit ?? "(no header)"}`,
    `last pull run: ${fields.lastPullOutcome ?? "(no header)"} at ${fields.lastPullTime ?? "(no header)"}`,
    ...findings.map((finding) => `red (${finding.kind}): ${finding.message}`),
  ];
  if (findings.length === 0) lines.push("green: the host is current with main");
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${lines.map((line) => `- ${line}`).join("\n")}\n`,
    );
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`red (unread): ${error.message}`);
      process.exit(1);
    },
  );
}
