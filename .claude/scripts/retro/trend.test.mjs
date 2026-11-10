import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { tempDir } from "./transcriptFixtures.mjs";
import {
  bootstrapRatio,
  parseArgs,
  perDay,
  seededRandom,
  standardizedCost,
  trend,
  windowDays,
} from "./trend.mjs";

const SCRIPT = fileURLToPath(new URL("./trend.mjs", import.meta.url));

const dirs = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const day = (n) => `2026-01-${String(n).padStart(2, "0")}`;

// One window's kit output: `days` UTC days from `first`, each with `spend`
// dollars and the merged PRs `prsPerDay(i)` returns as [size, costD] pairs.
function kit({
  first = 1,
  days = 10,
  spend = () => 100,
  prsPerDay = () => [[50, 10]],
  followups = null,
} = {}) {
  const byDay = {};
  const mainByDay = {};
  const prCost = [];
  for (let i = 0; i < days; i++) {
    const d = day(first + i);
    byDay[d] = spend(i);
    mainByDay[d] = spend(i) / 4;
    for (const [size, costD] of prsPerDay(i)) {
      prCost.push({
        number: prCost.length + 1,
        mergedAt: `${d}T12:00:00Z`,
        size,
        costD,
      });
    }
  }
  return {
    rollups: { byDay, mainByDay },
    sessions: [
      {
        ownerByDay: {
          [day(first)]: {
            typed: 3,
            command: 1,
            "command-twin": 1,
            notification: 4,
          },
        },
        compactByDay: {
          [day(first)]: { manual: 1, auto: 2, unknown: 0, ownerTurns: 2 },
        },
      },
    ],
    agents: [
      {
        agentType: "implementer",
        desc: "Build stage 2",
        kind: "subagent",
        session: "s1234567890",
        id: "agent-a1",
        firstTs: `${day(first)}T09:00:00Z`,
        cost: 50,
        peakCtx: 859000,
      },
      {
        agentType: "implementer",
        desc: "Build stage 3",
        kind: "subagent",
        session: "s1234567890",
        id: "agent-a2",
        firstTs: `${day(first)}T09:00:00Z`,
        cost: 9,
        peakCtx: 400000,
      },
    ],
    prCost,
    followups,
  };
}

const random = () => seededRandom(7);

describe("bootstrapRatio", () => {
  it("does not call a row moved when its interval holds 1.0", () => {
    const base = [
      { v: 8 },
      { v: 12 },
      { v: 9 },
      { v: 11 },
      { v: 10 },
      { v: 7 },
      { v: 13 },
    ];
    const cur = [
      { v: 9 },
      { v: 13 },
      { v: 8 },
      { v: 12 },
      { v: 10 },
      { v: 11 },
      { v: 7 },
    ];
    const stat = perDay((d) => d.v);
    const r = bootstrapRatio(base, cur, (b, c) => [stat(b), stat(c)], {
      draws: 500,
      random: random(),
    });
    expect(r.ratio).toBeCloseTo(1, 5);
    expect(r.lo).toBeLessThan(1);
    expect(r.hi).toBeGreaterThan(1);
    expect(r.moved).toBe(false);
  });

  it("calls a row moved when its interval excludes 1.0", () => {
    const base = [
      { v: 8 },
      { v: 12 },
      { v: 9 },
      { v: 11 },
      { v: 10 },
      { v: 7 },
      { v: 13 },
    ];
    const cur = base.map((d) => ({ v: d.v * 2 }));
    const stat = perDay((d) => d.v);
    const r = bootstrapRatio(base, cur, (b, c) => [stat(b), stat(c)], {
      draws: 500,
      random: random(),
    });
    expect(r.ratio).toBeCloseTo(2, 5);
    expect(r.lo).toBeGreaterThan(1);
    expect(r.moved).toBe(true);
  });
});

describe("size-mix standardization", () => {
  it("weights each window's band means by the baseline's band shares", () => {
    // Baseline: half small PRs at $10, half large at $30. Current: a quarter
    // small, three quarters large, at the same band means.
    const base = windowDays(
      kit({
        prsPerDay: () => [
          [50, 10],
          [2000, 30],
        ],
      }),
    ).days;
    const cur = windowDays(
      kit({
        prsPerDay: () => [
          [50, 10],
          [2000, 30],
          [2000, 30],
          [2000, 30],
        ],
      }),
    ).days;
    const rawMean = (days) =>
      days.reduce((t, d) => t + d.bands.reduce((s, b) => s + b.usd, 0), 0) /
      days.reduce((t, d) => t + d.merged, 0);
    expect(rawMean(cur) / rawMean(base)).toBeCloseTo(1.25, 5);
    const [b, c] = standardizedCost(base, cur);
    expect(b).toBeCloseTo(20, 5);
    expect(c).toBeCloseTo(20, 5);
  });
});

describe("windowDays", () => {
  it("counts owner turns without twins and implementer runs over 500k", () => {
    const w = windowDays(kit());
    const first = w.days[0];
    expect(first.ownerTurns).toBe(4);
    expect(first).toMatchObject({
      compactManual: 1,
      compactAuto: 2,
      compactTurns: 2,
      implOver500k: 1,
    });
    expect(w.over500k).toEqual([
      {
        session: "s1234567",
        id: "agent-a1",
        desc: "Build stage 2",
        peakCtx: 859000,
        usd: 50,
      },
    ]);
    expect(w.missing).toEqual({
      followups: "followups.json is missing; run followups.mjs",
    });
  });

  it("names each input an older kit output lacks", () => {
    const old = kit();
    delete old.rollups.mainByDay;
    delete old.sessions[0].compactByDay;
    for (const a of old.agents) delete a.peakCtx;
    expect(Object.keys(windowDays(old).missing).sort()).toEqual([
      "followups",
      "mainByDay",
      "peakCtx",
      "sessionFields",
    ]);
  });

  it("counts follow-ups per series PR, leaving out Bump PRs", () => {
    const followups = {
      prs: [
        { pr: 1, day: day(1), bump: false, follows: [] },
        {
          pr: 2,
          day: day(1),
          bump: false,
          follows: [{ pr: 1, planned: true }],
        },
        {
          pr: 3,
          day: day(2),
          bump: false,
          follows: [{ pr: 2, planned: false }],
        },
        { pr: 4, day: day(2), bump: true, follows: [] },
      ],
    };
    const days = windowDays(kit({ followups })).days;
    const sum = (k) => days.reduce((t, d) => t + d[k], 0);
    expect([
      sum("seriesPRs"),
      sum("followups"),
      sum("planned"),
      sum("unplanned"),
    ]).toEqual([3, 2, 1, 1]);
  });
});

describe("trend", () => {
  const opts = { draws: 200, seed: 3 };

  it("prints every row it cannot measure as not measured with its reason, never as zero", () => {
    const old = kit();
    delete old.rollups.mainByDay;
    const out = trend(
      windowDays(old),
      windowDays(kit({ first: 11 })),
      null,
      opts,
    );
    const row = (name) => out.rows.find((r) => r.row === name);
    expect(row("main-session cost per merged PR")).toEqual({
      row: "main-session cost per merged PR",
      notMeasured: "baseline: rollups.json has no mainByDay",
    });
    expect(row("follow-ups per 100 merged PRs").notMeasured).toContain(
      "followups.json is missing",
    );
    expect(row("review day escape count").notMeasured).toContain(
      "--review-day",
    );
    expect(row("majors per lens round").notMeasured).toContain(
      "review ledgers",
    );
    expect(row("verifier's refuted share").notMeasured).toContain(
      "review ledgers",
    );
    expect(row("spend per day")).toMatchObject({
      baseline: 100,
      current: 100,
      ratio: 1,
      moved: false,
    });
    for (const r of out.rows)
      expect("notMeasured" in r || "value" in r || "ratio" in r).toBe(true);
  });

  it("prints the review day's dollars per landed unit by lens and its escape count when given", () => {
    const reviewDay = {
      usdPerLandedUnitByLens: { 1: 4.5, 3: 12 },
      escapes: 37,
    };
    const out = trend(
      windowDays(kit()),
      windowDays(kit({ first: 11 })),
      reviewDay,
      opts,
    );
    expect(out.rows.filter((r) => r.row.startsWith("review day"))).toEqual([
      { row: "review day dollars per landed unit, 1", value: 4.5 },
      { row: "review day dollars per landed unit, 3", value: 12 },
      { row: "review day escape count", value: 37 },
    ]);
  });
});

describe("command line", () => {
  function writeKit(k) {
    const dir = tempDir();
    dirs.push(dir);
    const write = (f, v) =>
      fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
    write("rollups.json", k.rollups);
    write("sessions-enriched.json", k.sessions);
    write("agents.json", k.agents);
    write("pr-cost.json", k.prCost);
    return dir;
  }

  it("writes trend.json to the current window's directory and the table to stdout", () => {
    const baseline = writeKit(kit());
    const current = writeKit(kit({ first: 11, spend: (i) => 200 + i }));
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--baseline", baseline, "--current", current, "--draws", "100"],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(
      /^spend per day: 100 -> 204\.5, ratio 2\.045 \[.*\]  MOVED$/m,
    );
    expect(run.stdout).toContain("implementer over 500k: s1234567 agent-a1");
    const written = JSON.parse(
      fs.readFileSync(path.join(current, "trend.json"), "utf8"),
    );
    expect(written.rows[0].row).toBe("spend per day");
  });

  it("requires both windows", () => {
    expect(parseArgs(["--baseline", "a"])).toEqual({
      ok: false,
      message: "--current is required",
    });
    expect(
      parseArgs(["--baseline", "a", "--current", "b", "--draws", "0"]).ok,
    ).toBe(false);
  });
});
