import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { aggregate } from "./aggregate.mjs";
import { readJson } from "./args.mjs";
import { cost, parseArgs } from "./cost.mjs";
import {
  assistant,
  sessionId,
  tempDir,
  usage,
  user,
  writeProject,
} from "./transcriptFixtures.mjs";

const CUT = "2026-01-10T00:00:00Z";
const END = "2026-01-12T00:00:00Z";
const WRITTEN = new Date("2026-01-11T12:00:00Z");
const S1 = sessionId(1);
const S2 = sessionId(2);
const RATES = { in: 1, out: 10, cacheRead: 0.1, cache5m: 1.25, cache1h: 2 };
const PRICING = {
  "model-a": RATES,
  "claude-sonnet-5": {
    in: 3,
    out: 15,
    cacheRead: 0.3,
    cache5m: 3.75,
    cache1h: 6,
  },
  "claude-sonnet-5-intro": {
    in: 2,
    out: 10,
    cacheRead: 0.2,
    cache5m: 2.5,
    cache1h: 4,
  },
};
const M = 1e6;

const dirs = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function aggregateStore(store, sessions, window = {}) {
  const root = tempDir();
  dirs.push(root);
  writeProject(root, "-workspace", sessions, WRITTEN);
  return aggregate({
    store,
    cut: window.cut ?? CUT,
    end: window.end ?? END,
    prRange: { lo: 2000, hi: 2999 },
    exclude: [],
    only: [],
    roots: [root],
    projectDirs: [],
  });
}

const call = (ts, id, u, extra = {}) =>
  assistant(ts, { id, model: "model-a", u, ...extra });

describe("pricing", () => {
  it("prices each token kind at its model's rate per million tokens", async () => {
    const agg = await aggregateStore("a", {
      [S1]: {
        main: [
          call("2026-01-11T10:00:00Z", "msg_fixture_priced", {
            ...usage({
              input: M,
              output: 2 * M,
              cacheRead: 3 * M,
              cache5m: 4 * M,
              cache1h: 5 * M,
            }),
          }),
        ],
      },
    });
    const { rollups } = cost([agg], PRICING);
    expect(rollups.grandTotalUSD).toBe(1 + 20 + 0.3 + 5 + 10);
    expect(rollups.byModel["model-a"]).toEqual({
      calls: 1,
      cost: 36.3,
      main: 36.3,
      subagent: 0,
      "workflow-agent": 0,
    });
    expect(rollups.anatomy.other).toEqual({
      totalUSD: 36.3,
      input: 0.03,
      output: 0.55,
      cacheRead: 0.01,
      cacheWrite: 0.41,
    });
  });

  it("prices claude-sonnet-5 at the intro row for the intro total only", async () => {
    const agg = await aggregateStore("a", {
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", {
            id: "msg_fixture_sonnet",
            model: "claude-sonnet-5",
            u: usage({ output: M }),
          }),
        ],
      },
    });
    const { rollups } = cost([agg], PRICING);
    expect(rollups.grandTotalUSD).toBe(15);
    expect(rollups.grandTotalSonnetIntroUSD).toBe(10);
  });

  it("tallies an unknown model's calls without pricing them", async () => {
    const agg = await aggregateStore("a", {
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", {
            id: "msg_fixture_unknown",
            model: "model-unpriced",
            u: usage({ output: M }),
          }),
          call(
            "2026-01-11T10:00:01Z",
            "msg_fixture_known",
            usage({ output: M }),
          ),
        ],
      },
    });
    const { rollups } = cost([agg], PRICING);
    expect(rollups.grandTotalUSD).toBe(10);
    expect(rollups.unknownModels["model-unpriced"]).toBeGreaterThan(0);
  });

  it("counts an unpriced model's calls once", async () => {
    const agg = await aggregateStore("a", {
      [S1]: {
        main: [
          assistant("2026-01-11T10:00:00Z", {
            id: "msg_fixture_unknown_a",
            model: "model-unpriced",
            u: usage({ output: M }),
          }),
          assistant("2026-01-11T10:00:01Z", {
            id: "msg_fixture_unknown_b",
            model: "model-unpriced",
            u: usage({ output: M }),
          }),
        ],
      },
    });
    const { rollups } = cost([agg], PRICING);
    expect(rollups.unknownModels["model-unpriced"]).toBe(2);
  });

  it("has five rates per model in the committed table, cache writes at 1.25x and 2x input", () => {
    const table = readJson(new URL("./pricing.json", import.meta.url));
    expect(typeof table._source).toBe("string");
    for (const [model, rates] of Object.entries(table.models)) {
      expect(Object.keys(rates).sort(), model).toEqual([
        "cache1h",
        "cache5m",
        "cacheRead",
        "in",
        "out",
      ]);
      for (const v of Object.values(rates))
        expect(typeof v, model).toBe("number");
      expect(rates.cache5m, model).toBeCloseTo(rates.in * 1.25, 10);
      expect(rates.cache1h, model).toBeCloseTo(rates.in * 2, 10);
    }
  });
});

describe("components and seats", () => {
  it("files main and sidechain spend as main, agents by kind, and each aggregate under its store", async () => {
    const at = "2026-01-11T10:00:00Z";
    const a = await aggregateStore("a", {
      [S1]: {
        main: [
          call(at, "msg_fixture_main", usage({ output: M })),
          call(at, "msg_fixture_side", usage({ output: M }), {
            isSidechain: true,
          }),
        ],
        subagents: {
          "agent-afixture01": {
            entries: [call(at, "msg_fixture_sub", usage({ output: 2 * M }))],
          },
        },
        workflows: {
          wf_fixture01: {
            record: { script: 'const meta = { name: "light-review" };' },
            agents: {
              "agent-afixture02": [
                call(at, "msg_fixture_wf", usage({ output: 3 * M })),
              ],
            },
          },
        },
      },
    });
    const b = await aggregateStore("b", {
      [S2]: { main: [call(at, "msg_fixture_b", usage({ output: M }))] },
    });
    const { rollups, enriched, agents } = cost([a, b], PRICING);
    expect(rollups.bySeat).toEqual({
      a: { cost: 70, main: 20, subagent: 20, "workflow-agent": 30, calls: 4 },
      b: { cost: 10, main: 10, subagent: 0, "workflow-agent": 0, calls: 1 },
    });
    expect(rollups.workflowsByName).toEqual({
      "light-review": { runs: 1, agents: 1, cost: 30 },
    });
    expect(enriched.find((s) => s.id === S1).cost).toEqual({
      main: 20,
      subagents: 20,
      workflow: 30,
      total: 70,
    });
    expect(agents.map((x) => [x.store, x.kind, x.cost]).sort()).toEqual([
      ["a", "subagent", 20],
      ["a", "workflow-agent", 30],
    ]);
  });

  it("leaves an agent with no window entry out of the session's counts and the workflow names", async () => {
    const late = "2026-01-12T01:00:00Z";
    const agg = await aggregateStore("a", {
      [S1]: {
        main: [
          call(
            "2026-01-11T10:00:00Z",
            "msg_fixture_main",
            usage({ output: M }),
          ),
        ],
        subagents: {
          "agent-afixture03": {
            entries: [call(late, "msg_fixture_late_sub", usage({ output: M }))],
          },
        },
        workflows: {
          wf_fixture02: {
            record: { script: 'const meta = { name: "panel" };' },
            agents: {
              "agent-afixture04": [
                call(late, "msg_fixture_late_wf", usage({ output: M })),
              ],
            },
          },
        },
      },
    });
    const { rollups, enriched } = cost([agg], PRICING);
    expect(rollups.workflowsByName).toEqual({});
    expect(enriched[0]).toMatchObject({ subagentCount: 0, wfAgentCount: 0 });
  });

  it("drops a session with no spend and no owner turns, and keeps one with owner turns alone", async () => {
    const agg = await aggregateStore("a", {
      [S1]: { main: [user("2026-01-11T10:00:00Z", "Please fix the parser.")] },
      [S2]: { main: [user("2026-01-12T10:00:00Z", "Past the end.")] },
    });
    const { enriched } = cost([agg], PRICING);
    expect(enriched.map((s) => s.id)).toEqual([S1]);
  });
});

describe("first-entry output", () => {
  async function streamed() {
    const id = "msg_fixture_streamed";
    return aggregateStore("a", {
      [S1]: {
        main: [user("2026-01-11T09:00:00Z", "Start.")],
        subagents: {
          "agent-afixture05": {
            entries: [
              call("2026-01-11T10:00:00Z", id, usage({ input: M, output: M })),
              call(
                "2026-01-11T10:00:05Z",
                id,
                usage({ input: M, output: 4 * M }),
              ),
            ],
          },
        },
      },
    });
  }

  it("prices the last entry's output by default and reports the first-entry figure beside it", async () => {
    const { rollups } = cost([await streamed()], PRICING);
    expect(rollups.grandTotalUSD).toBe(41);
    expect(rollups.uncorrectedTotalUSD).toBe(11);
    expect(rollups.streamFix["model-a|subagent"]).toMatchObject({
      calls: 1,
      outTok: 4 * M,
      outFirstTok: M,
      outFactor: 4,
      costUSD: 41,
      uncorrectedUSD: 11,
    });
  });

  it("prices each streamed message's first-entry output under --first-entry-output", async () => {
    const { rollups, agents } = cost([await streamed()], PRICING, {
      firstEntryOutput: true,
    });
    expect(rollups.grandTotalUSD).toBe(11);
    expect(rollups.firstEntryOutput).toBe(true);
    expect(agents[0].cost).toBe(11);
  });
});

describe("window", () => {
  it("runs window days from the cut to the latest window entry in any aggregate", async () => {
    const a = await aggregateStore("a", {
      [S1]: {
        main: [
          call("2026-01-11T00:00:00Z", "msg_fixture_a", usage({ output: M })),
        ],
      },
    });
    const b = await aggregateStore("b", {
      [S2]: {
        main: [
          call(
            "2026-01-11T12:00:00Z",
            "msg_fixture_b",
            usage({ output: 2 * M }),
          ),
        ],
      },
    });
    const { rollups } = cost([a, b], PRICING);
    expect(rollups.window).toEqual({
      cut: CUT,
      end: END,
      lastEntryTs: "2026-01-11T12:00:00Z",
      days: 1.5,
    });
    expect(rollups.perDayUSD).toBe(20);
    expect(rollups.byDay).toEqual({ "2026-01-11": 30 });
  });

  it("refuses aggregates over different windows", async () => {
    const a = await aggregateStore("a", { [S1]: { main: [] } });
    const b = await aggregateStore(
      "b",
      { [S2]: { main: [] } },
      { end: "2026-01-13T00:00:00Z" },
    );
    expect(() => cost([a, b], PRICING)).toThrow(
      "aggregates a and b cover different windows",
    );
  });
});

describe("parseArgs", () => {
  it("defaults the pricing table to the one beside the script", () => {
    const parsed = parseArgs(["--out-dir", "/tmp/out", "a.json", "b.json"]);
    expect(parsed).toMatchObject({
      ok: true,
      options: {
        outDir: "/tmp/out",
        firstEntryOutput: false,
        aggregates: ["a.json", "b.json"],
      },
    });
    expect(path.basename(parsed.options.pricing)).toBe("pricing.json");
  });

  it("requires the output directory and an aggregate", () => {
    expect(parseArgs(["a.json"])).toEqual({
      ok: false,
      message: "--out-dir is required",
    });
    expect(parseArgs(["--out-dir", "/tmp/out"])).toMatchObject({ ok: false });
  });
});
