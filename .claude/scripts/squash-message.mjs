#!/usr/bin/env node
// Squash-message drafter: `node .claude/scripts/squash-message.mjs <pr-number>`.
// Drafts the body of a pull request's squash-and-merge commit message with
// one `claude -p` run pinned to sonnet, over the branch's commits, the PR body
// and CONTRIBUTING.md, and prints it to stdout through format-squash-message.mjs.
// The maintainer's side of the remind-squash-message.mjs hook.
//
// Refuses a pull request holding one commit, counted by `gh pr view --json
// commits`; a `gh` that cannot answer is reported on stderr and the draft runs
// anyway. The run gets only ALLOWED_TOOLS, all read-only, and DISALLOWED_TOOLS
// denies merging, editing and pushing; nothing here merges, edits or pushes.
// The prompt goes in on stdin and each tool list is one comma-joined token,
// since the CLI's tool-list flags are variadic and would swallow a trailing
// prompt argument.
//
// Exit 0 printed. Exit 2 on a usage error, a one-commit pull request, or a
// draft the normalizer refuses, which is printed as drafted with the reasons on
// stderr; 1 or claude's own status when the run fails. Rationale:
// docs/notes/agent-hooks-and-scripts.md.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatDraft,
  refusalReport,
  selfCheckReport,
  violations,
} from "./format-squash-message.mjs";

/** Repository root: this script lives at .claude/scripts/ inside it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The tools the run needs, all of them read-only. */
export const ALLOWED_TOOLS = [
  "Read",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
];

/**
 * The spellings that would make this script do something rather than say
 * something. Redundant with the allowlist above and kept anyway: the allowlist
 * is what a later edit widens, and this list is what such an edit has to delete
 * on purpose.
 */
export const DISALLOWED_TOOLS = [
  "Bash(gh pr merge:*)",
  "Bash(gh pr edit:*)",
  "Bash(gh pr close:*)",
  "Bash(git push:*)",
  "Edit",
  "Write",
];

/** The maintainer's prompt, verbatim, for one pull request. */
export function prompt(prNumber) {
  return (
    "Please use the commit history, the PR body, and @CONTRIBUTING.md to " +
    "write the body of a short squash-and-merge commit message for " +
    `PR #${prNumber}. Leave out the subject line: GitHub takes it from the ` +
    "PR title."
  );
}

/**
 * The pull-request number in `argv`, or null when there is not exactly one
 * readable positive integer. `#928` is accepted because that is how a PR is
 * written everywhere else; anything else is a usage error rather than a value
 * interpolated into the prompt.
 */
export function parsePrNumber(argv) {
  if (argv.length !== 1) return null;
  const match = /^#?(\d+)$/.exec(argv[0].trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** The `gh` argument vector that reports how many commits a pull request holds. */
export function commitCountArgs(prNumber) {
  return [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "commits",
    "--jq",
    ".commits | length",
  ];
}

/**
 * The count in `gh`'s stdout, or null when it is not a plain non-negative
 * integer. Anything else -- an error message, empty output, a JSON blob from a
 * `gh` whose flags moved -- is an unknown count rather than a number coerced
 * out of it.
 */
export function parseCommitCount(stdout) {
  const text = String(stdout ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * The reason to refuse `prNumber`, or null when there is a message worth
 * drafting. A null `commitCount` is an unknown count, which does not refuse.
 */
export function refusal(prNumber, commitCount) {
  if (commitCount !== 1) return null;
  return (
    `PR #${prNumber} carries one commit, so GitHub squash-merges it with that ` +
    "commit's own message and a drafted one would be discarded. Amend the " +
    "commit instead.\n"
  );
}

/** The `claude` argument vector. The prompt is not in it; it goes on stdin. */
export function claudeArgs() {
  return [
    "-p",
    "--model",
    "sonnet",
    "--allowedTools",
    ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    DISALLOWED_TOOLS.join(","),
  ];
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without spawning anything.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prNumber = parsePrNumber(process.argv.slice(2));
  if (prNumber === null) {
    process.stderr.write("Usage: node squash-message.mjs <pr-number>\n");
    process.exit(2);
  }
  const counted = spawnSync("gh", commitCountArgs(prNumber), {
    cwd: ROOT,
    encoding: "utf8",
  });
  const commitCount =
    !counted.error && counted.status === 0
      ? parseCommitCount(counted.stdout)
      : null;
  if (commitCount === null) {
    process.stderr.write(
      "could not read the pull request's commit count from gh; drafting without the single-commit check\n",
    );
  }
  const refused = refusal(prNumber, commitCount);
  if (refused !== null) {
    process.stderr.write(refused);
    process.exit(2);
  }
  const run = spawnSync("claude", claudeArgs(), {
    cwd: ROOT,
    input: prompt(prNumber),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (run.error) {
    process.stderr.write(`could not run claude: ${run.error.message}\n`);
    process.exit(1);
  }
  const drafted = run.stdout ?? "";
  if (run.status !== 0) {
    process.stdout.write(drafted);
    process.exit(run.status ?? 1);
  }
  const { text, refusals } = formatDraft(drafted);
  if (refusals.length > 0) {
    process.stdout.write(drafted);
    process.stderr.write(refusalReport(refusals));
    process.exit(2);
  }
  const remaining = violations(text);
  if (remaining.length > 0) {
    process.stdout.write(drafted);
    process.stderr.write(selfCheckReport(remaining));
    process.exit(2);
  }
  process.stdout.write(text);
  process.exit(0);
}
