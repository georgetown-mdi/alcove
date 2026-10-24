import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsBlocks } from "../../scripts/lib/markdownFences.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMAND = ".claude/commands/docket.md";
const SCRIPT = ".claude/scripts/judgment-call-controversy-workflow.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The checked-in script the command invokes by path IS the artifact under test.
// It is a Workflow script body rather than a module, so compile it into a
// function of the names the Workflow runtime injects; `export const meta` is the
// one module-only spelling in it, and the top-level `return` is legal in a
// function body.
function compileScript() {
  const body = readFileSync(resolve(root, SCRIPT), "utf8").replace(
    /^export const meta =/m,
    "const meta =",
  );
  return new AsyncFunction("args", "agent", "parallel", "pipeline", body);
}

const script = compileScript();
const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()));
// Each item runs through every stage in turn, a later stage taking the earlier
// stage's result and the item. The results come back in reverse order, so a
// script that pairs a result with its session by position is caught.
const pipeline = async (items, first, ...rest) => {
  const results = await Promise.all(
    items.map(async (item) => {
      let value = await first(item);
      for (const stage of rest) value = await stage(value, item);
      return value;
    }),
  );
  return results.reverse();
};
const runner = (deliver) => (args, respond) =>
  script(deliver(args), respond, parallel, pipeline);

// The harness may deliver the arguments as JSON text rather than as the object
// the caller passed, so every case below runs under both shapes.
const SHAPES = [
  { shape: "object", deliver: (args) => args },
  { shape: "string", deliver: (args) => JSON.stringify(args) },
];

const SINCE = "2026-10-20T18:00Z";
const SESSION_ONE = {
  name: "relay session",
  prs: ["#2391", "#2392"],
  sources: ["scratch/relay/STATE.md"],
  notes: "Owner rulings are quoted in scratch/relay/STATE.md.",
};
const SESSION_TWO = {
  name: "keys session",
  prs: [],
  sources: ["scratch/keys/STATE.md"],
};
const CLOSING = [
  "Ratify the re-scope of the relay item to steps 1 and 2.",
  "Count the security rounds in the trial's cost.",
];

const call = (id, decided = `decided ${id}`) => ({
  id,
  pr: "#2391",
  decided,
  alternative: "the other choice",
  userEffect: "operators see a change",
  source: "PR body, Out of scope",
});
const found = (calls, extra = {}) => ({
  calls,
  excludedAsRuled: [],
  skippedPrs: [],
  ...extra,
});
const verdict = (id, value) => ({
  id,
  verdict: value,
  reason: `${value} because`,
  evidence: "docs/CONSOLE.md",
  betterChoice: value === "uncontroversial" ? "none" : "ask the owner",
});

// A stub agent: gatherers answer from `gather`, keyed by session letter; each
// lens answers from `judge`, keyed by "<letter>:<lens>", with a map of call id
// to verdict. A key set to null stands for an agent whose structured-output
// retries ran out.
function stub({ gather = {}, judge = {} }) {
  const spawned = [];
  const respond = (prompt, options) => {
    spawned.push({ prompt, options });
    const [kind, key, lens] = options.label.split(":");
    if (kind === "gather") {
      return Object.hasOwn(gather, key) ? gather[key] : found([]);
    }
    const answer = judge[`${key}:${lens}`];
    if (answer === null) return Promise.resolve(null);
    return Promise.resolve({
      verdicts: Object.entries(answer ?? {}).map(([id, value]) =>
        verdict(id, value),
      ),
    });
  };
  return { spawned, respond };
}

const judged = (key, product, trust = product) => ({
  [`${key}:product`]: product,
  [`${key}:trust`]: trust,
});

describe("judgment-call-controversy command wiring", () => {
  it("is invoked by the docket command, which has no script of its own", () => {
    const command = readFileSync(resolve(root, COMMAND), "utf8");
    expect(command).toContain(SCRIPT);
    expect(jsBlocks(command)).toEqual([]);
  });

  // The Workflow tool refuses at launch a script whose body loads a module.
  it("loads no module, so the Workflow tool will launch it", () => {
    const body = readFileSync(resolve(root, SCRIPT), "utf8");
    expect(body).not.toMatch(/^\s*import\s/m);
    expect(body).not.toContain("import(");
    expect(body).not.toContain("require(");
  });
});

const UNRESOLVABLE = [[], 42, "text", true, null, undefined];
const mustNotSpawn = () => {
  throw new Error("must not spawn");
};

describe.each(SHAPES)("argument checks ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("refuses a delivery that is not an object of named arguments", async () => {
    for (const delivered of UNRESOLVABLE) {
      await expect(
        run(delivered, mustNotSpawn),
        JSON.stringify(delivered),
      ).rejects.toThrow(
        /expected an object of named arguments, or the JSON text of one/,
      );
    }
  });

  it("refuses arguments it cannot run on", async () => {
    const base = { since: SINCE, sessions: [SESSION_ONE], closingList: [] };
    const refused = [
      [{ since: undefined }, /since is the date and time of the last docket/],
      [{ since: "  " }, /since is the date and time of the last docket/],
      [{ sessions: undefined }, /sessions is the list of sessions/],
      [{ sessions: SESSION_ONE }, /sessions is the list of sessions/],
      [{ sessions: ["relay session"] }, /with a non-empty name/],
      [{ sessions: [{ ...SESSION_ONE, name: " " }] }, /with a non-empty name/],
      [
        { sessions: [{ ...SESSION_ONE, prs: "#2391" }] },
        /The prs of session "relay session" is a list of non-empty strings/,
      ],
      [
        { sessions: [{ ...SESSION_ONE, sources: undefined }] },
        /The sources of session "relay session" is a list/,
      ],
      [
        { sessions: [{ ...SESSION_ONE, prs: [], sources: [] }] },
        /names no pull request and no source file/,
      ],
      [
        { sessions: [{ ...SESSION_ONE, notes: ["a note"] }] },
        /notes of session "relay session" are text/,
      ],
      [{ sessions: [SESSION_ONE, SESSION_ONE] }, /is named twice/],
      [{ closingList: undefined }, /closingList is the session's own/],
      [{ closingList: "a line" }, /closingList is a list of non-empty/],
      [{ closingList: ["a line", ""] }, /closingList is a list of non-empty/],
      [{ sessions: [], closingList: [] }, /There is nothing to judge/],
    ];
    for (const [change, message] of refused) {
      const delivered = { ...base, ...change };
      for (const key of Object.keys(change)) {
        if (change[key] === undefined) delete delivered[key];
      }
      await expect(
        run(delivered, mustNotSpawn),
        JSON.stringify(change),
      ).rejects.toThrow(message);
    }
  });
});

describe.each(SHAPES)("scoring ($shape args)", ({ deliver }) => {
  const run = runner(deliver);
  const args = {
    since: SINCE,
    sessions: [SESSION_ONE, SESSION_TWO],
    closingList: CLOSING,
  };

  it("gathers each session on Sonnet and judges its calls and the closing list with two Opus lenses", async () => {
    const { spawned, respond } = stub({
      gather: {
        A: found([call("A1")]),
        B: found([call("B1")]),
      },
      judge: {
        ...judged("A", { A1: "uncontroversial" }),
        ...judged("B", { B1: "uncontroversial" }),
        ...judged("CL", { CL1: "uncontroversial", CL2: "uncontroversial" }),
      },
    });
    await run(args, respond);
    const labels = spawned.map(({ options }) => options.label).sort();
    expect(labels).toEqual(
      [
        "gather:A",
        "gather:B",
        "judge:A:product",
        "judge:A:trust",
        "judge:B:product",
        "judge:B:trust",
        "judge:CL:product",
        "judge:CL:trust",
      ].sort(),
    );
    for (const { prompt, options } of spawned) {
      const gatherer = options.label.startsWith("gather:");
      expect(options.model, options.label).toBe(gatherer ? "sonnet" : "opus");
      expect(options.effort, options.label).toBe(gatherer ? "medium" : "high");
      for (const key of options.schema.required) {
        expect(prompt, options.label).toContain(`\`${key}\``);
      }
      expect(prompt, options.label).not.toContain("undefined");
    }
  });

  it("asks each gatherer for its own session's calls since the last docket", async () => {
    const { spawned, respond } = stub({});
    await run(args, respond);
    const prompt = (label) =>
      spawned.find(({ options }) => options.label === label).prompt;
    const one = prompt("gather:A");
    expect(one).toContain(`"relay session"`);
    expect(one).toContain(SINCE);
    expect(one).toContain("#2391, #2392");
    expect(one).toContain("gh pr view");
    expect(one).toContain("scratch/relay/STATE.md");
    expect(one).toContain(SESSION_ONE.notes);
    expect(one).toContain('Ids: "A1", "A2"');
    const two = prompt("gather:B");
    expect(two).toContain(`"keys session"`);
    expect(two).toContain("scratch/keys/STATE.md");
    expect(two).not.toContain("gh pr view");
    expect(two).not.toContain("relay");
    expect(two).toContain('Ids: "B1", "B2"');
  });

  it("hands the closing list to the lenses as written, with no gatherer", async () => {
    const { spawned, respond } = stub({});
    await run({ ...args, sessions: [] }, respond);
    expect(spawned.map(({ options }) => options.label).sort()).toEqual([
      "judge:CL:product",
      "judge:CL:trust",
    ]);
    for (const { prompt } of spawned) {
      for (const line of CLOSING) expect(prompt).toContain(line);
      expect(prompt).toContain('"id": "CL1"');
      expect(prompt).toContain('"id": "CL2"');
    }
  });

  it("presents a line either lens flags, ranked by score, and leaves standing a line both lenses call uncontroversial", async () => {
    const { respond } = stub({
      gather: {
        A: found([call("A1"), call("A2"), call("A3"), call("A4")]),
      },
      judge: judged(
        "A",
        {
          A1: "uncontroversial",
          A2: "worth-a-look",
          A3: "uncontroversial",
          A4: "controversial",
        },
        {
          A1: "uncontroversial",
          A2: "uncontroversial",
          A3: "controversial",
          A4: "controversial",
        },
      ),
    });
    const result = await run(
      { since: SINCE, sessions: [SESSION_ONE], closingList: [] },
      respond,
    );
    const [session] = result.sessions;
    expect(session.name).toBe("relay session");
    expect(session.presented.map((row) => [row.id, row.score])).toEqual([
      ["A4", 4],
      ["A3", 2],
      ["A2", 1],
    ]);
    expect(session.standing.map((row) => row.id)).toEqual(["A1"]);
    expect(session.presented[0].decided).toBe("decided A4");
    expect(session.presented[2].verdicts.product.verdict).toBe("worth-a-look");
    expect(session.presented[2].verdicts.trust.reason).toBe(
      "uncontroversial because",
    );
    expect(result.problems).toEqual([]);
  });

  it("filters the closing list the same way", async () => {
    const { respond } = stub({
      judge: judged(
        "CL",
        { CL1: "uncontroversial", CL2: "uncontroversial" },
        { CL1: "uncontroversial", CL2: "worth-a-look" },
      ),
    });
    const result = await run({ ...args, sessions: [] }, respond);
    expect(result.closingList.presented).toEqual([
      expect.objectContaining({ id: "CL2", line: CLOSING[1], score: 1 }),
    ]);
    expect(result.closingList.standing).toEqual([
      expect.objectContaining({ id: "CL1", line: CLOSING[0], score: 0 }),
    ]);
  });

  it("presents nothing from a closing list both lenses call uncontroversial", async () => {
    const { respond } = stub({
      judge: judged("CL", { CL1: "uncontroversial", CL2: "uncontroversial" }),
    });
    const result = await run({ ...args, sessions: [] }, respond);
    expect(result.closingList.presented).toEqual([]);
    expect(result.closingList.standing.map((row) => row.id)).toEqual([
      "CL1",
      "CL2",
    ]);
  });

  it("breaks the result out by session, in the order the sessions were given", async () => {
    const { respond } = stub({
      gather: {
        A: found([call("A1")], {
          excludedAsRuled: ["the relay default, ruled 2026-10-15"],
          skippedPrs: ["#2392"],
        }),
        B: found([call("B1"), call("B2")]),
      },
      judge: {
        ...judged("A", { A1: "controversial" }),
        ...judged("B", { B1: "uncontroversial", B2: "worth-a-look" }),
        ...judged("CL", { CL1: "uncontroversial", CL2: "uncontroversial" }),
      },
    });
    const result = await run(args, respond);
    expect(result.since).toBe(SINCE);
    expect(result.sessions.map((s) => [s.name, s.key])).toEqual([
      ["relay session", "A"],
      ["keys session", "B"],
    ]);
    expect(result.sessions[0].presented.map((row) => row.id)).toEqual(["A1"]);
    expect(result.sessions[0].excludedAsRuled).toEqual([
      "the relay default, ruled 2026-10-15",
    ]);
    expect(result.sessions[0].skippedPrs).toEqual(["#2392"]);
    expect(result.sessions[1].presented.map((row) => row.id)).toEqual(["B2"]);
    expect(result.sessions[1].standing.map((row) => row.id)).toEqual(["B1"]);
    expect(result.counts).toEqual({
      judged: 5,
      presented: 2,
      standing: 3,
      excludedAsRuled: 1,
    });
  });

  it("spawns no lens for a session with no calls", async () => {
    const { spawned, respond } = stub({
      gather: { A: found([]) },
      judge: judged("CL", { CL1: "uncontroversial", CL2: "uncontroversial" }),
    });
    const result = await run(
      { since: SINCE, sessions: [SESSION_ONE], closingList: CLOSING },
      respond,
    );
    expect(
      spawned.filter(({ options }) => options.label.startsWith("judge:A:")),
    ).toEqual([]);
    expect(result.sessions[0].presented).toEqual([]);
    expect(result.sessions[0].standing).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("reports a session whose gatherer returned nothing, and judges the others", async () => {
    const { respond } = stub({
      gather: { A: null, B: found([call("B1")]) },
      judge: {
        ...judged("B", { B1: "worth-a-look" }),
        ...judged("CL", { CL1: "uncontroversial", CL2: "uncontroversial" }),
      },
    });
    const result = await run(args, respond);
    expect(result.sessions[0]).toEqual({
      name: "relay session",
      key: "A",
      presented: [],
      standing: [],
      excludedAsRuled: [],
      skippedPrs: [],
    });
    expect(result.sessions[1].presented.map((row) => row.id)).toEqual(["B1"]);
    expect(result.problems).toEqual([
      expect.stringMatching(
        /^Session "relay session": the gatherer returned no structured result/,
      ),
    ]);
  });

  it("presents every line of a batch a lens returned nothing for", async () => {
    const { respond } = stub({
      gather: { A: found([call("A1"), call("A2")]) },
      judge: {
        "A:product": null,
        "A:trust": { A1: "uncontroversial", A2: "controversial" },
      },
    });
    const result = await run(
      { since: SINCE, sessions: [SESSION_ONE], closingList: [] },
      respond,
    );
    expect(
      result.sessions[0].presented.map((row) => [row.id, row.score]),
    ).toEqual([
      ["A2", 2],
      ["A1", 0],
    ]);
    expect(result.sessions[0].presented[1].verdicts.product).toBeNull();
    expect(result.sessions[0].standing).toEqual([]);
    expect(result.problems).toEqual([
      expect.stringMatching(
        /^Session "relay session": the product lens returned no structured result, so every line is presented/,
      ),
    ]);
  });

  it("presents a line a lens left without a verdict", async () => {
    const { respond } = stub({
      judge: judged(
        "CL",
        { CL1: "uncontroversial", CL2: "uncontroversial" },
        { CL1: "uncontroversial" },
      ),
    });
    const result = await run({ ...args, sessions: [] }, respond);
    expect(result.closingList.presented.map((row) => row.id)).toEqual(["CL2"]);
    expect(result.closingList.standing.map((row) => row.id)).toEqual(["CL1"]);
    expect(result.problems).toEqual([
      "The closing list: the trust lens returned no verdict for CL2, so those lines are presented.",
    ]);
  });

  it("ignores a verdict for an id it did not ask about", async () => {
    const { respond } = stub({
      judge: judged(
        "CL",
        {
          CL1: "uncontroversial",
          CL2: "uncontroversial",
          CL9: "controversial",
        },
        { CL1: "uncontroversial", CL2: "uncontroversial" },
      ),
    });
    const result = await run({ ...args, sessions: [] }, respond);
    expect(result.closingList.presented).toEqual([]);
    expect(result.closingList.standing.map((row) => row.id)).toEqual([
      "CL1",
      "CL2",
    ]);
    expect(result.problems).toEqual([]);
  });
});
