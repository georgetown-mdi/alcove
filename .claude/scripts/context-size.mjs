#!/usr/bin/env node
//
// Print the size of the session's context in tokens, so an orchestrating
// session can tell when it has passed the size at which
// .claude/orchestration/ruleset.md, Session lifecycle, has it prepare a
// compaction.
//
// Usage:
//   node context-size.mjs [<transcript.jsonl>]
//
// The size is the prompt of the session's most recent model call: the sum of
// `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`
// in the usage of the transcript's last assistant entry. Skipped on the way
// back: sidechain entries, entries with no usage, and entries whose usage sums
// to zero, which is what the `<synthetic>` entry the harness writes for an API
// error records. A /compact keeps the transcript and its session id, so after
// one the last call's prompt is the compacted context.
//
// With no argument the transcript is `<config>/projects/<project>/<id>.jsonl`:
// <id> is CLAUDE_CODE_SESSION_ID, which the harness exports to every command
// the session runs, <config> is CLAUDE_CONFIG_DIR or ~/.claude when it is
// unset, and every project directory is searched for the file, so the name the
// harness derives from the starting directory is not rebuilt here. A spawned
// agent's commands see the session's id, so the figure is always the session's.
//
// Prints `<n> tokens` and exits 0. Exits 1 with the reason on stderr when there
// is no session id, no transcript, or no model call in it yet.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: node context-size.mjs [<transcript.jsonl>]\n";

/** The prompt size a usage record states, or 0 when it states none. */
export function promptTokens(usage) {
  if (usage === null || typeof usage !== "object") return 0;
  const count = (value) =>
    Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  return (
    count(usage.input_tokens) +
    count(usage.cache_creation_input_tokens) +
    count(usage.cache_read_input_tokens)
  );
}

/**
 * The prompt size of the last main-chain model call in a transcript's text, or
 * null when it holds none. A line that does not parse -- the one the harness
 * is still writing -- is skipped.
 */
export function lastPromptTokens(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" || entry.isSidechain === true) continue;
    const tokens = promptTokens(entry.message?.usage);
    if (tokens > 0) return tokens;
  }
  return null;
}

/**
 * The path of session `sessionId`'s transcript under `configDir`, or null when
 * no project directory holds one.
 */
export function findTranscript(configDir, sessionId) {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const candidate = join(projects, project.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function fail(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}

function main(argv, env) {
  if (argv.length > 1 || argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(USAGE);
    process.exit(argv.length > 1 ? 1 : 0);
  }
  let transcript = argv[0];
  if (transcript === undefined) {
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) {
      fail(
        "CLAUDE_CODE_SESSION_ID is not set, so there is no session to measure. Run this from a Claude Code session, or name the transcript.",
      );
    }
    const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    transcript = findTranscript(configDir, sessionId);
    if (transcript === null) {
      fail(
        `No transcript for session ${sessionId} under ${join(configDir, "projects")}. Name the transcript, or set CLAUDE_CONFIG_DIR to the directory holding projects/.`,
      );
    }
  } else if (!existsSync(transcript)) {
    fail(`${transcript} does not exist.`);
  }
  const tokens = lastPromptTokens(readFileSync(transcript, "utf8"));
  if (tokens === null) {
    fail(`${transcript} records no model call yet.`);
  }
  process.stdout.write(`${tokens} tokens\n`);
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env);
}
