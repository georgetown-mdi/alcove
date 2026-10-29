// The answer directory a deliberating panel (/panel --deliberate) works in,
// shared by panel-answer-check.mjs, panel-relay.mjs and panel-record.mjs.
//
// The session makes the directory with `mktemp -d` and writes `panel.json`
// into it: `{question, base, docs, seats, extraRounds}`, the first four as the
// panel Workflow takes them and `extraRounds` the cap on rounds after the first
// round or an input round (default 2). Each panelist writes its answer for
// round N to `<seat>-r<N>.json`; the check appends `{file, sha256}` to
// `written.jsonl` each time an answer passes; panel-relay.mjs appends
// `{seat, round}` to `relayed.jsonl` each time it prints a seat's message; the
// owner's new input for round N is `input-r<N>.md`; the assembler writes
// `record.json`.
//
// Only node builtins are imported: panelists run the check from the panel's
// base checkout, which has no node_modules.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The fields of a first-round answer. */
export const FIRST_ROUND_KEYS = ["position", "rationale", "keyRisk"];

/** The fields of an answer from round 2 on. */
export const LATER_ROUND_KEYS = [...FIRST_ROUND_KEYS, "changed", "movedBy"];

export const PANEL_FILE = "panel.json";
export const HASH_LOG = "written.jsonl";
export const RELAY_LOG = "relayed.jsonl";
export const RECORD_FILE = "record.json";
export const DEFAULT_EXTRA_ROUNDS = 2;

// A seat name becomes part of a file name, so it is held to this shape.
const SEAT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const RELAY_COMMANDS = ["next", "seats"];
const ANSWER_NAME = /^(.+)-r([1-9]\d*)\.json$/;
const INPUT_NAME = /^input-r([1-9]\d*)\.md$/;

/** The file name of `seat`'s answer for `round`. */
export const answerFileName = (seat, round) => `${seat}-r${round}.json`;

/** The file name of the owner's input for `round`. */
export const inputFileName = (round) => `input-r${round}.md`;

/** `{seat, round}` of an answer file name, or null when it is not one. */
export function parseAnswerFileName(name) {
  const match = ANSWER_NAME.exec(name);
  return match ? { seat: match[1], round: Number(match[2]) } : null;
}

/** The sha256 of a file's text, hex. */
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The keys named more than once at the top level of `text`, which must be
 * valid JSON. JSON.parse keeps the last of a repeated key without a word, so a
 * repeat is found by scanning the text itself.
 */
export function repeatedTopLevelKeys(text) {
  const seen = new Set();
  const repeated = new Set();
  let depth = 0;
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      if (depth === 1 && expectKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        (seen.has(key) ? repeated : seen).add(key);
        expectKey = false;
      }
      index = end;
    } else if (char === "{" || char === "[") {
      depth += 1;
      expectKey = depth === 1 && char === "{";
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      expectKey = true;
    }
  }
  return [...repeated];
}

const isText = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Every reason the text of an answer file for `round` fails the answer's
 * shape, empty when it passes. Round 1 takes FIRST_ROUND_KEYS, later rounds
 * LATER_ROUND_KEYS: `changed` a boolean, `movedBy` text that is non-empty when
 * `changed` is true.
 */
export function answerProblems(text, round) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch (error) {
    return [`not JSON (${error.message})`];
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    return ["not one JSON object"];
  }
  const problems = repeatedTopLevelKeys(text).map(
    (key) => `\`${key}\` repeated`,
  );
  const keys = round === 1 ? FIRST_ROUND_KEYS : LATER_ROUND_KEYS;
  for (const key of FIRST_ROUND_KEYS) {
    if (!Object.hasOwn(answer, key)) problems.push(`\`${key}\` missing`);
    else if (!isText(answer[key]))
      problems.push(`\`${key}\` empty or not text`);
  }
  if (round > 1) {
    if (!Object.hasOwn(answer, "changed")) problems.push("`changed` missing");
    else if (typeof answer.changed !== "boolean") {
      problems.push("`changed` is not true or false");
    }
    if (!Object.hasOwn(answer, "movedBy")) problems.push("`movedBy` missing");
    else if (typeof answer.movedBy !== "string") {
      problems.push("`movedBy` is not text");
    } else if (answer.changed === true && answer.movedBy.trim() === "") {
      problems.push(
        "`movedBy` empty while `changed` is true: name the argument and the seat that moved you",
      );
    }
  }
  for (const key of Object.keys(answer)) {
    if (!keys.includes(key)) {
      problems.push(`\`${key}\` is not a field of a round ${round} answer`);
    }
  }
  return problems;
}

/**
 * The panel a directory's panel.json states, as written; throws with the
 * reason when it is missing or malformed. The question, base, docs and seats
 * are checked by the panel Workflow script itself (panel-relay.mjs).
 */
export function readPanel(dir) {
  const path = join(dir, PANEL_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${path} does not exist: the session writes it before the chair starts.`,
    );
  }
  let panel;
  try {
    panel = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`${path} is not JSON.`, { cause });
  }
  if (panel === null || typeof panel !== "object" || Array.isArray(panel)) {
    throw new Error(`${path} is not one JSON object.`);
  }
  const extraRounds = panel.extraRounds ?? DEFAULT_EXTRA_ROUNDS;
  if (!Number.isInteger(extraRounds) || extraRounds < 1) {
    throw new Error(
      `extraRounds in ${path} is a whole number of at least 1; got ${JSON.stringify(panel.extraRounds)}.`,
    );
  }
  const names = Array.isArray(panel.seats)
    ? panel.seats.map((seat) => (typeof seat === "string" ? seat : seat?.name))
    : [];
  const unsafe = names.find(
    (name) => typeof name === "string" && !SEAT_NAME.test(name),
  );
  if (unsafe !== undefined) {
    throw new Error(
      `The seat name "${unsafe}" becomes a file name, so it is letters, digits and hyphens.`,
    );
  }
  const reserved = names.find((name) => RELAY_COMMANDS.includes(name));
  if (reserved !== undefined) {
    throw new Error(
      `"${reserved}" is a panel-relay.mjs command, so it cannot name a seat.`,
    );
  }
  return { ...panel, extraRounds };
}

/**
 * Every `{file, sha256}` the check recorded in `dir`, in order; a line that is
 * not one is `{file: null, sha256: null, unreadable}` with the line's text.
 */
export function readHashLog(dir) {
  const path = join(dir, HASH_LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object") return parsed;
      } catch {
        // An unparseable line is reported by panel-record, not thrown.
      }
      return { file: null, sha256: null, unreadable: line };
    });
}

/** Record that `file` in `dir` passed the check with the text it now has. */
export function appendHashLog(dir, file, hash) {
  appendFileSync(
    join(dir, HASH_LOG),
    `${JSON.stringify({ file, sha256: hash })}\n`,
  );
}

/** Record that panel-relay.mjs printed `seat`'s message for `round`. */
export function appendRelayLog(dir, seat, round) {
  appendFileSync(join(dir, RELAY_LOG), `${JSON.stringify({ seat, round })}\n`);
}

/**
 * The seats panel-relay.mjs printed a message for, by round. A line that is
 * not a `{seat, round}` record is skipped.
 */
export function readRelayLog(dir) {
  const path = join(dir, RELAY_LOG);
  const relayed = new Map();
  if (!existsSync(path)) return relayed;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry?.seat !== "string" || !Number.isInteger(entry.round)) {
      continue;
    }
    if (!relayed.has(entry.round)) relayed.set(entry.round, new Set());
    relayed.get(entry.round).add(entry.seat);
  }
  return relayed;
}

/**
 * What `dir` holds: `answers`, every answer file as `{file, seat, round, text,
 * sha256, answer, problems}` (answer null when it fails the check),
 * `inputRounds`, the rounds with an input file, and `relayed`, the seats sent
 * a message in each round (readRelayLog).
 */
export function readAnswerDir(dir) {
  const answers = [];
  const inputRounds = new Set();
  for (const file of readdirSync(dir).sort()) {
    const input = INPUT_NAME.exec(file);
    if (input) {
      inputRounds.add(Number(input[1]));
      continue;
    }
    const parsed = parseAnswerFileName(file);
    if (parsed === null) continue;
    const text = readFileSync(join(dir, file), "utf8");
    const problems = answerProblems(text, parsed.round);
    answers.push({
      file,
      ...parsed,
      text,
      sha256: sha256(text),
      answer: problems.length === 0 ? JSON.parse(text) : null,
      problems,
    });
  }
  return { answers, inputRounds, relayed: readRelayLog(dir) };
}
