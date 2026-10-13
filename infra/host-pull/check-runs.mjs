#!/usr/bin/env node
// Reads one page of GitHub's check runs for a commit
// (`GET /repos/<owner>/<repo>/commits/<sha>/check-runs?per_page=100`) and prints
// one line for pull.sh:
//
//   green <count>        every run completed as success, neutral or skipped
//   pending <names>      at least one run has not completed, and none failed
//   red <names>          at least one run completed with any other conclusion
//   none                 the commit has no check runs
//   unread <reason>      the body is not a check-runs answer this can decide on
//
//   node check-runs.mjs <response-file>
//
// The legacy combined status (`/commits/<sha>/status`) is not read: this
// repository reports through check runs, and that endpoint answers "pending"
// with no statuses for a commit whose every check run passed. Exit 0 whenever a
// line was printed.

import { readFileSync } from "node:fs";

const PASSING = new Set(["success", "neutral", "skipped"]);
const NAMES_SHOWN = 5;

const printable = (name) =>
  String(name)
    .replace(/[^A-Za-z0-9 ._:/()-]/g, "?")
    .slice(0, 80);

const listed = (runs) => {
  const names = runs.slice(0, NAMES_SHOWN).map((run) => printable(run.name));
  const more = runs.length - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
};

function verdict(body) {
  let answer;
  try {
    answer = JSON.parse(body);
  } catch {
    return "unread the response is not JSON";
  }
  const runs = answer?.check_runs;
  const total = answer?.total_count;
  if (!Array.isArray(runs) || !Number.isInteger(total)) {
    return "unread the response has no check_runs list and total_count";
  }
  if (total !== runs.length) {
    return `unread the commit has ${total} check runs and one page holds ${runs.length}`;
  }
  if (runs.length === 0) return "none";
  const unfinished = runs.filter((run) => run?.status !== "completed");
  const failed = runs.filter(
    (run) => run?.status === "completed" && !PASSING.has(run?.conclusion),
  );
  if (failed.length > 0) return `red ${listed(failed)}`;
  if (unfinished.length > 0) return `pending ${listed(unfinished)}`;
  return `green ${runs.length}`;
}

if (process.argv.length !== 3) {
  process.stderr.write("usage: check-runs.mjs <response-file>\n");
  process.exit(2);
}
process.stdout.write(`${verdict(readFileSync(process.argv[2], "utf8"))}\n`);
