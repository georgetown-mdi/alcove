#!/usr/bin/env node
// Answer check for a deliberating panel (/panel --deliberate): a panelist runs
// it on the answer file it wrote before it replies, and the panel chair runs it
// again on the file once the panelist has replied.
//
// Usage: node panel-answer-check.mjs <dir>/<seat>-r<N>.json
//
// The file must sit in a panel's answer directory (lib/panelAnswers.mjs), name
// one of the seats panel.json states, and hold one JSON object with exactly
// the fields of a round N answer, none repeated or empty: `position`,
// `rationale` and `keyRisk`, and from round 2 also `changed` (true or false)
// and `movedBy` (text, non-empty when `changed` is true).
//
// On a pass it appends the file's sha256 to the directory's written.jsonl,
// which panel-record.mjs compares against the file, prints `ok <file>`, and
// exits 0. On a failure it prints `FAIL <file>: <reasons>` and exits 1. A
// usage error, or a file outside a panel's answer directory, exits 2.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  answerProblems,
  appendHashLog,
  parseAnswerFileName,
  readPanel,
  sha256,
} from "./lib/panelAnswers.mjs";

const USAGE = "Usage: node panel-answer-check.mjs <dir>/<seat>-r<N>.json\n";

/**
 * Check one answer file: `{ok: true}` after recording its hash, or
 * `{ok: false, problems}`. Throws when the file is not in a panel's answer
 * directory.
 */
export function checkAnswerFile(path) {
  const dir = dirname(path);
  const file = basename(path);
  const parsed = parseAnswerFileName(file);
  if (parsed === null) {
    throw new Error(`${file} is not named <seat>-r<N>.json.`);
  }
  const panel = readPanel(dir);
  const seats = panel.seats.map((seat) =>
    typeof seat === "string" ? seat : seat.name,
  );
  if (!seats.includes(parsed.seat)) {
    throw new Error(
      `${file} names the seat "${parsed.seat}", which is not one of this panel's: ${seats.join(", ")}.`,
    );
  }
  if (!existsSync(path))
    return { ok: false, problems: ["the file does not exist"] };
  const text = readFileSync(path, "utf8");
  const problems = answerProblems(text, parsed.round);
  if (problems.length > 0) return { ok: false, problems };
  appendHashLog(dir, file, sha256(text));
  return { ok: true };
}

function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const path = resolve(argv[0]);
  let result;
  try {
    result = checkAnswerFile(path);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  if (result.ok) {
    process.stdout.write(`ok ${path}\n`);
    return;
  }
  process.stdout.write(`FAIL ${path}: ${result.problems.join("; ")}\n`);
  process.exit(1);
}

// Not run on import, so the test can load checkAnswerFile.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
