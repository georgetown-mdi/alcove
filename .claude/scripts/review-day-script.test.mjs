import { describe, expect, it } from "vitest";
import {
  compileScript,
  readRepoFile,
  SHAPES,
  UNRESOLVABLE,
} from "./lib/workflowScriptHarness.mjs";

const SCRIPT = ".claude/scripts/review-day-workflow.mjs";

// The checked-in script the review day invokes by path IS the artifact under test.
const script = compileScript(SCRIPT, ["args", "agent", "pipeline"]);
// Each item runs through every stage in turn, a later stage taking the earlier
// stage's result and the item. The results come back in reverse order, so a
// script that pairs a result with its slice by position is caught.
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
  script(deliver(args), respond, pipeline);

const DAY = "/repo/scratch/review-days/2026-11-20";
const W = `${DAY}/W1`;

const reviewed = (id, total, majorOrWorse = 0) => ({
  file: `${W}/${id}.md`,
  total,
  majorOrWorse,
  blocked: "",
});
const verified = (id) => ({
  file: `${W}/${id}.verify.md`,
  confirmed: 2,
  narrowed: 1,
  refuted: 0,
  unverifiable: 0,
  blocked: "",
});
const TRIAGED = { file: `${W}/TRIAGE.md`, summary: "two batches" };

// A stub agent answering by label kind; `totals` maps a slice id to its
// reviewer's finding count, and a slice mapped to null stands for a reviewer
// whose structured-output retries ran out.
function stub(totals) {
  const spawned = [];
  const respond = (prompt, options) => {
    spawned.push({ prompt, options });
    const [kind, id] = options.label.split(":");
    if (kind === "review") {
      return totals[id] === null ? null : reviewed(id, totals[id]);
    }
    if (kind === "verify") return verified(id);
    if (kind === "triage") return TRIAGED;
    throw new Error(`unexpected spawn ${options.label}`);
  };
  return { spawned, respond };
}

const spawnsOf = (spawned, kind) =>
  spawned.filter(({ options }) => options.label.startsWith(`${kind}:`));

const mustNotSpawn = () => {
  throw new Error("must not spawn");
};

describe("review-day script", () => {
  // The Workflow tool refuses at launch a script whose body loads a module.
  it("loads no module, so the Workflow tool will launch it", () => {
    const body = readRepoFile(SCRIPT);
    expect(body).not.toContain("import(");
    expect(body).not.toContain("require(");
  });
});

describe.each(SHAPES)("review-day arguments ($shape args)", ({ deliver }) => {
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

  it("refuses a day directory that is missing or relative", async () => {
    for (const day of [undefined, "", "scratch/review-days/2026-11-20"]) {
      await expect(
        run({ day, wf: "W1", jobs: [{ id: "S1", lens: 4 }] }, mustNotSpawn),
        String(day),
      ).rejects.toThrow(/day must be the absolute path/);
    }
  });

  it("refuses a missing workflow name", async () => {
    await expect(
      run({ day: DAY, jobs: [{ id: "S1", lens: 4 }] }, mustNotSpawn),
    ).rejects.toThrow(/wf must name the workflow/);
  });

  it("refuses an empty or malformed job list", async () => {
    for (const jobs of [undefined, [], "S1"]) {
      await expect(
        run({ day: DAY, wf: "W1", jobs }, mustNotSpawn),
      ).rejects.toThrow(/jobs must be a non-empty array/);
    }
    await expect(
      run({ day: DAY, wf: "W1", jobs: [{ lens: 2 }] }, mustNotSpawn),
    ).rejects.toThrow(/non-empty string id/);
    for (const lens of [0, 5, "2", undefined]) {
      await expect(
        run({ day: DAY, wf: "W1", jobs: [{ id: "S1", lens }] }, mustNotSpawn),
        String(lens),
      ).rejects.toThrow(/lens of 1, 2, 3 or 4/);
    }
  });

  it("refuses two slices sharing an id", async () => {
    await expect(
      run(
        {
          day: DAY,
          wf: "W1",
          jobs: [
            { id: "S1", lens: 2 },
            { id: "S1", lens: 4 },
          ],
        },
        mustNotSpawn,
      ),
    ).rejects.toThrow(/S1 appears more than once/);
  });
});

describe.each(SHAPES)("review-day run ($shape args)", ({ deliver }) => {
  const run = runner(deliver);

  it("skips the verifier of a slice with zero findings", async () => {
    const { spawned, respond } = stub({ S1: 0, S2: 3 });
    const result = await run(
      {
        day: DAY,
        wf: "W1",
        jobs: [
          { id: "S1", lens: 4 },
          { id: "S2", lens: 4 },
        ],
      },
      respond,
    );
    expect(
      spawnsOf(spawned, "verify").map(({ options }) => options.label),
    ).toEqual(["verify:S2"]);
    expect(result.slices[0].verify).toEqual({
      file: "",
      confirmed: 0,
      narrowed: 0,
      refuted: 0,
      unverifiable: 0,
      blocked: "",
    });
  });

  it("skips the verifier of a slice whose reviewer returned nothing, and still triages", async () => {
    const { spawned, respond } = stub({ S1: null });
    const result = await run(
      { day: DAY, wf: "W1", jobs: [{ id: "S1", lens: 2 }] },
      respond,
    );
    expect(spawnsOf(spawned, "verify")).toEqual([]);
    expect(spawnsOf(spawned, "triage")).toHaveLength(1);
    expect(result.slices[0]).toEqual({
      id: "S1",
      lens: 2,
      review: null,
      verify: null,
    });
  });

  it("seats an Opus verifier for lens 2 and a Sonnet verifier otherwise", async () => {
    const { spawned, respond } = stub({ S1: 2, S2: 2, S3: 2, S4: 2 });
    await run(
      {
        day: DAY,
        wf: "W1",
        jobs: [1, 2, 3, 4].map((lens) => ({ id: `S${lens}`, lens })),
      },
      respond,
    );
    const tiers = Object.fromEntries(
      spawnsOf(spawned, "verify").map(({ options }) => [
        options.label,
        [options.model, options.effort],
      ]),
    );
    expect(tiers).toEqual({
      "verify:S1": ["sonnet", "high"],
      "verify:S2": ["opus", "high"],
      "verify:S3": ["sonnet", "high"],
      "verify:S4": ["sonnet", "high"],
    });
    for (const kind of ["review", "triage"]) {
      for (const { options } of spawnsOf(spawned, kind)) {
        expect([options.model, options.effort], options.label).toEqual([
          "opus",
          "high",
        ]);
      }
    }
  });

  it("names each brief under .claude/review-day/ and the day directory in its prompt", async () => {
    const { spawned, respond } = stub({ S1: 1 });
    await run({ day: DAY, wf: "W1", jobs: [{ id: "S1", lens: 3 }] }, respond);
    const [reviewer] = spawnsOf(spawned, "review");
    const [verifier] = spawnsOf(spawned, "verify");
    const [triager] = spawnsOf(spawned, "triage");
    expect(reviewer.prompt).toContain(".claude/review-day/reviewer-brief.md");
    expect(reviewer.prompt).toContain(
      `git -C ${DAY} rev-parse --show-toplevel`,
    );
    expect(reviewer.prompt).toContain(`${DAY}/SLICES.md`);
    expect(reviewer.prompt).toContain(`${W}/S1.md`);
    expect(verifier.prompt).toContain(".claude/review-day/verifier-brief.md");
    expect(verifier.prompt).toContain(
      `git -C ${DAY} rev-parse --show-toplevel`,
    );
    expect(verifier.prompt).toContain(`${W}/S1.verify.md`);
    expect(triager.prompt).toContain(".claude/review-day/triage-brief.md");
    expect(triager.prompt).toContain(`git -C ${DAY} rev-parse --show-toplevel`);
    expect(triager.prompt).toContain(W);
    for (const { prompt } of spawned) {
      expect(prompt).toContain(`The day directory is ${DAY}`);
    }
  });

  it("names every required key of its schema in each prompt", async () => {
    const { spawned, respond } = stub({ S1: 1 });
    await run({ day: DAY, wf: "W1", jobs: [{ id: "S1", lens: 2 }] }, respond);
    for (const { prompt, options } of spawned) {
      for (const key of options.schema.required) {
        expect(prompt, options.label).toContain(`\`${key}\``);
      }
    }
  });

  it("returns every slice in job order with its review and verdict, and the triage", async () => {
    const { respond } = stub({ S1: 3, S2: 0 });
    const result = await run(
      {
        day: `${DAY}/`,
        wf: " W1 ",
        jobs: [
          { id: "S1", lens: 2 },
          { id: "S2", lens: 4 },
        ],
      },
      respond,
    );
    expect(result).toEqual({
      day: DAY,
      wf: "W1",
      slices: [
        {
          id: "S1",
          lens: 2,
          review: reviewed("S1", 3),
          verify: verified("S1"),
        },
        {
          id: "S2",
          lens: 4,
          review: reviewed("S2", 0),
          verify: {
            file: "",
            confirmed: 0,
            narrowed: 0,
            refuted: 0,
            unverifiable: 0,
            blocked: "",
          },
        },
      ],
      triage: TRIAGED,
    });
  });
});
