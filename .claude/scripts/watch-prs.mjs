#!/usr/bin/env node
// Watch pull requests for the events a session acts on -- CI finishing on the
// head, a merge conflict, a merge, a close -- and exit at the first poll that
// finds one not already reported, so the session is notified instead of
// polling. It runs in the background under `timeout`, the bound
// block-sleep-poll.mjs requires, and has no timeout of its own; the line to run
// is in USAGE.
//
// Each poll reads every PR through `gh pr view --json`. A PR whose read fails
// is skipped for that poll with a note on stderr, and the watch goes on.
//
// Reported events are recorded in the state file, one key per line:
// `<owner/repo>#<n> <event> <sha>`, the sha the head's (or, for `merged`, the
// merge commit's), so a re-armed watch does not report them again and a new
// head reports its own CI result. A ci key adds a hash of the head's completed
// check runs with their completion times, so a rerun on the same head is
// reported. A conflict is suppressed while any conflict key for its PR is
// recorded; seeing the PR mergeable deletes those keys. Concurrent watches
// merge their writes: a poll re-reads the file and applies only its own
// additions and deletions, but a write racing another can still lose one.
//
// Exit 0 an event was printed; 2 a usage error or an unusable state file.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Seconds between two polls when --interval is not given. */
export const DEFAULT_INTERVAL_SECONDS = 120;

/** The fields each poll reads from `gh pr view --json`. */
export const VIEW_FIELDS =
  "state,mergeable,headRefOid,mergeCommit,statusCheckRollup,url";

/** Check conclusions that do not count as a failure. */
export const PASSING_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

const USAGE_EXIT = 2;
const MAX_INTERVAL_SECONDS = 3600;
const GH_TIMEOUT_MS = 60_000;
const FINGERPRINT_LENGTH = 12;
const PENDING_STATUS_STATES = new Set(["PENDING", "EXPECTED"]);
const PR_ARGUMENT = /^(?:([\w.-]+\/[\w.-]+)#)?([1-9]\d*)$/;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/;

/** The usage text; its indented command line is the form the session runs. */
export const USAGE = `Usage: node .claude/scripts/watch-prs.mjs <pr> [<pr> ...] [--interval <seconds>] [--state <file>]

Polls the pull requests and exits 0 at the first poll that finds an event not
already reported, printing one line per new event:

  ci-green <pr> <head sha>                     every check on the head completed, none failed
  ci-red <pr> <head sha> <failed check names>  every check on the head completed, some failed
  conflict <pr>                                the PR cannot merge because of a conflict
  merged <pr> <merge commit sha>
  closed <pr>

Start it as a background command under timeout, so its exit notifies the
session, and start it again after every exit:

  timeout 14400 node .claude/scripts/watch-prs.mjs 2835 some-org/some-fork#7

  <pr>                 N for a PR in this repository, or owner/repo#N
  --interval SECONDS   time between polls (default: ${DEFAULT_INTERVAL_SECONDS})
  --state FILE         the reported-events file (default: scratch/watch-prs.reported
                       in the primary checkout)
  -h, --help           print this help

It has no timeout of its own: exit 124 is timeout's, and means no event
happened; start it again. Exit 2: a usage error or an unusable state file.
`;

/**
 * Read the command line: the PRs, the interval and the state file, or `help`,
 * or an `error` to print beside the usage.
 */
export function parseArgs(argv) {
  const prs = [];
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let statePath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") return { help: true };
    if (argument === "--interval") {
      const value = Number(argv[index + 1]);
      if (
        !Number.isFinite(value) ||
        value <= 0 ||
        value > MAX_INTERVAL_SECONDS
      ) {
        return {
          error: `--interval takes a number of seconds above 0 and at most ${MAX_INTERVAL_SECONDS}; got '${argv[index + 1] ?? ""}'.`,
        };
      }
      intervalSeconds = value;
      index += 1;
      continue;
    }
    if (argument === "--state") {
      const value = argv[index + 1];
      if (value === undefined || value === "") {
        return { error: "--state takes a file path." };
      }
      statePath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      return { error: `unknown option '${argument}'.` };
    }
    const match = PR_ARGUMENT.exec(argument);
    if (match === null) {
      return {
        error: `'${argument}' is not a pull request: pass N or owner/repo#N.`,
      };
    }
    if (!prs.some((pr) => pr.label === argument)) {
      prs.push({ label: argument, repo: match[1], number: Number(match[2]) });
    }
  }
  if (prs.length === 0) return { error: "name one or more pull requests." };
  return { prs, intervalSeconds, statePath };
}

function displayName(check) {
  const name = check.name ?? check.context ?? "unnamed check";
  return String(name).replace(/[^\x20-\x7e]/g, "?");
}

/**
 * The CI result on the head the rollup describes: `pending` while a check has
 * not completed or none is registered, else `green` or `red` with the failed
 * check names, sorted, and a fingerprint of the runs. Only each check name's
 * latest run counts, as GitHub matches a required check by name.
 */
export function ciResult(rollup) {
  const checks = rollup ?? [];
  if (checks.length === 0) return { result: "pending" };
  const latest = new Map();
  for (const check of checks) {
    let conclusion;
    if (check.__typename === "StatusContext" || check.status === undefined) {
      if (PENDING_STATUS_STATES.has(check.state)) return { result: "pending" };
      conclusion = check.state;
    } else {
      if (check.status !== "COMPLETED") return { result: "pending" };
      conclusion = check.conclusion;
    }
    const name = displayName(check);
    const finished = check.completedAt ?? check.startedAt ?? "";
    const previous = latest.get(name);
    if (previous === undefined || finished >= previous.finished) {
      latest.set(name, { conclusion, finished });
    }
  }
  const failed = new Set();
  const runs = [];
  for (const [name, { conclusion, finished }] of latest) {
    if (!PASSING_CONCLUSIONS.has(conclusion)) failed.add(name);
    runs.push(`${name}\t${conclusion}\t${finished}`);
  }
  const fingerprint = createHash("sha256")
    .update(runs.sort().join("\n"))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
  if (failed.size === 0) return { result: "green", fingerprint };
  return { result: "red", failed: [...failed].sort(), fingerprint };
}

function repoOf(pr, view) {
  return PR_URL.exec(view.url ?? "")?.[1] ?? pr.repo ?? "";
}

/**
 * What one PR's `gh pr view` shows: its candidate events, each with the line
 * to print and its state-file key, and whether it was seen mergeable.
 */
export function prEvents(pr, view) {
  const prKey = `${repoOf(pr, view)}#${pr.number}`;
  const head = view.headRefOid;
  if (view.state === "MERGED") {
    const merge = view.mergeCommit?.oid ?? "";
    return {
      prKey,
      mergeable: false,
      events: [
        {
          line: `merged ${pr.label} ${merge}`,
          key: `${prKey} merged ${merge}`,
        },
      ],
    };
  }
  if (view.state === "CLOSED") {
    return {
      prKey,
      mergeable: false,
      events: [{ line: `closed ${pr.label}`, key: `${prKey} closed ${head}` }],
    };
  }
  const events = [];
  if (view.mergeable === "CONFLICTING") {
    events.push({
      line: `conflict ${pr.label}`,
      key: `${prKey} conflict ${head}`,
      conflict: true,
    });
  }
  const ci = ciResult(view.statusCheckRollup);
  if (ci.result === "green") {
    events.push({
      line: `ci-green ${pr.label} ${head}`,
      key: `${prKey} ci-green ${head} ${ci.fingerprint}`,
    });
  } else if (ci.result === "red") {
    events.push({
      line: `ci-red ${pr.label} ${head} ${ci.failed.join(", ")}`,
      key: `${prKey} ci-red ${head} ${ci.fingerprint}`,
    });
  }
  return { prKey, mergeable: view.mergeable === "MERGEABLE", events };
}

/** The recorded keys in the state file; an absent file records none. */
export function readState(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line !== "");
}

function writeState(path, keys) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, keys.length === 0 ? "" : `${keys.join("\n")}\n`);
  renameSync(temporary, path);
}

/**
 * Read one PR through `gh pr view`; `repo` is undefined for this repository.
 * Throws when gh fails or prints something that is not JSON.
 */
export function ghView({ repo, number }) {
  const args = ["pr", "view", String(number), "--json", VIEW_FIELDS];
  if (repo !== undefined) args.push("--repo", repo);
  let output;
  try {
    output = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GH_TIMEOUT_MS,
    });
  } catch (error) {
    const detail = String(error.stderr ?? "")
      .trim()
      .split("\n")[0];
    throw new Error(detail || error.message);
  }
  return JSON.parse(output);
}

/**
 * One poll over every PR: the new events' lines, after recording their keys
 * and deleting the conflict keys of a PR seen mergeable.
 */
export function poll({ prs, statePath, view = ghView, warn }) {
  let keys = readState(statePath);
  const added = new Set();
  const removed = new Set();
  const remove = (predicate) => {
    for (const key of keys.filter(predicate)) removed.add(key);
    keys = keys.filter((key) => !predicate(key));
  };
  const lines = [];
  for (const pr of prs) {
    let shown;
    try {
      shown = prEvents(pr, view(pr));
    } catch (error) {
      const reason = String(error?.message ?? error).split("\n")[0];
      warn(
        `watch-prs: could not read ${pr.label} (${reason}); trying again next poll.\n`,
      );
      continue;
    }
    const conflictPrefix = `${shown.prKey} conflict `;
    if (shown.mergeable) remove((key) => key.startsWith(conflictPrefix));
    for (const event of shown.events) {
      const reported = event.conflict
        ? keys.some((key) => key.startsWith(conflictPrefix))
        : keys.includes(event.key);
      if (reported) continue;
      keys = [...keys, event.key];
      added.add(event.key);
      lines.push(event.line);
    }
  }
  if (added.size > 0 || removed.size > 0) {
    const current = readState(statePath).filter((key) => !removed.has(key));
    writeState(statePath, [
      ...current,
      ...[...added].filter((key) => !current.includes(key)),
    ]);
  }
  return lines;
}

/**
 * Poll until a poll finds a new event, and return its lines. `polls` bounds
 * the number of polls for a test; past it the watch returns null.
 */
export async function watch({
  prs,
  statePath,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  view = ghView,
  warn = (text) => process.stderr.write(text),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  polls = Infinity,
}) {
  for (let count = 0; count < polls; count += 1) {
    if (count > 0) await sleep(intervalSeconds * 1000);
    const lines = poll({ prs, statePath, view, warn });
    if (lines.length > 0) return lines;
  }
  return null;
}

/** The default state file: scratch/watch-prs.reported in the primary checkout. */
export function defaultStatePath() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const commonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: scriptDirectory, encoding: "utf8" },
  ).trim();
  return join(dirname(commonDirectory), "scratch", "watch-prs.reported");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = USAGE_EXIT;
    return;
  }
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.error !== undefined) {
    process.stderr.write(`watch-prs: ${parsed.error}\n\n${USAGE}`);
    process.exitCode = USAGE_EXIT;
    return;
  }
  const statePath = parsed.statePath ?? defaultStatePath();
  try {
    readState(statePath);
  } catch (error) {
    process.stderr.write(
      `watch-prs: cannot read the state file ${statePath}: ${error.message}. Pass a readable file with --state.\n`,
    );
    process.exitCode = USAGE_EXIT;
    return;
  }
  let lines;
  try {
    lines = await watch({
      prs: parsed.prs,
      statePath,
      intervalSeconds: parsed.intervalSeconds,
    });
  } catch (error) {
    process.stderr.write(
      `watch-prs: cannot use the state file ${statePath}: ${error.message}. Pass a writable file with --state.\n`,
    );
    process.exitCode = USAGE_EXIT;
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
