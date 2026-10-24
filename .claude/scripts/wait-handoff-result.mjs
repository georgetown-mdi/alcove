#!/usr/bin/env node
// Wait for a host hand-off's result file, so the dev container session reads it
// as soon as the host session writes it rather than when the owner relays it.
// The session starts it in the background under `timeout`, the bound
// block-sleep-poll.mjs requires of a background command, and is notified when it
// exits; the line to run is in USAGE.
//
// The file counts as written once it is non-empty and its size and modification
// time are the same on two checks one interval apart, so a write still in
// progress through the bind mount is not read half-done.
//
// Exit 0 written; 124 stopped by `timeout` (or SIGTERM, SIGINT) before it was;
// 2 a usage error.

import { statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Seconds between two checks of the result file when --interval is not given. */
export const DEFAULT_INTERVAL_SECONDS = 10;

/** The exit status when the wait ends before the file is written, as `timeout` reports it. */
export const NOT_WRITTEN_EXIT = 124;

const USAGE_EXIT = 2;
const RESULT_SUFFIX = ".result.md";
const MAX_INTERVAL_SECONDS = 600;

/** The usage text; its indented command line is the form the session runs. */
export const USAGE = `Usage: node .claude/scripts/wait-handoff-result.mjs <result-file> [--interval <seconds>]

Waits until a host hand-off's result file is written, then prints its path and
exits 0. Start it from the dev container session as a background command, under
timeout, so its exit notifies the session:

  timeout 14400 node .claude/scripts/wait-handoff-result.mjs /workspace/scratch/handoffs/<YYYY-MM-DD>-<slug>.result.md

  <result-file>        the brief's Result file, as this machine sees it
  --interval SECONDS   time between checks (default: ${DEFAULT_INTERVAL_SECONDS})
  -h, --help           print this help

Exit 0: the result file is written; read it. 124: the timeout ended the wait
first; start it again while the hand-off is still to run. 2: a usage error.
`;

/**
 * Read the command line: the result file and the interval in seconds, or
 * `help`, or an `error` to print beside the usage.
 */
export function parseArgs(argv) {
  let path;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
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
    if (argument.startsWith("-")) {
      return { error: `unknown option '${argument}'.` };
    }
    if (path !== undefined) {
      return {
        error: `one result file only; got '${path}' and '${argument}'.`,
      };
    }
    path = argument;
  }
  if (path === undefined) return { error: "name the result file to wait for." };
  if (!path.endsWith(RESULT_SUFFIX)) {
    return {
      error: `'${path}' is not a result file: a brief's Result file ends in ${RESULT_SUFFIX}.`,
    };
  }
  return { path, intervalSeconds };
}

/** The file's size and modification time, or null when there is no file. */
export function fileState(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * True when two consecutive checks found the same non-empty file: the write
 * that made it has finished.
 */
export function isWritten(previous, current) {
  return (
    previous !== null &&
    current !== null &&
    current.size > 0 &&
    previous.size === current.size &&
    previous.mtimeMs === current.mtimeMs
  );
}

function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.error !== undefined) {
    process.stderr.write(
      `wait-handoff-result: ${parsed.error} Run with --help for usage.\n`,
    );
    process.exitCode = USAGE_EXIT;
    return;
  }
  const { path, intervalSeconds } = parsed;
  if (!directoryExists(dirname(path))) {
    process.stderr.write(
      `wait-handoff-result: the directory ${dirname(path)} does not exist. Pass the result file's path as this machine sees it: /workspace/scratch/handoffs/... in the dev container.\n`,
    );
    process.exitCode = USAGE_EXIT;
    return;
  }

  const stop = () => {
    process.stdout.write(
      `wait-handoff-result: ${path} is not written yet; start the wait again to keep waiting.\n`,
    );
    process.exit(NOT_WRITTEN_EXIT);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  process.stdout.write(
    `wait-handoff-result: waiting for ${path}, checking every ${intervalSeconds} s.\n`,
  );
  let previous = null;
  const check = () => {
    const current = fileState(path);
    if (isWritten(previous, current)) {
      process.stdout.write(
        `wait-handoff-result: ${path} is written (${current.size} bytes).\n`,
      );
      process.exit(0);
    }
    previous = current;
  };
  check();
  setInterval(check, intervalSeconds * 1000);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
