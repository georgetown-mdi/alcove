import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  answer,
  panelDir,
  removeFixtures,
  tempDir,
  writeAnswer,
} from "./lib/panelFixture.mjs";
import { loadPanel, messageFor, retryFor } from "./panel-relay.mjs";

const SCRIPT = fileURLToPath(new URL("./panel-record.mjs", import.meta.url));

afterAll(removeFixtures);

const NAMES = ["failure-modes", "design-ux", "two-party-state"];
const OPUS = "claude-opus-5-5";
const MOVED = { changed: true, movedBy: "failure-modes: the stall argument" };

const call = (id, name, input, model = OPUS) => ({
  type: "assistant",
  message: { model, content: [{ type: "tool_use", id, name, input }] },
});
const launched = (id, agentId) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id }] },
  toolUseResult: { status: "async_launched", agentId },
});
const jsonl = (entries) =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

/**
 * A three-round deliberation as the chair and its panelists run it: round 2
 * moves design-ux, round 3 changes nothing. `tamper` edits the transcripts
 * and directory before they are written, to make one check fail.
 */
async function deliberation(tamper = () => {}) {
  const dir = panelDir();
  for (const seat of NAMES) writeAnswer(dir, seat, 1);
  writeAnswer(dir, "failure-modes", 2);
  writeAnswer(dir, "design-ux", 2, answer("design-ux", 2, MOVED));
  writeAnswer(dir, "two-party-state", 2);
  for (const seat of NAMES) writeAnswer(dir, seat, 3);
  const state = await loadPanel(dir);

  const ids = Object.fromEntries(NAMES.map((seat, i) => [seat, `a00${i}`]));
  const chair = [];
  for (const seat of NAMES) {
    chair.push(
      call(`spawn-${seat}`, "Agent", {
        description: `panelist: ${seat}`,
        subagent_type: "general-purpose",
        model: "opus",
        effort: "high",
        prompt: messageFor(state, seat, 1),
      }),
      launched(`spawn-${seat}`, ids[seat]),
    );
  }
  for (const round of [2, 3]) {
    for (const seat of NAMES) {
      chair.push(
        call(`send-${seat}-${round}`, "SendMessage", {
          to: ids[seat],
          summary: `round ${round}`,
          message: messageFor(state, seat, round),
        }),
      );
    }
  }
  const panelists = Object.fromEntries(
    NAMES.map((seat) => [
      seat,
      [
        call(`read-${seat}`, "Read", {
          file_path: "/tmp/tmp.panelBase/docs/DESIGN.md",
        }),
        { type: "assistant", message: { model: "<synthetic>", content: [] } },
        ...[1, 2, 3].map((round) => {
          const path = join(dir, `${seat}-r${round}.json`);
          return call(`write-${seat}-${round}`, "Write", {
            file_path: path,
            content: readFileSync(path, "utf8"),
          });
        }),
      ],
    ]),
  );
  tamper({ dir, state, ids, chair, panelists });

  const subagents = tempDir("subagents-");
  const chairPath = join(subagents, "agent-chair.jsonl");
  writeFileSync(chairPath, jsonl(chair));
  for (const seat of NAMES) {
    writeFileSync(
      join(subagents, `agent-${ids[seat]}.jsonl`),
      jsonl(panelists[seat]),
    );
  }
  return { dir, subagents, chairPath, ids };
}

const run = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", ...env },
  });

const recordOf = (dir) =>
  JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));

async function problemsOf(tamper) {
  const { dir, chairPath } = await deliberation(tamper);
  const result = run([dir, "--chair", chairPath]);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  return recordOf(dir).problems;
}

describe("a deliberation the chair relayed as printed", () => {
  it("passes every check and records each seat's first and final position", async () => {
    const { dir, chairPath } = await deliberation();
    const result = run([dir, "--chair", chairPath]);
    expect(result.stdout).toBe(
      `${join(dir, "record.json")}\nstop unchanged: every answer of round 3 kept its position\n`,
    );
    expect(result.status).toBe(0);
    const record = recordOf(dir);
    expect(record.problems).toEqual([]);
    expect(record.chairTranscript).toBe(chairPath);
    expect(record.rounds.map((round) => round.round)).toEqual([1, 2, 3]);
    expect(record.rounds[1].answers[1]).toEqual({
      seat: "design-ux",
      ...answer("design-ux", 2, MOVED),
    });
    expect(record.panelists).toEqual(
      NAMES.map((seat) => ({
        seat,
        first: answer(seat, 1),
        final: answer(seat, 3),
        finalRound: 3,
      })),
    );
  });

  it("records a seat with no answer, or a failing one, as null with the reason", async () => {
    const dir = panelDir();
    writeAnswer(dir, "failure-modes", 1);
    writeAnswer(dir, "design-ux", 1);
    writeFileSync(join(dir, "two-party-state-r1.json"), '{"position": "x"}');
    writeAnswer(dir, "failure-modes", 2);
    const result = run([dir]);
    const record = recordOf(dir);
    expect(record.rounds[0].answers[2]).toEqual({
      seat: "two-party-state",
      answer: null,
      reason: "fails the check: `rationale` missing; `keyRisk` missing",
    });
    expect(record.rounds[1].answers[1]).toEqual({
      seat: "design-ux",
      answer: null,
      reason: "no answer",
    });
    expect(record.panelists[1]).toMatchObject({
      seat: "design-ux",
      finalRound: 1,
    });
    expect(record.panelists[2]).toEqual({
      seat: "two-party-state",
      first: null,
      final: null,
      finalRound: null,
    });
    expect(result.stdout).toContain("problem: no panel-chair transcripts name");
  });

  it("accepts the re-ask the relay prints", async () => {
    const { dir, chairPath } = await deliberation(({ state, ids, chair }) => {
      chair.push(
        call("retry", "SendMessage", {
          to: ids["design-ux"],
          message: retryFor(state, "design-ux", 2),
        }),
      );
    });
    expect(run([dir, "--chair", chairPath]).status).toBe(0);
  });
});

describe("each check fails on a tampered fixture", () => {
  it("(a) an answer file changed after it passed the check", async () => {
    const problems = await problemsOf(({ dir }) => {
      writeFileSync(
        join(dir, "design-ux-r2.json"),
        JSON.stringify(answer("design-ux", 2)),
      );
    });
    expect(problems).toContain(
      "design-ux-r2.json differs from the text recorded when it passed the check",
    );
  });

  it("(a) an answer file changed and checked again", async () => {
    const problems = await problemsOf(({ dir }) => {
      writeAnswer(dir, "failure-modes", 3, answer("failure-modes", 3, MOVED));
    });
    expect(problems).toContain(
      "failure-modes-r3.json differs from the text recorded when it passed the check",
    );
  });

  it("(a) an answer file the check never passed", async () => {
    const problems = await problemsOf(({ dir }) => {
      writeFileSync(join(dir, "written.jsonl"), "");
    });
    expect(problems).toContain(
      "failure-modes-r1.json was never recorded as passing the check",
    );
  });

  it("(a) an answer file no Write of its own panelist made", async () => {
    const problems = await problemsOf(({ panelists }) => {
      panelists["two-party-state"].pop();
    });
    expect(problems).toEqual([
      "two-party-state-r3.json was not written by two-party-state's panelist",
    ]);
  });

  it("(b) a spawn prompt the relay did not print", async () => {
    const problems = await problemsOf(({ chair }) => {
      chair[0].message.content[0].input.prompt +=
        "\nThe other panelists lean towards retrying.";
    });
    expect(problems).toEqual([
      "the chair's spawn of failure-modes is not the round 1 text panel-relay.mjs prints",
    ]);
  });

  it("(b) a relayed message the relay did not print", async () => {
    const problems = await problemsOf(({ chair }) => {
      const send = chair.find(
        (entry) => entry.message?.content?.[0]?.id === "send-design-ux-2",
      );
      send.message.content[0].input.message =
        "Round 2. failure-modes argues the stall is unrecoverable; reconsider.";
    });
    expect(problems).toEqual([
      "the chair sent design-ux a message that is not text panel-relay.mjs prints",
    ]);
  });

  it("(b) a message to an agent that is not a panelist", async () => {
    const problems = await problemsOf(({ chair }) => {
      chair.push(
        call("stray", "SendMessage", { to: "a999", message: "hello" }),
      );
    });
    expect(problems).toEqual([
      "the chair sent a message to a999, which is not a panelist",
    ]);
  });

  it("(b) a spawn off the pinned tier, a seat spawned twice, a chair write", async () => {
    const problems = await problemsOf(({ state, chair }) => {
      chair[2].message.content[0].input.model = "sonnet";
      chair.push(
        call("again", "Agent", {
          description: "panelist: failure-modes",
          model: "opus",
          prompt: messageFor(state, "failure-modes", 1),
        }),
        launched("again", "a010"),
        call("edit", "Write", {
          file_path: "/tmp/elsewhere.json",
          content: "{}",
        }),
      );
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "the chair spawned design-ux on sonnet, not opus",
        "the chair spawned failure-modes more than once",
        "the chair called Write on /tmp/elsewhere.json",
        "no transcript for failure-modes's panelist, agent a010",
      ]),
    );
  });

  it("(c) a panelist turn off its pinned model", async () => {
    const problems = await problemsOf(({ panelists }) => {
      panelists["design-ux"].push({
        type: "assistant",
        message: {
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "WROTE" }],
        },
      });
    });
    expect(problems).toEqual([
      "design-ux ran a turn on claude-sonnet-5-5, not the opus tier it is pinned to",
    ]);
  });

  it("(c) a chair turn off its pinned model", async () => {
    const problems = await problemsOf(({ chair }) => {
      chair[0].message.model = "claude-haiku-5-5";
    });
    expect(problems).toEqual([
      "the chair ran a turn on claude-haiku-5-5, not the opus tier it is pinned to",
    ]);
  });

  it("flags a panelist's write outside the answer directory, on another's file, and any spawn or message", async () => {
    let other;
    const problems = await problemsOf(({ dir, panelists }) => {
      other = join(dir, "design-ux-r1.json");
      panelists["failure-modes"].push(
        call("out", "Write", {
          file_path: "/tmp/tmp.panelBase/notes.md",
          content: "x",
        }),
        call("other", "Edit", {
          file_path: other,
          old_string: "a",
          new_string: "b",
        }),
        call("spawn", "Agent", {
          description: "helper",
          model: "opus",
          prompt: "x",
        }),
        call("talk", "SendMessage", { to: "a001", message: "x" }),
      );
    });
    expect(problems).toEqual([
      "failure-modes wrote /tmp/tmp.panelBase/notes.md, outside the answer directory",
      `failure-modes wrote ${other}, which is not one of its answer files`,
      "failure-modes called Agent",
      "failure-modes called SendMessage",
    ]);
  });
});

describe("finding the chair's transcript", () => {
  async function session(chairs) {
    const fixture = await deliberation();
    const config = tempDir("config-");
    const project = join(config, "projects", "-workspace");
    const subagents = join(project, "sid", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(project, "sid.jsonl"), "{}\n");
    const text = readFileSync(fixture.chairPath, "utf8");
    for (const name of chairs) {
      writeFileSync(join(subagents, `agent-${name}.jsonl`), text);
      writeFileSync(
        join(subagents, `agent-${name}.meta.json`),
        JSON.stringify({ agentType: "panel-chair" }),
      );
    }
    writeFileSync(join(subagents, "agent-other.jsonl"), text);
    writeFileSync(
      join(subagents, "agent-other.meta.json"),
      JSON.stringify({ agentType: "implementer" }),
    );
    for (const id of Object.values(fixture.ids)) {
      appendFileSync(
        join(subagents, `agent-${id}.jsonl`),
        readFileSync(join(fixture.subagents, `agent-${id}.jsonl`), "utf8"),
      );
    }
    return {
      ...fixture,
      env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "sid" },
      subagents,
    };
  }

  it("takes the one panel-chair transcript of the session that names the directory", async () => {
    const { dir, env, subagents } = await session(["chair"]);
    expect(run([dir], env).status).toBe(0);
    expect(recordOf(dir).chairTranscript).toBe(
      join(subagents, "agent-chair.jsonl"),
    );
  });

  it("runs no transcript check, and says so, when it cannot tell which chair", async () => {
    const { dir, env } = await session(["chair", "chair2"]);
    const result = run([dir], env);
    expect(result.status).toBe(1);
    expect(recordOf(dir).problems).toEqual([
      `2 panel-chair transcripts name ${dir}; name the chair's with --chair to run the transcript checks`,
    ]);
  });

  it("exits 2 on a usage error", () => {
    const dir = panelDir();
    expect(run([]).status).toBe(2);
    expect(run([dir, "--other", "x"]).status).toBe(2);
    expect(run([dir, "--chair"]).status).toBe(2);
    expect(run([dir, "--chair", join(dir, "missing.jsonl")]).status).toBe(2);
  });
});
