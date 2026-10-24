import { describe, expect, it } from "vitest";

import { analyze, parseArgs } from "./analyze.mjs";

function agent(fields) {
  return {
    store: "a",
    session: "s1",
    kind: "subagent",
    agentType: null,
    model: "claude-opus-5-5",
    desc: "",
    wf: null,
    wfName: null,
    targetRef: null,
    firstTs: "2026-01-11T10:00:00Z",
    calls: 10,
    cost: 1,
    ...fields,
  };
}

const lightReview = (wf, agentType, cost) =>
  agent({
    kind: "workflow-agent",
    wf,
    wfName: "light-review",
    agentType,
    targetRef: "fix-parser",
    cost,
  });

function session(id, mainCalls, main, fields = {}) {
  return {
    store: "a",
    id,
    kind: "session",
    winFirstTs: "2026-01-11T09:00:00Z",
    winLastTs: "2026-01-11T18:00:00Z",
    domModel: "claude-opus-5-5",
    mainCalls,
    mainCtxPerCall: 1000,
    cost: { main, subagents: 0, workflow: 0, total: main },
    subagentCount: 0,
    wfAgentCount: 0,
    userTurns: 1,
    spawns: [],
    ownerByDay: { "2026-01-11": { typed: 1 } },
    ...fields,
  };
}

function input(extra = {}) {
  return {
    sessions: [
      session("s1", 200, 30, {
        spawns: [{ type: "implementer" }, { type: "implementer" }],
      }),
      session("s2", 20, 10),
    ],
    agents: [
      lightReview("wf_1", "general-purpose", 2),
      lightReview("wf_1", "general-purpose", 2),
      lightReview("wf_2", "security-reviewer", 3),
      agent({ agentType: "ux-reviewer", cost: 1 }),
      agent({
        agentType: "implementer",
        desc: "Fix the round 2 findings",
        cost: 4,
      }),
      agent({ agentType: "implementer", desc: "Build the kit", cost: 8 }),
    ],
    prCost: [
      { number: 2101, size: 10, costD: 5 },
      { number: 2102, size: 20, costD: 10 },
      { number: 2103, size: 30, costD: 15 },
      { number: 2104, size: 40, costD: 20 },
    ],
    rollups: {
      grandTotalUSD: 100,
      byModel: { "claude-opus-5-5": { calls: 1000 } },
    },
    pricing: { "claude-opus-5-5": { cacheRead: 0.2 } },
    callIndex: [],
    claudeMdBytes: null,
    ...extra,
  };
}

describe("analyze", () => {
  it("measures the review apparatus and the implementers", () => {
    const out = analyze(input());
    expect(out.review).toMatchObject({
      lightReviewRuns: 2,
      roleRuns: 1,
      lensRuns: 1,
      lensUSD: 4,
      roleUSD: 3,
      directRoleSubagentUSD: 1,
      apparatusUSD: 8,
      apparatusShare: 0.08,
      fixImplementers: 1,
      fixImplementersUSD: 4,
      apparatusPlusFixShare: 0.12,
      refsReviewed: 1,
      runsPerRefMax: 2,
    });
    expect(out.implementers).toMatchObject({
      transcripts: 2,
      spawnToolCallsInMain: 2,
      totalUSD: 12,
      share: 0.12,
      fixLike: { n: 1, usd: 4 },
    });
    expect(out.sessionLength.over150).toMatchObject({
      sessions: 1,
      mainUSD: 30,
      mainCalls: 200,
    });
    expect(out.sessionLength.upTo150).toMatchObject({
      sessions: 1,
      mainUSD: 10,
      mainCalls: 20,
    });
    // A quantile is the element at floor(p * n): the cuts are 20, 30 and 40.
    expect(out.sizeBandsD.map((b) => b.prs)).toEqual([2, 1, 1, 0]);
    expect(out.costSizePearsonD).toBe(1);
  });

  it("leaves out the call-index and harness-tax blocks without their inputs, and prices CLAUDE.md from its size", () => {
    const without = analyze(input());
    expect(without.callIndex).toBeUndefined();
    expect(without.harnessTax).toBeUndefined();
    const withSize = analyze(input({ claudeMdBytes: 3700 }));
    expect(withSize.harnessTax).toEqual({
      claudeMdBytes: 3700,
      claudeMdTokensApprox: 1000,
      cacheReadUSD: 0.2,
      totalCalls: 1000,
    });
  });
});

describe("analyze call-index", () => {
  const table = (buckets, rows) => ({
    buckets,
    sessions: [{ model: "claude-opus-5-5", rows }],
  });
  const row = (calls, cost) => ({ calls, cost, ctx: 10 });

  it("splits at the bucket after the one ending at 150, across tables", () => {
    const buckets = [100, 150, 400, 1e9];
    const a = table(buckets, [row(10, 1), row(10, 2), row(10, 4), row(10, 8)]);
    const b = table(buckets, [row(10, 1), row(10, 2), row(10, 4), row(10, 8)]);
    const out = analyze(input({ callIndex: [a, b] })).callIndex;
    expect(out.mainUSDpastCall150).toBe(24);
    expect(out.callsPast150).toBe(40);
    expect(out.usdPerCall_1to150).toBe(0.15);
    expect(out.usdPerCall_151plus).toBe(0.6);
  });

  it("refuses tables whose buckets differ", () => {
    const a = table([50, 150, 1e9], [row(1, 1), row(1, 1), row(1, 1)]);
    const b = table([100, 150, 1e9], [row(1, 1), row(1, 1), row(1, 1)]);
    expect(() => analyze(input({ callIndex: [a, b] }))).toThrow(
      /disagree on buckets/,
    );
  });

  it("refuses buckets with no 150-call boundary", () => {
    const a = table([100, 200, 1e9], [row(1, 1), row(1, 1), row(1, 1)]);
    expect(() => analyze(input({ callIndex: [a] }))).toThrow(
      /no 150-call boundary/,
    );
  });
});

describe("parseArgs", () => {
  it("takes repeated call-index tables and an optional CLAUDE.md", () => {
    const parsed = parseArgs([
      "--dir",
      "/tmp/d",
      "--call-index",
      "a.json",
      "--call-index",
      "b.json",
      "--claude-md",
      "CLAUDE.md",
    ]);
    expect(parsed).toMatchObject({
      ok: true,
      options: {
        dir: "/tmp/d",
        callIndex: ["a.json", "b.json"],
        claudeMd: "CLAUDE.md",
      },
    });
    expect(parseArgs([])).toEqual({ ok: false, message: "--dir is required" });
  });
});
