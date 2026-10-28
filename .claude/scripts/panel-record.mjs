#!/usr/bin/env node
// Record assembler for a deliberating panel (/panel --deliberate): writes the
// panel's record from its answer directory and checks that the record is the
// panelists' own work. The panel chair runs it after each stretch of rounds;
// the session runs it itself when the chair has crashed.
//
// Usage: node panel-record.mjs <dir> [--chair <transcript.jsonl>]
//
// The chair's transcript is found, without --chair, among the session's
// subagent transcripts: <config>/projects/<project>/<session>/subagents/, with
// <session> from CLAUDE_CODE_SESSION_ID and <config> CLAUDE_CONFIG_DIR or
// ~/.claude, as the one `panel-chair` agent whose transcript names <dir>. Each
// panelist's transcript is `agent-<id>.jsonl` beside it, <id> taken from the
// chair's spawn of it.
//
// Writes <dir>/record.json: the panel, every round's answers (null with the
// reason for a seat that gave none or whose file fails the check), each seat's
// first and final answer, the next step as panel-relay.mjs judges it, and
// `problems`, one line per failed check:
//
// - an answer file whose sha256 differs from one the check recorded for it in
//   written.jsonl, or for which none was recorded;
// - an answer file no Write or Edit call of its own seat's panelist made;
// - a chair spawn or SendMessage whose text is not text panel-relay.mjs prints
//   for that seat (round 1 prompt, a later round's message, or the re-ask), a
//   spawn not pinned to opus, a seat spawned twice, a message to an agent that
//   is not a panelist, and any Write, Edit or NotebookEdit call by the chair;
// - a turn of the chair or a panelist whose `message.model` is not an Opus
//   model, the tier both are pinned to;
// - a panelist's Write, Edit or NotebookEdit outside <dir> or on a file in it
//   other than its own answer files, and any Agent or SendMessage call by a
//   panelist.
//
// A write made through Bash is not seen by the transcript checks; the hash
// check still catches a changed answer file. Prints the record's path and each
// problem. Exits 0 when there is none, 1 when there is any, and 2 on a usage
// error or a directory that is not a panel's.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findTranscript } from "./context-size.mjs";
import {
  RECORD_FILE,
  inputFileName,
  parseAnswerFileName,
  readHashLog,
} from "./lib/panelAnswers.mjs";
import {
  loadPanel,
  messageFor,
  nextStep,
  retryFor,
  seatsAsked,
} from "./panel-relay.mjs";

const USAGE =
  "Usage: node panel-record.mjs <dir> [--chair <transcript.jsonl>]\n";
const CHAIR_TYPE = "panel-chair";
const PINNED_TIER = "opus";
const PINNED_MODEL = /^claude-opus-/;
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/** The parsed lines of a transcript; a line that does not parse is skipped. */
export function readTranscript(path) {
  const entries = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // The line the harness is still writing.
    }
  }
  return entries;
}

const assistantEntries = (entries) =>
  entries.filter((entry) => entry.type === "assistant");

/** Every tool call of a transcript as `{id, name, input}`, once each. */
export function toolCalls(entries) {
  const calls = new Map();
  for (const entry of assistantEntries(entries)) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "tool_use" && !calls.has(part.id)) {
        calls.set(part.id, {
          id: part.id,
          name: part.name,
          input: part.input ?? {},
        });
      }
    }
  }
  return [...calls.values()];
}

/** The model of every model turn; the harness's `<synthetic>` entries are not turns. */
export function turnModels(entries) {
  return assistantEntries(entries)
    .map((entry) => entry.message?.model)
    .filter((model) => typeof model === "string" && model !== "<synthetic>");
}

/** The agent id each Agent call launched, by the call's id. */
export function launchedAgents(entries) {
  const launched = new Map();
  for (const entry of entries) {
    if (
      entry.type !== "user" ||
      typeof entry.toolUseResult?.agentId !== "string"
    ) {
      continue;
    }
    const content = entry.message?.content;
    const result = Array.isArray(content)
      ? content.find((part) => part?.type === "tool_result")
      : undefined;
    if (result) launched.set(result.tool_use_id, entry.toolUseResult.agentId);
  }
  return launched;
}

/** The subagent transcript directory of the session running this command, or null. */
export function sessionSubagentsDir(env) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return null;
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const transcript = findTranscript(configDir, sessionId);
  return transcript === null
    ? null
    : join(dirname(transcript), sessionId, "subagents");
}

/** Every panel-chair transcript in `subagentsDir` that names `dir`. */
export function chairTranscriptsFor(subagentsDir, dir) {
  if (!existsSync(subagentsDir)) return [];
  const found = [];
  for (const file of readdirSync(subagentsDir).sort()) {
    if (!file.endsWith(".meta.json")) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(subagentsDir, file), "utf8"));
    } catch {
      continue;
    }
    if (meta?.agentType !== CHAIR_TYPE) continue;
    const transcript = join(
      subagentsDir,
      file.replace(/\.meta\.json$/, ".jsonl"),
    );
    if (
      existsSync(transcript) &&
      readFileSync(transcript, "utf8").includes(`${dir}/`)
    ) {
      found.push(transcript);
    }
  }
  return found;
}

const same = (sent, printed) =>
  typeof sent === "string" && sent.trim() === printed.trim();

const pathOf = (input) => input.file_path ?? input.notebook_path;

function answerOf(entry) {
  if (entry.answer === null) return null;
  return { ...entry.answer };
}

/** The panel's rounds, each seat's first and final answer, and the next step. */
export function assemble(state) {
  const last = Math.max(0, ...state.answers.map((entry) => entry.round));
  const rounds = [];
  for (let round = 1; round <= last; round += 1) {
    const answers = seatsAsked(state, round).map((seat) => {
      const entry = state.answers.find(
        (candidate) => candidate.seat === seat && candidate.round === round,
      );
      if (entry === undefined)
        return { seat, answer: null, reason: "no answer" };
      if (entry.answer === null) {
        return {
          seat,
          answer: null,
          reason: `fails the check: ${entry.problems.join("; ")}`,
        };
      }
      return { seat, ...answerOf(entry) };
    });
    rounds.push({
      round,
      input: state.inputRounds.has(round)
        ? join(state.dir, inputFileName(round))
        : null,
      answers,
    });
  }
  const panelists = state.seats.map(({ name }) => {
    const valid = state.answers
      .filter((entry) => entry.seat === name && entry.answer !== null)
      .sort((a, b) => a.round - b.round);
    const first = valid.find((entry) => entry.round === 1);
    const final = valid.at(-1);
    return {
      seat: name,
      first: first ? answerOf(first) : null,
      final: final ? answerOf(final) : null,
      finalRound: final ? final.round : null,
    };
  });
  return {
    question: state.question,
    base: state.base,
    docs: state.docs ?? [],
    seats: state.seats,
    extraRounds: state.extraRounds,
    rounds,
    panelists,
    next: nextStep(state),
  };
}

/** Problems with the answer files alone: unrecorded or changed after the check. */
export function hashProblems(state) {
  const problems = [];
  const recorded = readHashLog(state.dir);
  for (const line of recorded) {
    if (line.unreadable !== undefined) {
      problems.push(
        `written.jsonl holds a line that is not a recorded check: ${line.unreadable}`,
      );
    }
  }
  const names = state.seats.map((seat) => seat.name);
  for (const entry of state.answers) {
    if (!names.includes(entry.seat)) {
      problems.push(
        `${entry.file} is the answer of a seat this panel does not have`,
      );
      continue;
    }
    if (entry.answer === null) continue;
    const hashes = recorded
      .filter((line) => line.file === entry.file)
      .map((line) => line.sha256);
    if (hashes.length === 0) {
      problems.push(`${entry.file} was never recorded as passing the check`);
    } else if (hashes.some((hash) => hash !== entry.sha256)) {
      problems.push(
        `${entry.file} differs from the text recorded when it passed the check`,
      );
    }
  }
  return problems;
}

/** The texts panel-relay.mjs prints for `seat` in any round up to `last`. */
function relayTexts(state, seat, last) {
  const texts = [];
  for (let round = 1; round <= last; round += 1) {
    try {
      texts.push(messageFor(state, seat, round));
    } catch {
      // The seat is not asked in this round.
    }
    texts.push(retryFor(state, seat, round));
  }
  return texts;
}

/**
 * Problems found in the chair's and the panelists' transcripts, and the
 * panelists' agent ids by seat. `readAgent(id)` returns a panelist's entries,
 * or null when its transcript is missing.
 */
export function transcriptProblems(state, chairEntries, readAgent) {
  const problems = [];
  const names = state.seats.map((seat) => seat.name);
  const last = Math.max(0, ...state.answers.map((entry) => entry.round)) + 1;

  for (const model of new Set(turnModels(chairEntries))) {
    if (!PINNED_MODEL.test(model)) {
      problems.push(
        `the chair ran a turn on ${model}, not the ${PINNED_TIER} tier it is pinned to`,
      );
    }
  }

  const launched = launchedAgents(chairEntries);
  const agentSeat = new Map();
  const calls = toolCalls(chairEntries);
  for (const call of calls.filter((entry) => entry.name === "Agent")) {
    const prompt = call.input.prompt;
    const seat =
      names.find((name) => same(prompt, messageFor(state, name, 1))) ??
      names.find((name) => call.input.description === `panelist: ${name}`);
    if (seat === undefined) {
      problems.push(
        `the chair spawned "${call.input.description}", which is no seat's`,
      );
      continue;
    }
    if (!same(prompt, messageFor(state, seat, 1))) {
      problems.push(
        `the chair's spawn of ${seat} is not the round 1 text panel-relay.mjs prints`,
      );
    }
    if (call.input.model !== PINNED_TIER) {
      problems.push(
        `the chair spawned ${seat} on ${call.input.model ?? "no model"}, not ${PINNED_TIER}`,
      );
    }
    if ([...agentSeat.values()].includes(seat)) {
      problems.push(`the chair spawned ${seat} more than once`);
    }
    const agentId = launched.get(call.id);
    if (agentId === undefined) {
      problems.push(`the chair's spawn of ${seat} records no agent id`);
    } else {
      agentSeat.set(agentId, seat);
    }
  }

  for (const call of calls) {
    if (WRITE_TOOLS.has(call.name)) {
      problems.push(`the chair called ${call.name} on ${pathOf(call.input)}`);
    }
    if (call.name !== "SendMessage") continue;
    const seat = agentSeat.get(call.input.to);
    if (seat === undefined) {
      problems.push(
        `the chair sent a message to ${call.input.to}, which is not a panelist`,
      );
    } else if (
      !relayTexts(state, seat, last).some((text) =>
        same(call.input.message, text),
      )
    ) {
      problems.push(
        `the chair sent ${seat} a message that is not text panel-relay.mjs prints`,
      );
    }
  }

  const writtenBy = new Map();
  for (const [agentId, seat] of agentSeat) {
    const entries = readAgent(agentId);
    if (entries === null) {
      problems.push(`no transcript for ${seat}'s panelist, agent ${agentId}`);
      continue;
    }
    for (const model of new Set(turnModels(entries))) {
      if (!PINNED_MODEL.test(model)) {
        problems.push(
          `${seat} ran a turn on ${model}, not the ${PINNED_TIER} tier it is pinned to`,
        );
      }
    }
    for (const call of toolCalls(entries)) {
      if (call.name === "Agent" || call.name === "SendMessage") {
        problems.push(`${seat} called ${call.name}`);
        continue;
      }
      if (!WRITE_TOOLS.has(call.name)) continue;
      const path = resolve(String(pathOf(call.input)));
      const own = parseAnswerFileName(basename(path));
      if (dirname(path) !== state.dir) {
        problems.push(`${seat} wrote ${path}, outside the answer directory`);
      } else if (own === null || own.seat !== seat) {
        problems.push(
          `${seat} wrote ${path}, which is not one of its answer files`,
        );
      } else {
        writtenBy.set(basename(path), seat);
      }
    }
  }
  for (const entry of state.answers) {
    if (
      names.includes(entry.seat) &&
      writtenBy.get(entry.file) !== entry.seat
    ) {
      problems.push(
        `${entry.file} was not written by ${entry.seat}'s panelist`,
      );
    }
  }
  return problems;
}

function fail(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

async function main(argv, env) {
  const [dirArg, flag, chairArg, ...extra] = argv;
  if (
    dirArg === undefined ||
    dirArg.startsWith("-") ||
    extra.length > 0 ||
    (flag !== undefined && (flag !== "--chair" || chairArg === undefined))
  ) {
    fail(USAGE.trimEnd());
  }
  const dir = resolve(dirArg);
  let state;
  try {
    state = await loadPanel(dir);
  } catch (error) {
    fail(error.message);
  }

  const problems = hashProblems(state);
  let chair = chairArg === undefined ? null : resolve(chairArg);
  if (chair === null) {
    const subagents = sessionSubagentsDir(env);
    const found = subagents === null ? [] : chairTranscriptsFor(subagents, dir);
    if (found.length === 1) [chair] = found;
    else {
      problems.push(
        `${found.length === 0 ? "no" : found.length} panel-chair transcripts name ${dir}; name the chair's with --chair to run the transcript checks`,
      );
    }
  }
  if (chair !== null) {
    if (!existsSync(chair)) fail(`${chair} does not exist.`);
    const readAgent = (agentId) => {
      const path = join(dirname(chair), `agent-${agentId}.jsonl`);
      return existsSync(path) ? readTranscript(path) : null;
    };
    problems.push(
      ...transcriptProblems(state, readTranscript(chair), readAgent),
    );
  }

  const record = { ...assemble(state), chairTranscript: chair, problems };
  const path = join(dir, RECORD_FILE);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${path}\n${record.next}\n`);
  for (const problem of problems) process.stdout.write(`problem: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
}

// Not run on import, so the test can load the functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2), process.env);
}
