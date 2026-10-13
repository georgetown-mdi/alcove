#!/usr/bin/env node
// Reads the pages of GitHub's push-triggered workflow runs for a commit
// (`GET /repos/<owner>/<repo>/actions/runs?head_sha=<sha>&event=push&per_page=100&page=<n>`)
// and prints one line for pull.sh:
//
//   green <count>        every run completed with conclusion success
//   pending <names>      at least one run has not completed, and none failed
//   red <names>          at least one run completed with any other conclusion
//   none                 the commit has no push-triggered run
//   more                 the pages hold fewer runs than total_count; read the next
//   unread <reason>      the pages are not an answer this can decide on
//
//   node workflow-runs.mjs <sha> <page-file>...
//
// Runs of other events (schedule, dynamic, pull_request) do not gate, and a
// listed run of another event or commit is refused rather than skipped. Exit 0
// whenever a line was printed.

import { readFileSync } from "node:fs";

const NAMES_SHOWN = 5;

const printable = (text) =>
  String(text)
    .replace(/[^A-Za-z0-9 ._:/()-]/g, "?")
    .slice(0, 80);

const label = (run) => `${printable(run.name)} (${printable(run.head_branch)})`;

const listed = (runs) => {
  const names = runs.slice(0, NAMES_SHOWN).map(label);
  const more = runs.length - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
};

function verdict(sha, bodies) {
  const runs = new Map();
  let total = 0;
  let lastPageLength = 0;
  for (const body of bodies) {
    let answer;
    try {
      answer = JSON.parse(body);
    } catch {
      return "unread the response is not JSON";
    }
    const page = answer?.workflow_runs;
    if (!Array.isArray(page) || !Number.isInteger(answer?.total_count)) {
      return "unread the response has no workflow_runs list and total_count";
    }
    for (const run of page) {
      if (!Number.isInteger(run?.id)) return "unread a listed run has no id";
      if (run.event !== "push" || run.head_sha !== sha) {
        return `unread the answer lists a run that is not a push run of ${sha}`;
      }
      runs.set(run.id, run);
    }
    total = Math.max(total, answer.total_count);
    lastPageLength = page.length;
  }
  if (runs.size < total) {
    return lastPageLength > 0
      ? "more"
      : `unread the commit has ${total} push runs and the pages hold ${runs.size}`;
  }
  if (runs.size === 0) return "none";
  const all = [...runs.values()];
  const unfinished = all.filter((run) => run.status !== "completed");
  const failed = all.filter(
    (run) => run.status === "completed" && run.conclusion !== "success",
  );
  if (failed.length > 0) return `red ${listed(failed)}`;
  if (unfinished.length > 0) return `pending ${listed(unfinished)}`;
  return `green ${all.length}`;
}

const [sha, ...files] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(sha ?? "") || files.length === 0) {
  process.stderr.write("usage: workflow-runs.mjs <sha> <page-file>...\n");
  process.exit(2);
}
process.stdout.write(
  `${verdict(
    sha,
    files.map((file) => readFileSync(file, "utf8")),
  )}\n`,
);
