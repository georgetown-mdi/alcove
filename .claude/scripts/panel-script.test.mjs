import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsBlocks } from "../../scripts/lib/markdownFences.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMAND = ".claude/commands/panel.md";
const SCRIPT = ".claude/scripts/panel-workflow.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The checked-in script the command invokes by path IS the artifact under test.
// It is a Workflow script body rather than a module, so compile it into a
// function of the three names the Workflow runtime injects; `export const meta`
// is the one module-only spelling in it, and the top-level `return` is legal in
// a function body.
function compileScript() {
  const body = readFileSync(resolve(root, SCRIPT), "utf8").replace(
    /^export const meta =/m,
    "const meta =",
  );
  return new AsyncFunction("args", "agent", "parallel", body);
}

const script = compileScript();
const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()));
const runner = (deliver) => (args, respond) =>
  script(deliver(args), respond, parallel);

// The harness may deliver the arguments as JSON text rather than as the object
// the caller passed, so every case below runs under both shapes: a script that
// reads only one of them convenes the panel on the literal text "undefined".
const SHAPES = [
  { shape: "object", deliver: (args) => args },
  { shape: "string", deliver: (args) => JSON.stringify(args) },
];

const QUESTION = "Should the adapter retry a stalled transfer or fail closed?";
const answer = (position) => ({
  position,
  rationale: "what the code showed",
  keyRisk: "the other reading",
});

describe("panel command wiring", () => {
  it("invokes the script this file tests, and has no script of its own", () => {
    const command = readFileSync(resolve(root, COMMAND), "utf8");
    expect(command).toContain(SCRIPT);
    expect(jsBlocks(command)).toEqual([]);
  });
});

// Every delivery that is not an object of named arguments, and so resolves no
// field the panel needs. Tolerating one convenes the panel on the literal text
// "undefined" rather than stopping.
const UNRESOLVABLE = [[], 42, "text", true, null, undefined];

describe.each(SHAPES)("panel argument shape ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("refuses a delivery that is not an object of named arguments", async () => {
    for (const delivered of UNRESOLVABLE) {
      await expect(
        run(delivered, () => {
          throw new Error("must not spawn");
        }),
        JSON.stringify(delivered),
      ).rejects.toThrow(
        /expected an object of named arguments, or the JSON text of one/,
      );
    }
  });

  it("resolves an object of named arguments and convenes the panel", async () => {
    const result = await run({ question: QUESTION, docs: [] }, () =>
      answer("fail closed"),
    );
    expect(result.positions).toHaveLength(3);
  });
});

describe.each(SHAPES)("panel ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("asks every panelist the question it was convened on", async () => {
    const asked = [];
    const result = await run({ question: QUESTION, docs: [] }, (prompt) => {
      asked.push(prompt);
      return answer("fail closed");
    });
    expect(asked).toHaveLength(3);
    for (const prompt of asked) {
      expect(prompt).toContain(QUESTION);
      expect(prompt).not.toContain("undefined");
    }
    expect(result.positions).toHaveLength(3);
  });

  it("names every top-level key of the panelist schema in its prompt", async () => {
    const spawned = [];
    await run({ question: QUESTION, docs: [] }, (prompt, options) => {
      spawned.push({ prompt, options });
      return answer("fail closed");
    });
    expect(spawned).toHaveLength(3);
    for (const { prompt, options } of spawned) {
      expect(options.schema.required).toEqual([
        "position",
        "rationale",
        "keyRisk",
      ]);
      for (const key of options.schema.required) {
        expect(prompt, options.label).toContain(`\`${key}\``);
      }
    }
  });

  it("weighs each panelist through its own lens", async () => {
    const lenses = [];
    await run({ question: QUESTION, docs: [] }, (prompt, options) => {
      lenses.push(options.label);
      return answer("fail closed");
    });
    expect(lenses).toEqual([
      "panelist: failure-modes",
      "panelist: architecture",
      "panelist: pragmatics",
    ]);
  });

  it("points the docs it was given at the panel base checkout", async () => {
    const asked = [];
    await run(
      {
        question: QUESTION,
        docs: ["docs/spec/FILE_SYNC.md", "docs/DESIGN.md"],
      },
      (prompt) => {
        asked.push(prompt);
        return answer("fail closed");
      },
    );
    for (const prompt of asked) {
      expect(prompt).toContain(
        "Read these first for context: /tmp/panel-base/docs/spec/FILE_SYNC.md, /tmp/panel-base/docs/DESIGN.md",
      );
    }
  });

  it("says nothing about docs when it was given none", async () => {
    const asked = [];
    await run({ question: QUESTION, docs: [] }, (prompt) => {
      asked.push(prompt);
      return answer("fail closed");
    });
    for (const prompt of asked) {
      expect(prompt).not.toContain("Read these first for context");
    }
  });

  it("drops a panelist that exhausted its schema retries", async () => {
    const result = await run(
      { question: QUESTION, docs: [] },
      (prompt, options) =>
        options.label === "panelist: pragmatics" ? null : answer("fail closed"),
    );
    expect(result.positions.map((p) => p.seat)).toEqual([
      "failure-modes",
      "architecture",
    ]);
  });
});

const NAMED_SEATS = [
  "failure-modes",
  "architecture",
  "pragmatics",
  "design-ux",
];
const DEFAULT_LENSES = [
  "correctness and failure modes",
  "architecture and maintenance cost",
  "operational and cost pragmatics",
];

// A panelist whose answer names its own seat, so a prompt that shows another
// panelist's answer is caught by that seat's name.
const answerFor = (prompt, options) =>
  answer(`position of ${options.label.replace(/^panelist: /, "")}`);

const mustNotSpawn = () => {
  throw new Error("must not spawn");
};

describe("panel seats", () => {
  it("documents every named seat in the command", () => {
    const command = readFileSync(resolve(root, COMMAND), "utf8");
    for (const seat of NAMED_SEATS) expect(command).toContain(`\`${seat}\``);
  });
});

describe.each(SHAPES)("panel seats ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("sits the three default lenses when no seats are named", async () => {
    const result = await run({ question: QUESTION }, answerFor);
    expect(result.seats).toEqual([
      { name: "failure-modes", lens: DEFAULT_LENSES[0] },
      { name: "architecture", lens: DEFAULT_LENSES[1] },
      { name: "pragmatics", lens: DEFAULT_LENSES[2] },
    ]);
  });

  it("sits the named and stated seats it is given, each on its own lens", async () => {
    const spawned = [];
    const stated = {
      name: "accessibility",
      lens: "screen-reader and keyboard users of the console",
    };
    const result = await run(
      { question: QUESTION, seats: ["design-ux", "failure-modes", stated] },
      (prompt, options) => {
        spawned.push({ prompt, options });
        return answerFor(prompt, options);
      },
    );
    expect(spawned.map(({ options }) => options.label)).toEqual([
      "panelist: design-ux",
      "panelist: failure-modes",
      "panelist: accessibility",
    ]);
    expect(spawned[0].prompt).toContain("design and user experience");
    expect(spawned[1].prompt).toContain(DEFAULT_LENSES[0]);
    expect(spawned[2].prompt).toContain(stated.lens);
    expect(result.positions.map((p) => p.seat)).toEqual([
      "design-ux",
      "failure-modes",
      "accessibility",
    ]);
  });

  it("accepts every named seat", async () => {
    const result = await run(
      { question: QUESTION, seats: NAMED_SEATS },
      answerFor,
    );
    expect(result.positions).toHaveLength(NAMED_SEATS.length);
  });

  it("spawns every seat on the same pinned tier", async () => {
    const models = [];
    await run(
      {
        question: QUESTION,
        seats: [...NAMED_SEATS, { name: "stated", lens: "a stated lens" }],
      },
      (prompt, options) => {
        models.push(options.model);
        return answerFor(prompt, options);
      },
    );
    expect(new Set(models)).toEqual(new Set(["opus"]));
  });

  it("refuses seats it cannot sit", async () => {
    const refused = [
      [
        { seats: ["failure-modes", "nonexistent"] },
        /Unknown seat "nonexistent"/,
      ],
      [{ seats: ["failure-modes"] }, /at least two seats/],
      [{ seats: [] }, /at least two seats/],
      [{ seats: "design-ux" }, /at least two seats/],
      [{ seats: ["architecture", "architecture"] }, /named twice/],
      [
        { seats: ["architecture", { name: "architecture", lens: "x" }] },
        /has the name of a named seat/,
      ],
      [{ seats: ["architecture", { name: "x" }] }, /both non-empty/],
      [{ seats: ["architecture", { name: " ", lens: "x" }] }, /both non-empty/],
      [{ docs: "docs/DESIGN.md" }, /docs is a list/],
    ];
    for (const [extra, message] of refused) {
      await expect(
        run({ question: QUESTION, ...extra }, mustNotSpawn),
        JSON.stringify(extra),
      ).rejects.toThrow(message);
    }
  });

  it("refuses a call with no question", async () => {
    for (const question of [undefined, "", "  "]) {
      await expect(run({ question, docs: [] }, mustNotSpawn)).rejects.toThrow(
        /question is the non-empty text/,
      );
    }
  });
});

describe.each(SHAPES)("panel deliberation ($shape args)", ({ deliver }) => {
  const run = runner(deliver);
  const firstRound = () =>
    run(
      {
        question: QUESTION,
        docs: ["docs/DESIGN.md"],
        seats: ["failure-modes", "design-ux", "pragmatics"],
      },
      answerFor,
    );

  it("asks for every first position before any panelist sees another's", async () => {
    const asked = [];
    await run(
      { question: QUESTION, seats: ["failure-modes", "design-ux"] },
      (prompt, options) => {
        asked.push(prompt);
        return answerFor(prompt, options);
      },
    );
    for (const prompt of asked) {
      expect(prompt).not.toContain("position of");
      expect(prompt).not.toContain("deliberation");
    }
  });

  it("shows each panelist its own first answer and the others', and records first and revised side by side", async () => {
    const first = await firstRound();
    const spawned = [];
    const result = await run({ deliberate: first }, (prompt, options) => {
      spawned.push({ prompt, options });
      return { ...answerFor(prompt, options), changed: false };
    });

    expect(spawned.map(({ options }) => options.label)).toEqual([
      "panelist: failure-modes (deliberation)",
      "panelist: design-ux (deliberation)",
      "panelist: pragmatics (deliberation)",
    ]);
    for (const { prompt, options } of spawned) {
      expect(prompt).toContain(QUESTION);
      expect(prompt).toContain("/tmp/panel-base/docs/DESIGN.md");
      for (const seat of ["failure-modes", "design-ux", "pragmatics"]) {
        expect(prompt, options.label).toContain(`position of ${seat}`);
      }
      expect(options.schema.required).toContain("changed");
      for (const key of options.schema.required) {
        expect(prompt, options.label).toContain(`\`${key}\``);
      }
      expect(options.model).toBe("opus");
    }

    expect(result.round).toBe("deliberation");
    expect(result.note).toMatch(/informs the owner and settles nothing/);
    expect(result.panelists).toEqual(
      first.positions.map((own) => ({
        seat: own.seat,
        first: {
          position: own.position,
          rationale: own.rationale,
          keyRisk: own.keyRisk,
        },
        revised: {
          ...answer(`position of ${own.seat} (deliberation)`),
          changed: false,
        },
      })),
    );
  });

  it("leaves out a panelist with no first position, and records a failed revision as null", async () => {
    const first = await run(
      { question: QUESTION, seats: NAMED_SEATS },
      (prompt, options) =>
        options.label === "panelist: architecture"
          ? null
          : answerFor(prompt, options),
    );
    const spawned = [];
    const result = await run({ deliberate: first }, (prompt, options) => {
      spawned.push(prompt);
      return options.label === "panelist: pragmatics (deliberation)"
        ? null
        : { ...answerFor(prompt, options), changed: true };
    });
    expect(spawned).toHaveLength(3);
    for (const prompt of spawned) {
      expect(prompt).not.toContain("position of architecture");
    }
    expect(result.panelists.map((p) => p.seat)).toEqual([
      "failure-modes",
      "pragmatics",
      "design-ux",
    ]);
    expect(result.panelists[1].revised).toBeNull();
  });

  it("refuses a deliberation over anything but one first round's result", async () => {
    const first = await firstRound();
    const deliberation = await run(
      { deliberate: first },
      (prompt, options) => ({
        ...answerFor(prompt, options),
        changed: false,
      }),
    );
    const extra = { seat: "architecture", ...answer("an extra") };
    const refused = [
      [{ deliberate: deliberation }, /exactly as the panel returned it/],
      [{ deliberate: true }, /exactly as the panel returned it/],
      [{ deliberate: first, question: QUESTION }, /deliberate alone/],
      [
        { deliberate: { ...first, positions: first.positions.slice(0, 1) } },
        /at least two first positions/,
      ],
      [
        { deliberate: { ...first, positions: [...first.positions, extra] } },
        /not one of the first round's/,
      ],
      [
        {
          deliberate: {
            ...first,
            positions: [...first.positions, first.positions[0]],
          },
        },
        /not one of the first round's/,
      ],
    ];
    for (const [delivered, message] of refused) {
      await expect(run(delivered, mustNotSpawn)).rejects.toThrow(message);
    }
  });
});
