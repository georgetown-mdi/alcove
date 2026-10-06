#!/usr/bin/env node
// PostToolUse hook on Bash: after a `gh pr create` call whose branch has more
// than one commit over origin/staging, tell the session to post a
// ready-to-paste squash-and-merge commit body as a fenced comment on the new pull request.
// Pull requests merge by squash, and GitHub's default message for a
// multi-commit branch is a list of subjects; a one-commit branch gets no
// reminder. Only the body is asked for, since GitHub fills the subject from the
// PR title; its format comes from ../scripts/format-squash-message.mjs.
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

import { fileURLToPath } from "node:url";

import { commandOf, eventCwd, eventForTools } from "./lib/event.mjs";
import { git } from "./lib/shell.mjs";

/** The last date, YYYY-MM-DD, this hook stands before it is renewed or deleted. */
export const EXPIRES_ON = "2026-12-31";

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

// Number of commits `ref` has over the PR base, or null when it cannot be
// determined (no git, not a repo, origin/staging not fetched, ref unresolvable).
function commitCountOverBase(cwd, ref) {
  const output = git(["rev-list", "--count", `${PR_BASE}..${ref}`, "--"], {
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
function reminderFor(count, prNumber) {
  const target =
    prNumber === null ? "the pull request gh just created" : `PR #${prNumber}`;
  return (
    `This PR branch has ${count} commits over ${PR_BASE}. Post the body of its ` +
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

function main() {
  const event = eventForTools("Bash");
  if (event === null) process.exit(0); // unreadable, or another tool
  const command = commandOf(event);
  if (command === null) process.exit(0);
  const createCount = [...command.matchAll(GH_PR_CREATE)].length;
  if (createCount === 0) process.exit(0);

  const cwd = eventCwd(event) ?? process.cwd();
  const reminder =
    createCount === 1
      ? singleCreateReminder(cwd, command, event.tool_response)
      : multiCreateReminder(cwd, command, event.tool_response);
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
