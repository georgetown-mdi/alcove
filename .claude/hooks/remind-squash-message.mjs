#!/usr/bin/env node
// PostToolUse hook on Bash: after a `gh pr create` or a `gh pr ready` call
// whose branch has more than one commit over its base, tell the session to post
// a ready-to-paste squash-and-merge commit body as a fenced comment on the pull
// request. Pull requests merge by squash, and GitHub's default message for a
// multi-commit branch is a list of subjects; a one-commit branch gets no
// reminder. Only the body is asked for, since GitHub fills the subject from the
// PR title; its format comes from ../scripts/format-squash-message.mjs.
//
// `gh pr ready <number-or-url>` covers a draft opened at one commit and grown
// before it is marked ready: the pull request's head and base come from
// `gh pr view`, and the head's commits are counted over `origin/<base>`. With no
// pull request number in the command (`gh pr ready` alone, or a branch name),
// `--undo`, or any failure of `gh` or git, it emits nothing.
//
// The count is taken over the branch `--head` names (the text after a colon for
// `owner:branch`), else the cwd's HEAD. The PR number is parsed from the first
// payload field holding a PR URL; with none, the reminder names the pull
// request `gh` just created. A command holding several creates pairs `--head` values
// with PR numbers by position, one reminder per multi-commit pair, emitted only
// when the two lists are the same length; a `--head` no ref resolves is skipped
// there.
//
// The hook cannot block: it emits an additionalContext message or nothing, and
// fails open on every error. Rationale and stated limits:
// docs/notes/agent-hooks-and-scripts.md.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { git, splitSegments, tokenize } from "./lib/shell.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2027-03-31";

const PR_BASE = "origin/staging";
const NORMALIZER = fileURLToPath(
  new URL("../scripts/format-squash-message.mjs", import.meta.url),
);
const CANDIDATE_FIELDS = ["output", "stdout", "stderr", "content"];

// A PR URL as `gh pr create` prints it on success, matched loosely enough to
// survive a trailing path segment or a host that is not github.com.
const PR_URL = /https?:\/\/[^\s"']+?\/pull\/(\d+)\b/g;

// `--head <branch>` or `--head=<branch>` as `gh pr create` takes it, with the
// value optionally quoted the way a shell command line holds it.
const HEAD_FLAG = /--head(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;

const GH_PR_CREATE = /gh pr create/g;

const GH_PR_READY_TIMEOUT_MS = 15_000;

// Number of commits `ref` has over `base`, or null when it cannot be
// determined (no git, not a repo, base not fetched, ref unresolvable).
function commitCountOverBase(cwd, ref, base = PR_BASE) {
  const output = git(["rev-list", "--count", `${base}..${ref}`, "--"], {
    cwd,
  });
  if (output === null) return null;
  const count = Number(output);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

// Every branch the command tells `gh pr create` to open a pull request for, in
// command order. A fork-style `owner:branch` value keeps the branch.
function headRefsFromCommand(command) {
  return [...command.matchAll(HEAD_FLAG)]
    .map((match) => (match[1] ?? match[2] ?? match[3]).replace(/^[^:]*:/, ""))
    .filter((value) => value !== "");
}

function candidates(toolResponse) {
  if (typeof toolResponse === "string") return [toolResponse];
  if (toolResponse === null || typeof toolResponse !== "object") return [];
  return CANDIDATE_FIELDS.map((field) => toolResponse[field]).filter(
    (value) => typeof value === "string",
  );
}

// Every PR number in the first candidate field containing one, in output order.
function prNumbersFromResponse(toolResponse) {
  for (const candidate of candidates(toolResponse)) {
    const numbers = [...candidate.matchAll(PR_URL)].map((match) => match[1]);
    if (numbers.length > 0) return numbers;
  }
  return [];
}

const BODY_RULES =
  "a prose body summarizing the whole change, under the rules in " +
  "`CONTRIBUTING.md`, Commit Messages (no subject line, since GitHub takes " +
  "the subject from the PR title; no markdown, no board ids, no " +
  "self-attribution)";

// The script is quoted so that a checkout path holding a space still copies
// out of the reminder as one argument.
function postCommand(prNumber) {
  return (
    `node '${NORMALIZER}' --fenced <draft> | ` +
    `gh pr comment ${prNumber} --body-file -`
  );
}

// `prNumber` is null when the output held no PR URL to read it from.
function reminderFor(count, prNumber, base = PR_BASE) {
  const target =
    prNumber === null ? "the pull request gh just created" : `PR #${prNumber}`;
  return (
    `This PR branch has ${count} commits over ${base}. Post the body of its ` +
    `squash-and-merge commit message as one fenced comment on ${target} -- ` +
    `${BODY_RULES}. Draft the body in a file under a \`mktemp -d\` directory and ` +
    `post it through the normalizer: \`${postCommand(prNumber ?? "<pr-number>")}\`, ` +
    "which rewraps the body, drops markdown and list markers, and refuses what it " +
    "cannot fix. The command pipes the comment body straight to gh, so no second " +
    "file exists beside the draft; report only the comment URL in " +
    "your reply: the maintainer copies the body from the pull request when they " +
    "squash-merge."
  );
}

// The reminder for a command containing a single `gh pr create`, or null when the
// branch does not have enough commits to need a squash message.
function singleCreateReminder(cwd, command, toolResponse) {
  const [headRef] = headRefsFromCommand(command);
  const count =
    (headRef === undefined ? null : commitCountOverBase(cwd, headRef)) ??
    commitCountOverBase(cwd, "HEAD");
  if (count === null || count <= 1) return null;
  return reminderFor(count, prNumbersFromResponse(toolResponse).at(-1) ?? null);
}

// One reminder per created pull request whose branch has more than one
// commit, or null when nothing qualifies or the heads and the PR numbers cannot
// be paired by position.
function multiCreateReminder(cwd, command, toolResponse) {
  const headRefs = headRefsFromCommand(command);
  const prNumbers = prNumbersFromResponse(toolResponse);
  if (headRefs.length === 0 || headRefs.length !== prNumbers.length)
    return null;

  const reminders = headRefs
    .map((headRef, index) => ({
      count: commitCountOverBase(cwd, headRef),
      prNumber: prNumbers[index],
    }))
    .filter(({ count }) => count !== null && count > 1)
    .map(({ count, prNumber }) => reminderFor(count, prNumber));
  return reminders.length === 0 ? null : reminders.join("\n");
}

// The pull request number and `--repo` value of the first `gh pr ready` in the
// command, or null when it names no pull request by number or URL or undoes
// readiness (`--undo`).
function readyTargetFromCommand(command) {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    const start = tokens.findIndex(
      (token, index) =>
        token === "gh" &&
        tokens[index + 1] === "pr" &&
        tokens[index + 2] === "ready",
    );
    if (start === -1) continue;

    let repo = null;
    let prNumber = null;
    const args = tokens.slice(start + 3);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--undo") return null;
      if (arg === "--repo" || arg === "-R") {
        repo = args[++index] ?? null;
      } else if (arg.startsWith("--repo=")) {
        repo = arg.slice("--repo=".length);
      } else if (!arg.startsWith("-") && prNumber === null) {
        prNumber = /^\d+$/.test(arg)
          ? arg
          : (/\/pull\/(\d+)\/?(?:[?#].*)?$/.exec(arg)?.[1] ?? null);
      }
    }
    return prNumber === null ? null : { prNumber, repo };
  }
  return null;
}

// The head and base branch names of pull request `prNumber`, or null when `gh`
// fails or prints something else.
function pullRequestRefs(cwd, { prNumber, repo }) {
  try {
    const output = execFileSync(
      "gh",
      [
        "pr",
        "view",
        prNumber,
        "--json",
        "headRefName,baseRefName",
        ...(repo === null ? [] : ["--repo", repo]),
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GH_PR_READY_TIMEOUT_MS,
      },
    );
    const { headRefName, baseRefName } = JSON.parse(output);
    if (
      typeof headRefName !== "string" ||
      typeof baseRefName !== "string" ||
      headRefName === "" ||
      baseRefName === ""
    ) {
      return null;
    }
    return { head: headRefName, base: baseRefName };
  } catch {
    return null;
  }
}

// The reminder for a `gh pr ready` of a pull request whose head has more than
// one commit over its base, or null when it does not or anything cannot be read.
function readyReminder(cwd, command) {
  const target = readyTargetFromCommand(command);
  if (target === null) return null;
  const refs = pullRequestRefs(cwd, target);
  if (refs === null) return null;
  const base = `origin/${refs.base}`;
  const count = commitCountOverBase(cwd, refs.head, base);
  if (count === null || count <= 1) return null;
  return reminderFor(count, target.prNumber, base);
}

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);
  const createCount = [...command.matchAll(GH_PR_CREATE)].length;

  const cwd = eventCwd(event) ?? process.cwd();
  let reminder;
  if (createCount === 0) {
    reminder = readyReminder(cwd, command);
  } else if (createCount === 1) {
    reminder = singleCreateReminder(cwd, command, event.tool_response);
  } else {
    reminder = multiCreateReminder(cwd, command, event.tool_response);
  }
  if (reminder === null) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: reminder,
      },
    }),
  );
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail open: never disrupt the session on an unexpected error
}
