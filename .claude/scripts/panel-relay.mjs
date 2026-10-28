#!/usr/bin/env node
// Relay text for a deliberating panel (/panel --deliberate): every message the
// panel chair sends a panelist is printed here, and the chair sends it
// verbatim, so the chair writes none of what a panelist reads.
// panel-record.mjs prints the same text again and compares it with what the
// chair's transcript shows it sent.
//
// Usage:
//   node panel-relay.mjs <dir> <seat> <round>          the message for one seat and round
//   node panel-relay.mjs <dir> <seat> <round> --retry  the one re-ask for a file that fails the check
//   node panel-relay.mjs <dir> next                    `round <N>` or `stop <reason>`
//   node panel-relay.mjs <dir> seats <round>           the seats asked in a round, one a line
//
// <dir> is the panel's answer directory (lib/panelAnswers.mjs). Round 1's
// message is the panel Workflow script's own prompt for the seat, taken by
// running .claude/scripts/panel-workflow.mjs with an `agent` that records it,
// plus where to write the answer. A later round's message names the paths of
// the seat's latest answer, the other seats' latest answers with their lenses,
// and the owner's input for the round when there is one; content travels in
// files, never in the message.
//
// A later round is printed only while the panel has not stopped: it stops when
// every answer of a round after the first reports `changed: false`, or once
// `extraRounds` rounds have run since the first round or the latest input
// round. An input file for the next round starts it again. `next` names the
// round to run or why the panel stopped. Printing a seat's message appends
// `{seat, round}` to relayed.jsonl in <dir>, so a round sent once that
// produced no answer file stops the panel rather than being sent again.
//
// Exits 0 with the text on stdout; 1 when the round is refused, with the
// reason; 2 on a usage error or a directory that is not a panel's.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIRST_ROUND_KEYS,
  LATER_ROUND_KEYS,
  answerFileName,
  appendRelayLog,
  inputFileName,
  readAnswerDir,
  readPanel,
} from "./lib/panelAnswers.mjs";

const USAGE = `Usage:
  node panel-relay.mjs <dir> <seat> <round> [--retry]
  node panel-relay.mjs <dir> next
  node panel-relay.mjs <dir> seats <round>
`;

const WORKFLOW = fileURLToPath(
  new URL("./panel-workflow.mjs", import.meta.url),
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * The first-round prompt the panel Workflow script gives each seat, and the
 * seats as it resolves them, for the question, base, docs and seats a
 * panel.json states. Throws what the script throws for arguments it refuses.
 */
export async function workflowPrompts(panel) {
  const body = readFileSync(WORKFLOW, "utf8").replace(
    /^export const meta =/m,
    "const meta =",
  );
  const run = new AsyncFunction("args", "agent", "parallel", body);
  const prompts = new Map();
  const record = (prompt, options) => {
    prompts.set(options.label.replace(/^panelist: /, ""), prompt);
    return null;
  };
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()));
  const { question, base, docs, seats } = panel;
  const result = await run({ question, base, docs, seats }, record, parallel);
  return { seats: result.seats, prompts };
}

/**
 * Everything the relay text depends on: the panel as panel.json states it,
 * its seats with their lenses, the first-round prompts, and the answer
 * directory's files.
 */
export async function loadPanel(dir) {
  const panel = readPanel(dir);
  const { seats, prompts } = await workflowPrompts(panel);
  return { ...panel, dir, seats, prompts, ...readAnswerDir(dir) };
}

const checkCommand = (state, path) =>
  `node ${state.base}/.claude/scripts/panel-answer-check.mjs ${path}`;

const keyList = (keys) => {
  const quoted = keys.map((key) => `\`${key}\``);
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
};

function writeClause(state, seat, round) {
  const path = join(state.dir, answerFileName(seat, round));
  const fields =
    round === 1
      ? `exactly the keys ${keyList(FIRST_ROUND_KEYS)}, each non-empty text`
      : `exactly the keys ${keyList(LATER_ROUND_KEYS)}: \`changed\` is true when your position differs from your latest answer, and \`movedBy\` names the argument that moved you and the seat that made it, or is empty text when \`changed\` is false`;
  return `The briefing's rule to read only under ${state.base} and run no builds or tests has one exception, this panel's answer directory ${state.dir}: you write your own answer file there, read the other panelists' answers there when a round names them, and run the answer-check script below.

Your structured result is a file, not your reply. With the Write tool, write one JSON object with ${fields}, to ${path}, and write no other file. Then run \`${checkCommand(state, path)}\`, the one script you run, and fix the file until it prints ok; once it has, do not change the file. Reply with the one line \`WROTE ${path}\`. Do not spawn or message any agent.`;
}

/** The latest answer of each seat from rounds before `round`, by seat. */
function latestBefore(state, round) {
  const latest = new Map();
  for (const entry of state.answers) {
    if (entry.answer === null || entry.round >= round) continue;
    const known = latest.get(entry.seat);
    if (known === undefined || known.round < entry.round) {
      latest.set(entry.seat, entry);
    }
  }
  return latest;
}

/** The seats asked in `round`: every seat in round 1, after it those with an answer. */
export function seatsAsked(state, round) {
  const names = state.seats.map((seat) => seat.name);
  if (round === 1) return names;
  const latest = latestBefore(state, round);
  return names.filter((name) => latest.has(name));
}

/** Why `round` cannot run, judged from the rounds before it, or null when it can. */
export function roundRefusal(state, round) {
  if (round === 1) return null;
  const previous = round - 1;
  const previousAnswers = state.answers.filter(
    (entry) => entry.round === previous,
  );
  if (previousAnswers.length === 0) return `round ${previous} has no answers`;
  if (state.inputRounds.has(round)) return null;
  if (
    previous > 1 &&
    previousAnswers.every((entry) => entry.answer?.changed === false)
  ) {
    return `unchanged: every answer of round ${previous} kept its position`;
  }
  const start = Math.max(
    1,
    ...[...state.inputRounds].filter((input) => input <= previous),
  );
  if (previous - start >= state.extraRounds) {
    return `cap: round ${previous} was the last of ${state.extraRounds} after round ${start}`;
  }
  return null;
}

/**
 * `round <N>` for the round to run next, or `stop <reason>`. N is one past the
 * last round with an answer file, so a round already sent whose seats wrote
 * no file would come up again: it stops instead, naming the seats sent.
 */
export function nextStep(state) {
  const last = Math.max(0, ...state.answers.map((entry) => entry.round));
  const round = last + 1;
  const sent = state.relayed.get(round);
  if (sent !== undefined) {
    const seats = state.seats
      .map((seat) => seat.name)
      .filter((name) => sent.has(name));
    return `stop empty: round ${round} was sent to ${seats.join(", ")} and no seat wrote an answer file`;
  }
  const refusal = roundRefusal(state, round);
  return refusal === null ? `round ${round}` : `stop ${refusal}`;
}

/**
 * The message for `seat` in `round`, judged from the files of earlier rounds
 * alone, so it reads the same while the round runs and afterwards. Throws when
 * the seat is not asked in that round.
 */
export function messageFor(state, seat, round) {
  if (!seatsAsked(state, round).includes(seat)) {
    throw new Error(
      `The seat "${seat}" is not asked in round ${round}: it is not one of this panel's seats, or it has no answer to revise.`,
    );
  }
  if (round === 1) {
    return `${state.prompts.get(seat)}\n\n${writeClause(state, seat, 1)}`;
  }
  const latest = latestBefore(state, round);
  const lensOf = (name) =>
    state.seats.find((entry) => entry.name === name).lens;
  const others = [...latest.values()]
    .filter((entry) => entry.seat !== seat)
    .map(
      (entry) => `- ${join(state.dir, entry.file)} -- ${lensOf(entry.seat)}`,
    );
  const input = state.inputRounds.has(round)
    ? `The owner has added input for this round: read ${join(state.dir, inputFileName(round))} first.\n\n`
    : "";
  return `Round ${round} of the panel. ${input}Your latest answer is ${join(state.dir, latest.get(seat).file)}. The other panelists' latest answers, each with the lens it was weighed through:
${others.join("\n")}

Read them, and answer the question again through your own lens. Keep your position where the other answers do not move you and change it where one does; do not split the difference between positions.

${writeClause(state, seat, round)}`;
}

/** The one re-ask for an answer file of `round` that fails the check. */
export function retryFor(state, seat, round) {
  if (!state.seats.some((entry) => entry.name === seat)) {
    throw new Error(`The seat "${seat}" is not one of this panel's seats.`);
  }
  const path = join(state.dir, answerFileName(seat, round));
  return `Your answer file ${path} does not pass the check. Run \`${checkCommand(state, path)}\`, fix what it reports, and reply with the one line \`WROTE ${path}\`.`;
}

function fail(code, reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(code);
}

async function main(argv) {
  const [dirArg, first, roundText, ...extra] = argv;
  const isNext = first === "next" && roundText === undefined;
  const retry = extra.length === 1 && extra[0] === "--retry";
  if (
    dirArg === undefined ||
    (!isNext && (roundText === undefined || (extra.length > 0 && !retry)))
  ) {
    fail(2, USAGE.trimEnd());
  }
  let state;
  try {
    state = await loadPanel(resolve(dirArg));
  } catch (error) {
    fail(2, error.message);
  }
  if (isNext) {
    process.stdout.write(`${nextStep(state)}\n`);
    return;
  }
  if (!/^[1-9]\d*$/.test(roundText)) {
    fail(2, `round is a whole number from 1; got ${roundText}.`);
  }
  const round = Number(roundText);
  if (first === "seats" && !retry) {
    process.stdout.write(
      seatsAsked(state, round)
        .map((seat) => `${seat}\n`)
        .join(""),
    );
    return;
  }
  if (!retry) {
    const refusal = roundRefusal(state, round);
    if (refusal !== null) fail(1, `Round ${round} does not run: ${refusal}.`);
  }
  try {
    const text = retry
      ? retryFor(state, first, round)
      : messageFor(state, first, round);
    if (!retry) appendRelayLog(state.dir, first, round);
    process.stdout.write(`${text}\n`);
  } catch (error) {
    fail(1, error.message);
  }
}

// Not run on import, so the test and panel-record.mjs can load the functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
