import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  BASE,
  QUESTION,
  SEATS,
  STATED,
  answer,
  panelDir,
  removeFixtures,
  writeAnswer,
} from "./lib/panelFixture.mjs";
import {
  loadPanel,
  messageFor,
  nextStep,
  retryFor,
  roundRefusal,
  seatsAsked,
} from "./panel-relay.mjs";

const SCRIPT = fileURLToPath(new URL("./panel-relay.mjs", import.meta.url));
const WORKFLOW = fileURLToPath(
  new URL("./panel-workflow.mjs", import.meta.url),
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

afterAll(removeFixtures);

const NAMES = ["failure-modes", "design-ux", "two-party-state"];
const CHECK = `node ${BASE}/.claude/scripts/panel-answer-check.mjs`;

// The briefing tells a panelist to read only under the base and run nothing;
// the answer directory is the stated exception to it.
const exception = (dir) =>
  `The briefing's rule to read only under ${BASE} and run no builds or tests has one exception, this panel's answer directory ${dir}: you write your own answer file there, read the other panelists' answers there when a round names them, and run the answer-check script below.`;

// The prompt the panel Workflow gives each seat, driven here on its own, so
// round 1's text is held to the Workflow's briefing rather than to the relay's
// reading of it.
async function workflowPromptsBySeat() {
  const body = readFileSync(WORKFLOW, "utf8").replace(
    /^export const meta =/m,
    "const meta =",
  );
  const prompts = {};
  await new AsyncFunction("args", "agent", "parallel", body)(
    { question: QUESTION, base: BASE, docs: ["docs/DESIGN.md"], seats: SEATS },
    (prompt, options) => {
      prompts[options.label.replace(/^panelist: /, "")] = prompt;
      return null;
    },
    (thunks) => Promise.all(thunks.map((thunk) => thunk())),
  );
  return prompts;
}

/** A panel whose first round every seat answered. */
function afterFirstRound(extra) {
  const dir = panelDir(extra);
  for (const seat of NAMES) writeAnswer(dir, seat, 1);
  return dir;
}

describe("round 1 text", () => {
  it("is the panel Workflow's own prompt for the seat, then where to write the answer", async () => {
    const dir = panelDir();
    const state = await loadPanel(dir);
    const prompts = await workflowPromptsBySeat();
    for (const seat of NAMES) {
      const path = join(dir, `${seat}-r1.json`);
      const text = messageFor(state, seat, 1);
      expect(text.startsWith(`${prompts[seat]}\n\n`), seat).toBe(true);
      const clause = text.slice(prompts[seat].length + 2);
      expect(clause.startsWith(exception(dir)), seat).toBe(true);
      expect(clause).toContain(
        "exactly the keys `position`, `rationale` and `keyRisk`",
      );
      expect(clause).toContain(`to ${path}, and write no other file`);
      expect(clause).toContain(`\`${CHECK} ${path}\``);
      expect(clause).toContain(`\`WROTE ${path}\``);
      expect(clause).not.toContain("changed");
    }
    expect(messageFor(state, STATED.name, 1)).toContain(STATED.lens);
    expect(messageFor(state, "failure-modes", 1)).toContain(QUESTION);
  });

  it("asks every seat, and no seat but the panel's", async () => {
    const state = await loadPanel(panelDir());
    expect(seatsAsked(state, 1)).toEqual(NAMES);
    expect(() => messageFor(state, "pragmatics", 1)).toThrow(
      /not asked in round 1/,
    );
  });

  it("refuses what the panel Workflow refuses", async () => {
    await expect(
      loadPanel(panelDir({ seats: ["failure-modes"] })),
    ).rejects.toThrow(/at least two seats/);
    await expect(loadPanel(panelDir({ base: "tmp/base" }))).rejects.toThrow(
      /base is the absolute path/,
    );
    await expect(
      loadPanel(
        panelDir({ seats: ["failure-modes", { name: "a/b", lens: "x" }] }),
      ),
    ).rejects.toThrow(/letters, digits and hyphens/);
    await expect(
      loadPanel(
        panelDir({ seats: ["failure-modes", { name: "next", lens: "x" }] }),
      ),
    ).rejects.toThrow(/cannot name a seat/);
    await expect(loadPanel(panelDir({ extraRounds: 0 }))).rejects.toThrow(
      /extraRounds/,
    );
  });

  it("accepts any whole number of extra rounds from 1 up, and names no upper bound", async () => {
    expect((await loadPanel(panelDir({ extraRounds: 6 }))).extraRounds).toBe(6);
    expect((await loadPanel(panelDir({ extraRounds: 50 }))).extraRounds).toBe(
      50,
    );
    for (const bad of [0, -1, 1.5, "3"]) {
      await expect(loadPanel(panelDir({ extraRounds: bad }))).rejects.toThrow(
        /whole number of at least 1/,
      );
    }
  });
});

describe("later round text", () => {
  it("names the seat's own latest answer and the others' with their lenses, and nothing of their content", async () => {
    const dir = afterFirstRound();
    const state = await loadPanel(dir);
    const text = messageFor(state, "design-ux", 2);
    expect(text).toMatch(/^Round 2 of the panel\. Your latest answer is /);
    expect(text).toContain(
      `Your latest answer is ${join(dir, "design-ux-r1.json")}.`,
    );
    expect(text).toContain(
      `- ${join(dir, "failure-modes-r1.json")} -- correctness and failure modes`,
    );
    expect(text).toContain(
      `- ${join(dir, "two-party-state-r1.json")} -- ${STATED.lens}`,
    );
    expect(text).not.toContain(`- ${join(dir, "design-ux-r1.json")}`);
    expect(text).not.toContain("position of");
    expect(text).not.toContain(QUESTION);
    expect(text).toContain(
      "exactly the keys `position`, `rationale`, `keyRisk`, `changed` and `movedBy`",
    );
    expect(text).toContain("do not split the difference");
    expect(text).toContain(exception(dir));
    expect(text).toContain(`\`WROTE ${join(dir, "design-ux-r2.json")}\``);
  });

  it("points each seat at the latest answer of every seat, skipping a round a seat missed", async () => {
    const dir = afterFirstRound();
    writeAnswer(
      dir,
      "failure-modes",
      2,
      answer("failure-modes", 2, {
        changed: true,
        movedBy: "design-ux: the copy",
      }),
    );
    writeAnswer(dir, "design-ux", 2);
    const state = await loadPanel(dir);
    const text = messageFor(state, "design-ux", 3);
    expect(text).toContain(
      `Your latest answer is ${join(dir, "design-ux-r2.json")}.`,
    );
    expect(text).toContain(join(dir, "failure-modes-r2.json"));
    expect(text).toContain(join(dir, "two-party-state-r1.json"));
    expect(text).not.toContain("failure-modes-r1.json");
  });

  it("reads the same while its own round is being answered", async () => {
    const dir = afterFirstRound();
    const before = messageFor(await loadPanel(dir), "two-party-state", 2);
    writeAnswer(dir, "failure-modes", 2);
    expect(messageFor(await loadPanel(dir), "two-party-state", 2)).toBe(before);
  });

  it("asks only seats with an answer to revise, and takes a failing file as no answer", async () => {
    const dir = panelDir();
    writeAnswer(dir, "failure-modes", 1);
    writeAnswer(dir, "design-ux", 1);
    writeFileSync(join(dir, "two-party-state-r1.json"), '{"position": "x"}');
    const state = await loadPanel(dir);
    expect(seatsAsked(state, 2)).toEqual(["failure-modes", "design-ux"]);
    expect(() => messageFor(state, "two-party-state", 2)).toThrow(
      /no answer to revise/,
    );
    expect(messageFor(state, "failure-modes", 2)).not.toContain(
      "two-party-state",
    );
  });

  it("names the owner's input for the round when there is one", async () => {
    const dir = afterFirstRound();
    writeFileSync(join(dir, "input-r2.md"), "A new fact.");
    const text = messageFor(await loadPanel(dir), "failure-modes", 2);
    expect(text).toContain(
      `The owner has added input for this round: read ${join(dir, "input-r2.md")} first.`,
    );
  });

  it("re-asks for a failing file by its path alone", async () => {
    const dir = panelDir();
    const state = await loadPanel(dir);
    const path = join(dir, "design-ux-r3.json");
    expect(retryFor(state, "design-ux", 3)).toBe(
      `Your answer file ${path} does not pass the check. Run \`${CHECK} ${path}\`, fix what it reports, and reply with the one line \`WROTE ${path}\`.`,
    );
    expect(() => retryFor(state, "pragmatics", 1)).toThrow(
      /not one of this panel's/,
    );
  });
});

describe("when the panel stops", () => {
  it("runs round 2 after the first round, whatever it answered", async () => {
    const state = await loadPanel(afterFirstRound());
    expect(roundRefusal(state, 2)).toBeNull();
    expect(nextStep(state)).toBe("round 2");
  });

  it("starts with round 1 and refuses a round whose previous round has no answers", async () => {
    const state = await loadPanel(panelDir());
    expect(nextStep(state)).toBe("round 1");
    expect(roundRefusal(state, 2)).toBe("round 1 has no answers");
  });

  it("stops once every answer of a round kept its position", async () => {
    const dir = afterFirstRound();
    for (const seat of NAMES) writeAnswer(dir, seat, 2);
    const state = await loadPanel(dir);
    expect(nextStep(state)).toBe(
      "stop unchanged: every answer of round 2 kept its position",
    );
  });

  it("goes on while any seat changed, and stops at the cap", async () => {
    const dir = afterFirstRound();
    const moved = { changed: true, movedBy: "failure-modes: the stall" };
    for (const round of [2, 3]) {
      writeAnswer(dir, "design-ux", round, answer("design-ux", round, moved));
      writeAnswer(dir, "failure-modes", round);
      if (round === 2) expect(nextStep(await loadPanel(dir))).toBe("round 3");
    }
    expect(nextStep(await loadPanel(dir))).toBe(
      "stop cap: round 3 was the last of 2 after round 1",
    );
  });

  it("takes the cap panel.json states", async () => {
    const dir = afterFirstRound({ extraRounds: 1 });
    writeAnswer(
      dir,
      "design-ux",
      2,
      answer("design-ux", 2, { changed: true, movedBy: "x" }),
    );
    expect(nextStep(await loadPanel(dir))).toBe(
      "stop cap: round 2 was the last of 1 after round 1",
    );
  });

  it("starts again for new input, with the cap counted from the input round", async () => {
    const dir = afterFirstRound();
    for (const seat of NAMES) writeAnswer(dir, seat, 2);
    writeFileSync(join(dir, "input-r3.md"), "A new fact.");
    expect(nextStep(await loadPanel(dir))).toBe("round 3");
    const moved = { changed: true, movedBy: "the owner's input" };
    for (const round of [3, 4, 5]) {
      writeAnswer(
        dir,
        "failure-modes",
        round,
        answer("failure-modes", round, moved),
      );
    }
    const state = await loadPanel(dir);
    expect(roundRefusal(state, 5)).toBeNull();
    expect(nextStep(state)).toBe(
      "stop cap: round 5 was the last of 2 after round 3",
    );
  });
});

describe("panel-relay.mjs", () => {
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("prints a seat's text, the seats of a round, and the next step", async () => {
    const dir = afterFirstRound();
    const state = await loadPanel(dir);
    expect(run(dir, "next").stdout).toBe("round 2\n");
    expect(run(dir, "seats", "2").stdout).toBe(`${NAMES.join("\n")}\n`);
    expect(run(dir, "design-ux", "2")).toMatchObject({
      status: 0,
      stdout: `${messageFor(state, "design-ux", 2)}\n`,
    });
    expect(run(dir, "design-ux", "2", "--retry").stdout).toBe(
      `${retryFor(state, "design-ux", 2)}\n`,
    );
  });

  it("refuses a round past a stop with exit 1", () => {
    const dir = afterFirstRound();
    for (const seat of NAMES) writeAnswer(dir, seat, 2);
    const result = run(dir, "design-ux", "3");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^Round 3 does not run: unchanged/);
    expect(run(dir, "pragmatics", "1").status).toBe(1);
  });

  /** Print every asked seat's message for `round`, as the chair does. */
  const sendRound = (dir, round) => {
    for (const seat of run(dir, "seats", String(round))
      .stdout.split("\n")
      .filter(Boolean)) {
      expect(run(dir, seat, String(round)).status).toBe(0);
    }
  };

  it("stops at the next `next` when no seat wrote an answer file for a round it sent", () => {
    const dir = afterFirstRound();
    expect(run(dir, "next").stdout).toBe("round 2\n");
    expect(run(dir, "next").stdout).toBe("round 2\n");
    sendRound(dir, 2);
    expect(run(dir, "next")).toMatchObject({
      status: 0,
      stdout:
        "stop empty: round 2 was sent to failure-modes, design-ux, two-party-state and no seat wrote an answer file\n",
    });
  });

  it("names only the seats sent in an empty round", () => {
    const dir = afterFirstRound();
    sendRound(dir, 2);
    writeAnswer(
      dir,
      "design-ux",
      2,
      answer("design-ux", 2, { changed: true, movedBy: "failure-modes: x" }),
    );
    expect(run(dir, "next").stdout).toBe("round 3\n");
    run(dir, "design-ux", "3");
    expect(run(dir, "next").stdout).toBe(
      "stop empty: round 3 was sent to design-ux and no seat wrote an answer file\n",
    );
  });

  it("moves on, and stops at the cap, when only some seats of a sent round answer", () => {
    const dir = afterFirstRound();
    const moved = { changed: true, movedBy: "failure-modes: the stall" };
    for (const round of [2, 3]) {
      sendRound(dir, round);
      writeAnswer(dir, "design-ux", round, answer("design-ux", round, moved));
      if (round === 2) {
        expect(run(dir, "next").stdout).toBe("round 3\n");
        expect(run(dir, "seats", "3").stdout).toBe(`${NAMES.join("\n")}\n`);
      }
    }
    expect(run(dir, "next").stdout).toBe(
      "stop cap: round 3 was the last of 2 after round 1\n",
    );
  });

  it("records no round for a re-ask", () => {
    const dir = afterFirstRound();
    expect(run(dir, "design-ux", "2", "--retry").status).toBe(0);
    expect(run(dir, "next").stdout).toBe("round 2\n");
  });

  it("exits 2 on a usage error or a directory with no panel", () => {
    const dir = panelDir();
    expect(run().status).toBe(2);
    expect(run(dir).status).toBe(2);
    expect(run(dir, "design-ux", "0").status).toBe(2);
    expect(run(dir, "design-ux", "2", "--other").status).toBe(2);
    expect(run(join(dir, "missing"), "next").status).toBe(2);
  });
});
