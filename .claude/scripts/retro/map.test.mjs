import { describe, expect, it } from "vitest";

import { mapToPrs, parseArgs } from "./map.mjs";

const RANGE = { lo: 2100, hi: 2199 };

function pr(number, state, headRefName, login = "maintainer") {
  return {
    number,
    title: `Change ${number}`,
    state,
    mergedAt: state === "MERGED" ? "2026-01-11T12:00:00Z" : null,
    headRefName,
    author: { login },
    additions: number - 2100,
    deletions: 1,
    changedFiles: 2,
  };
}

const PRS = [
  pr(2101, "MERGED", "fix-parser"),
  pr(2102, "MERGED", "add-report"),
  pr(2103, "MERGED", "dependabot/npm_and_yarn/x-1.2.3", "app/dependabot"),
  pr(2104, "CLOSED", "abandoned"),
  pr(2200, "MERGED", "out-of-range"),
];

function session(id, cost, fields = {}) {
  return {
    store: "a",
    id,
    cost,
    branches: {},
    subBranches: {},
    wfBranches: {},
    wfRefs: {},
    prMentions: {},
    ...fields,
  };
}

function agent(sessionIdValue, id, cost, fields = {}) {
  return {
    store: "a",
    session: sessionIdValue,
    id,
    cost,
    branches: [],
    targetRef: null,
    prMentions: [],
    ...fields,
  };
}

// S1 works two PRs: its subagent on add-report's branch, its workflow agent
// reviewing fix-parser. S2 names only skipped or out-of-range branches and
// mentions a merged, a closed and an out-of-range PR. S3 names nothing.
function fixture() {
  const sessions = [
    session(
      "s1",
      { main: 10, subagents: 6, workflow: 4, total: 20 },
      {
        branches: { staging: 5, "fix-parser": 3 },
        subBranches: { "add-report": 1 },
        wfRefs: { "fix-parser": 2 },
      },
    ),
    session(
      "s2",
      { main: 3, subagents: 0, workflow: 0, total: 3 },
      {
        branches: { "worktree-agent-a1b2c3": 2, HEAD: 1, "out-of-range": 1 },
        prMentions: { 2103: 1, 2104: 2, 2200: 1 },
      },
    ),
    session("s3", { main: 1, subagents: 0, workflow: 0, total: 1 }),
  ];
  const agents = [
    agent("s1", "agent-sub", 6, { branches: ["add-report"] }),
    agent("s1", "agent-wf", 4, { targetRef: "fix-parser" }),
  ];
  return { sessions, agents };
}

describe("mapToPrs", () => {
  it("resolves a workflow agent's targetRef through the branch skip list and origin/ prefix", () => {
    const sessions = [
      session("s1", { main: 1, subagents: 0, workflow: 1, total: 2 }),
    ];
    const agents = [
      agent("s1", "agent-origin", 1, { targetRef: "origin/fix-parser" }),
      agent("s1", "agent-staging", 1, { targetRef: "staging" }),
    ];
    mapToPrs(sessions, agents, PRS, RANGE);
    expect(agents.map((a) => [a.id, a.pr])).toEqual([
      ["agent-origin", 2101],
      ["agent-staging", null],
    ]);
  });

  it("attributes cost by methods A, B and D", () => {
    const { sessions, agents } = fixture();
    const { rows } = mapToPrs(sessions, agents, PRS, RANGE);
    const costs = Object.fromEntries(
      rows.map((r) => [r.number, [r.costA, r.costB, r.costD]]),
    );
    expect(costs).toEqual({
      2101: [8, 10, 9],
      2102: [8, 10, 11],
      2103: [3, 3, 3],
    });
  });

  it("records each agent's own PR", () => {
    const { sessions, agents } = fixture();
    mapToPrs(sessions, agents, PRS, RANGE);
    expect(agents.map((a) => [a.id, a.pr])).toEqual([
      ["agent-sub", 2102],
      ["agent-wf", 2101],
    ]);
  });

  it("gives the true mean per merged PR, all and non-dependabot, and method D's spread", () => {
    const { sessions, agents } = fixture();
    const { summary } = mapToPrs(sessions, agents, PRS, RANGE);
    expect(summary).toMatchObject({
      sessions: 3,
      mergedPrs: 3,
      mergedNonDependabot: 2,
      closedUnmerged: 1,
      grandUSD: 24,
      meanPerMergedPr: 8,
      meanPerNonDependabotMergedPr: 12,
    });
    expect(summary.D).toEqual({
      mappedUSD: 23,
      unmappedUSD: 1,
      mergedWithCost: 3,
      mergedWithoutCost: 0,
      meanOverMapped: 7.67,
      median: 9,
      p90: 11,
      max: 11,
      closedUnmergedUSD: 0,
    });
  });

  it("writes one row per merged PR in the range", () => {
    const { sessions, agents } = fixture();
    const { rows } = mapToPrs(sessions, agents, PRS, RANGE);
    expect(rows[0]).toEqual({
      number: 2101,
      title: "Change 2101",
      mergedAt: "2026-01-11T12:00:00Z",
      author: "maintainer",
      size: 2,
      files: 2,
      costA: 8,
      costB: 10,
      costD: 9,
    });
    expect(rows.map((r) => r.number)).toEqual([2101, 2102, 2103]);
  });
});

describe("parseArgs", () => {
  it("requires the directory, the PR file and the range", () => {
    expect(
      parseArgs([
        "--dir",
        "/tmp/d",
        "--prs",
        "/tmp/p.json",
        "--pr-range",
        "2100-2199",
      ]),
    ).toEqual({
      ok: true,
      options: { dir: "/tmp/d", prs: "/tmp/p.json", prRange: RANGE },
    });
    expect(parseArgs(["--dir", "/tmp/d", "--prs", "/tmp/p.json"])).toEqual({
      ok: false,
      message: "--pr-range is required",
    });
    expect(
      parseArgs([
        "--dir",
        "/tmp/d",
        "--prs",
        "/tmp/p.json",
        "--pr-range",
        "21-",
      ]),
    ).toMatchObject({ ok: false });
  });
});
