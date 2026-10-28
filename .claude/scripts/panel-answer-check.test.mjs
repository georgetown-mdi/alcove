import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { answerProblems, repeatedTopLevelKeys } from "./lib/panelAnswers.mjs";
import { checkAnswerFile } from "./panel-answer-check.mjs";

const SCRIPT = fileURLToPath(
  new URL("./panel-answer-check.mjs", import.meta.url),
);

const FIRST = {
  position: "fail closed",
  rationale: "the code",
  keyRisk: "a stall",
};
const LATER = { ...FIRST, changed: false, movedBy: "" };

const roots = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function panelDir() {
  const dir = mkdtempSync(join(tmpdir(), "panel-check-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "panel.json"),
    JSON.stringify({
      question: "Retry or fail closed?",
      base: "/tmp/base",
      seats: [
        "failure-modes",
        { name: "two-party-state", lens: "both parties" },
      ],
    }),
  );
  return dir;
}

const json = (value) => JSON.stringify(value);

describe("answerProblems", () => {
  it("passes a first-round answer with every field", () => {
    expect(answerProblems(json(FIRST), 1)).toEqual([]);
  });

  it("names each missing field", () => {
    expect(answerProblems(json({ position: "x" }), 1)).toEqual([
      "`rationale` missing",
      "`keyRisk` missing",
    ]);
  });

  it("names each empty field, blank text included", () => {
    expect(
      answerProblems(json({ ...FIRST, rationale: "", keyRisk: "  " }), 1),
    ).toEqual(["`rationale` empty or not text", "`keyRisk` empty or not text"]);
    expect(answerProblems(json({ ...FIRST, position: 3 }), 1)).toEqual([
      "`position` empty or not text",
    ]);
  });

  it("names a repeated field, which JSON.parse would keep silently", () => {
    const text =
      '{"position": "a", "rationale": "b", "keyRisk": "c", "position": "d"}';
    expect(answerProblems(text, 1)).toEqual(["`position` repeated"]);
  });

  it("reads only the top level for repeats", () => {
    expect(
      repeatedTopLevelKeys('{"a": {"a": 1, "b": [{"a": 2}]}, "b": "\\"a\\""}'),
    ).toEqual([]);
    expect(repeatedTopLevelKeys('{"a": {"x": 1}, "a": 2}')).toEqual(["a"]);
  });

  it("refuses text that is not one JSON object", () => {
    expect(answerProblems("POSITION: fail closed", 1)[0]).toMatch(/^not JSON/);
    expect(answerProblems("[]", 1)).toEqual(["not one JSON object"]);
    expect(answerProblems("null", 1)).toEqual(["not one JSON object"]);
  });

  it("refuses a field the round does not have", () => {
    expect(answerProblems(json({ ...FIRST, changed: false }), 1)).toEqual([
      "`changed` is not a field of a round 1 answer",
    ]);
    expect(answerProblems(json({ ...LATER, note: "x" }), 2)).toEqual([
      "`note` is not a field of a round 2 answer",
    ]);
  });

  it("requires `changed` and `movedBy` from round 2", () => {
    expect(answerProblems(json(FIRST), 2)).toEqual([
      "`changed` missing",
      "`movedBy` missing",
    ]);
    expect(answerProblems(json(LATER), 2)).toEqual([]);
    expect(answerProblems(json({ ...LATER, changed: "no" }), 3)).toEqual([
      "`changed` is not true or false",
    ]);
  });

  it("requires `movedBy` to name what moved a changed position", () => {
    expect(answerProblems(json({ ...LATER, changed: true }), 2)).toEqual([
      "`movedBy` empty while `changed` is true: name the argument and the seat that moved you",
    ]);
    expect(
      answerProblems(
        json({ ...LATER, changed: true, movedBy: "failure-modes: the stall" }),
        2,
      ),
    ).toEqual([]);
  });
});

describe("checkAnswerFile", () => {
  it("records the hash of a passing file and nothing for a failing one", () => {
    const dir = panelDir();
    writeFileSync(join(dir, "failure-modes-r1.json"), json(FIRST));
    writeFileSync(
      join(dir, "two-party-state-r1.json"),
      json({ position: "x" }),
    );
    expect(checkAnswerFile(join(dir, "failure-modes-r1.json"))).toEqual({
      ok: true,
    });
    expect(checkAnswerFile(join(dir, "two-party-state-r1.json")).ok).toBe(
      false,
    );
    const log = readFileSync(join(dir, "written.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]).file).toBe("failure-modes-r1.json");
  });

  it("refuses a file that is not a seat's answer in a panel directory", () => {
    const dir = panelDir();
    expect(() => checkAnswerFile(join(dir, "answer.json"))).toThrow(
      /<seat>-r<N>\.json/,
    );
    expect(() => checkAnswerFile(join(dir, "pragmatics-r1.json"))).toThrow(
      /not one of this panel's/,
    );
    const bare = mkdtempSync(join(tmpdir(), "panel-check-bare-"));
    roots.push(bare);
    expect(() => checkAnswerFile(join(bare, "failure-modes-r1.json"))).toThrow(
      /panel\.json does not exist/,
    );
  });
});

describe("panel-answer-check.mjs", () => {
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("prints ok and exits 0 on a pass, FAIL with the reasons and 1 on a failure", () => {
    const dir = panelDir();
    const good = join(dir, "failure-modes-r2.json");
    const bad = join(dir, "two-party-state-r2.json");
    writeFileSync(good, json(LATER));
    writeFileSync(bad, json(FIRST));
    expect(run(good)).toMatchObject({ status: 0, stdout: `ok ${good}\n` });
    expect(run(bad)).toMatchObject({
      status: 1,
      stdout: `FAIL ${bad}: \`changed\` missing; \`movedBy\` missing\n`,
    });
  });

  it("exits 2 on a usage error", () => {
    expect(run().status).toBe(2);
    expect(run("--help").status).toBe(2);
    expect(run(join(panelDir(), "notes.json")).status).toBe(2);
  });
});
