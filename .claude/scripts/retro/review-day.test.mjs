import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  ACCOUNT_WIDE,
  deliveredBy,
  parseArgs,
  parseFiled,
  readDays,
  reviewDayReport,
  weeklyShare,
} from "./review-day.mjs";
import { tempDir } from "./transcriptFixtures.mjs";

const SCRIPT = fileURLToPath(new URL("./review-day.mjs", import.meta.url));
const dirs = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const HOUR = 3600 * 1000;
const START = Date.parse("2026-11-20T09:00:00Z");
const END = START + 8 * HOUR;

const finding = (id, extra) => ({
  id,
  slice: "s1",
  lens: 2,
  severity: "major",
  verdict: "CONFIRMED",
  behaviourChanging: false,
  reachable: false,
  security: false,
  raisedBefore: false,
  window: "untouched",
  sort: "fix",
  outcome: "drop",
  ...extra,
});

const record = () => ({
  sha: "a".repeat(40),
  window: { from: "b".repeat(40), to: "a".repeat(40), commits: 10 },
  slices: [
    { id: "s1", lens: 2, selector: "census", lines: 900, cost: 30 },
    { id: "s2", lens: 3, selector: "outward", lines: 700, cost: 20 },
    { id: "s3", lens: 4, selector: "hot", lines: 800, cost: 10 },
  ],
  findings: [
    finding("delivered", {
      behaviourChanging: true,
      security: true,
      window: "reviewed",
      outcome: "fix-a",
    }),
    finding("delivered-claim", { lens: 3, slice: "s2", outcome: "fix-a" }),
    finding("undelivered", {
      lens: 3,
      slice: "s2",
      raisedBefore: true,
      outcome: "fix-b",
    }),
    finding("no-item", { lens: 4, slice: "s3", outcome: "held" }),
    finding("refuted", {
      lens: 1,
      behaviourChanging: true,
      verdict: "REFUTED",
      window: "reviewed",
      outcome: "10/1",
    }),
  ],
  totals: { ownerCalls: 3 },
  spend: { day: 120, fortnight: 900, weeklyAllowanceShare: null },
});

const FILED = "fix-a -> 10/1\nfix-b -> 10/2\n";
const BOARD = {
  "10/1": "Summary.\n\nDelivered by: #500 (2026-11-24)\n",
  "10/2": "Summary, not delivered.\n",
};
const PR_COST = [{ number: 500, costD: 40 }];
const FOLLOWUPS = {
  prs: [
    { pr: 500, bump: false, follows: [] },
    { pr: 510, bump: false, follows: [{ pr: 500, planned: false }] },
  ],
};

function writeDays() {
  const root = tempDir();
  dirs.push(root);
  const final = path.join(root, "2026-11-20", "FINAL");
  fs.mkdirSync(final, { recursive: true });
  const write = (name, text, ms) => {
    const file = path.join(final, name);
    fs.writeFileSync(file, text);
    fs.utimesSync(file, ms / 1000, ms / 1000);
  };
  write("filed.md", FILED, START);
  write("record.json", JSON.stringify(record()), END);
  fs.mkdirSync(path.join(root, "2026-11-27"));
  return root;
}

function report(extra = {}) {
  const { days, skipped } = readDays(writeDays(), null, null);
  return reviewDayReport({
    days,
    skipped,
    bodies: new Map(Object.entries(BOARD)),
    prCost: PR_COST,
    followups: FOLLOWUPS,
    readings: null,
    usagePath: "/no/such/log",
    retro: null,
    ...extra,
  });
}

describe("the value-unit join", () => {
  it("counts a delivered item's findings, not an undelivered one's or a finding with no item", () => {
    const out = report();
    expect(out.records).toBe(1);
    expect(out.landedUnitsByLens).toEqual({ 1: 0, 2: 1, 3: 1, 4: 0 });
    expect(out.itemsFiled).toBe(2);
    expect(out.itemsDelivered).toBe(1);
  });

  it("prices a landed unit at its lens's day cost plus its share of the fix PR", () => {
    // spend.day 120 over slice costs 60 scales each lens by 2; PR #500's 40 is
    // shared by its two units.
    expect(report().usdPerLandedUnitByLens).toEqual({
      1: null,
      2: 80,
      3: 60,
      4: null,
    });
  });

  it("counts the escape, its security subset, the lag and the owner calls, leaving the refuted finding out", () => {
    const out = report();
    expect(out).toMatchObject({
      findings: 4,
      escapes: 1,
      security: 1,
      escapesSecurity: 1,
      raisedBefore: 1,
      ownerCalls: 3,
    });
    expect(out.days[0]).toMatchObject({ day: "2026-11-20", escapes: 1 });
    expect(out.notes).toContain("days with no FINAL/record.json: 2026-11-27");
  });

  it("counts the fix PRs a follow-up amended, and says so when it has no follow-up series", () => {
    expect(report()).toMatchObject({
      fixPrsInFollowupSeries: 1,
      fixPrsAmended: 1,
    });
    const out = report({ followups: null });
    expect(out.fixPrsAmended).toBeNull();
    expect(out.notes.join("\n")).toContain("no --followups given");
  });

  it("names a fix PR the kit has no cost for, and leaves its cost out", () => {
    const out = report({ prCost: [] });
    expect(out.usdPerLandedUnitByLens[2]).toBe(60);
    expect(out.notes.join("\n")).toContain("#500");
  });
});

describe("weeklyShare", () => {
  const reset1 = Date.parse("2026-11-20T12:00:00Z") / 1000;
  const reset2 = reset1 + 7 * 86400;
  const at = (h, pct, resetsAt) => ({
    t: START + h * HOUR,
    weeklyUsedPercent: pct,
    resetsAt,
  });

  it("sums across a reset inside the window rather than subtracting", () => {
    const readings = [
      at(-1, 40, reset1),
      at(1, 45, reset1),
      at(2, 44, reset1),
      at(2.5, 47, reset1),
      at(4, 3, reset2),
      at(6, 5, reset2),
    ];
    expect(weeklyShare(readings, START, END)).toBe(7 + 3 + 2);
  });

  it("takes a reset time moved before it falls due as a change, not a reset", () => {
    const readings = [at(-1, 90, reset2), at(1, 92, reset1), at(2, 95, reset1)];
    expect(weeklyShare(readings, START, END)).toBe(5);
  });

  it("is null with no reading in the window", () => {
    expect(weeklyShare([at(-1, 40, reset1)], START, END)).toBeNull();
  });
});

describe("parsers", () => {
  it("reads the PR numbers of a Delivered by line", () => {
    expect(deliveredBy("x\nDelivered by: #12, #15 (2026-11-01)\n")).toEqual({
      delivered: true,
      prs: [12, 15],
    });
    expect(deliveredBy("x\nDelivered by: <host result> (2026-11-01)")).toEqual({
      delivered: true,
      prs: [],
    });
    expect(deliveredBy(undefined).delivered).toBe(false);
  });

  it("maps drafts to items from filed.md", () => {
    expect([...parseFiled("# Filed\nfix-a -> 10/1\nnoise\n")]).toEqual([
      ["fix-a", "10/1"],
    ]);
  });

  it("defaults the usage log and checks the retro window", () => {
    const ok = parseArgs(["--days", "d", "--out", "o"]);
    expect(ok.options.usage).toMatch(/\.claude[/\\]usage-readings\.jsonl$/);
    expect(
      parseArgs(["--days", "d", "--out", "o", "--retro-usd", "3"]).ok,
    ).toBe(false);
    expect(parseArgs(["--days", "d", "--out", "o", "--cut", "11-20"]).ok).toBe(
      false,
    );
  });
});

describe("command line", () => {
  function run(usage) {
    const days = writeDays();
    const board = path.join(days, "board.json");
    fs.writeFileSync(board, JSON.stringify(BOARD));
    const out = path.join(days, "review-day.json");
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--days",
        days,
        "--out",
        out,
        "--board",
        board,
        "--usage",
        usage,
        "--retro-start",
        new Date(START).toISOString(),
        "--retro-end",
        new Date(END).toISOString(),
        "--retro-usd",
        "15",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    return {
      stdout: result.stdout,
      written: JSON.parse(fs.readFileSync(out, "utf8")),
    };
  }

  it("prints the dollars alone and says so when the usage log is missing", () => {
    const logDir = tempDir();
    dirs.push(logDir);
    const { stdout, written } = run(path.join(logDir, "missing.jsonl"));
    expect(written.days[0].spend).toMatchObject({
      usd: 120,
      weeklySharePct: null,
    });
    expect(stdout).toMatch(/spend \$120 \(no usage log at .*; dollars alone\)/);
    expect(stdout).toMatch(/retro spend \$15 \(no usage log at .*\)/);
    expect(stdout).toContain("no --pr-cost given");
  });

  it("prints the share beside the dollars, stating it is account-wide", () => {
    const logDir = tempDir();
    dirs.push(logDir);
    const log = path.join(logDir, "usage-readings.jsonl");
    const resetAt = (START + 3 * HOUR) / 1000;
    const line = (h, pct, resetsAt) =>
      JSON.stringify({
        t: new Date(START + h * HOUR).toISOString(),
        weeklyUsedPercent: pct,
        resetsAt,
        session: "s",
      });
    fs.writeFileSync(
      log,
      [
        line(-2, 50, resetAt),
        line(1, 58, resetAt),
        line(4, 2, resetAt + 7 * 86400),
        "not json",
      ].join("\n"),
    );
    const { stdout, written } = run(log);
    expect(written.days[0].spend.weeklySharePct).toBe(10);
    expect(stdout).toContain(
      `spend $120, 10% of the weekly allowance (${ACCOUNT_WIDE})`,
    );
    expect(written.retro.weeklySharePct).toBe(10);
  });
});
