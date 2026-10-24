#!/usr/bin/env node
//
// Step 4 of the retro spend kit: measures over the files cost.mjs and map.mjs
// wrote to --dir -- the review apparatus (review-round lens and role agents,
// direct role subagents, panel, fix implementers), implementer runs and cost
// by model, main sessions over and up to 150 calls, owner turns per day and
// store, the top sessions, method D cost by PR size band, and the harness tax
// of reading CLAUDE.md from cache on every call. Writes analysis.json to --dir.
//
// Usage:
//   node analyze.mjs --dir DIR [--pricing FILE] [--call-index FILE]...
//     [--claude-md FILE]
//
// --pricing defaults to pricing.json beside this script. Each --call-index is
// a per-store table of main-session cost by call-index bucket, `{ buckets,
// sessions: [{ model, rows: [{ calls, cost, ctx }] }] }`; with none the
// call-index block is left out. --claude-md is the CLAUDE.md whose size the
// harness tax prices; without it that block is left out.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFlags, r2, readJson, runWhenMain, UsageError } from "./args.mjs";

const USAGE =
  "Usage: node analyze.mjs --dir DIR [--pricing FILE] [--call-index FILE]... [--claude-md FILE]\n";

const DEFAULT_PRICING = fileURLToPath(new URL("pricing.json", import.meta.url));

// A transcript records the workflow name it ran under, so a retro window can
// hold review runs under either name.
const REVIEW_ROUND_WF_NAMES = new Set(["review-round", "light-review"]);

// A rough ratio for English text.
const BYTES_PER_TOKEN = 3.7;

/**
 * Parse the analyze step's arguments. Returns `{ ok: true, options }` or
 * `{ ok: false, message }`.
 */
export function parseArgs(argv) {
  const parsed = parseFlags(argv, {
    values: ["--dir", "--pricing", "--claude-md"],
    lists: ["--call-index"],
    required: ["--dir"],
  });
  if (!parsed.ok) return parsed;
  if (parsed.positionals.length) {
    return { ok: false, message: `unexpected ${parsed.positionals[0]}` };
  }
  return {
    ok: true,
    options: {
      dir: parsed.values["--dir"],
      pricing: parsed.values["--pricing"] ?? DEFAULT_PRICING,
      callIndex: parsed.lists["--call-index"],
      claudeMd: parsed.values["--claude-md"] ?? null,
    },
  };
}

const sum = (a) => a.reduce((t, x) => t + x, 0);
const quantile = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
};

function review(agents, grand) {
  const lr = agents.filter(
    (a) => a.kind === "workflow-agent" && REVIEW_ROUND_WF_NAMES.has(a.wfName),
  );
  const role = lr.filter(
    (a) =>
      a.agentType === "security-reviewer" ||
      a.agentType === "adversarial-verifier",
  );
  const lens = lr.filter((a) => !role.includes(a));
  const directRole = agents.filter(
    (a) =>
      a.kind === "subagent" &&
      ["security-reviewer", "adversarial-verifier", "ux-reviewer"].includes(
        a.agentType,
      ),
  );
  const panel = agents.filter((a) => a.wfName === "panel");
  const reviewFix = agents.filter(
    (a) =>
      a.agentType === "implementer" &&
      /fix|address|finding|round|narrow|contest/i.test(a.desc),
  );
  const lrRuns = new Set(lr.map((a) => a.session + "/" + a.wf));
  const roleRuns = new Set(role.map((a) => a.session + "/" + a.wf));
  const costs = (list) => sum(list.map((a) => a.cost));
  const out = {
    reviewRoundRuns: lrRuns.size,
    roleRuns: roleRuns.size,
    lensRuns: lrRuns.size - roleRuns.size,
    lensUSD: r2(costs(lens)),
    roleUSD: r2(costs(role)),
    directRoleSubagentUSD: r2(costs(directRole)),
    panelUSD: r2(costs(panel)),
    apparatusUSD: r2(costs([...lr, ...directRole])),
    apparatusShare: r2(costs([...lr, ...directRole]) / grand),
    fixImplementersUSD: r2(costs(reviewFix)),
    fixImplementers: reviewFix.length,
    apparatusPlusFixShare: r2(
      costs([...lr, ...directRole, ...reviewFix]) / grand,
    ),
    meanLensRunUSD: r2(costs(lens) / Math.max(1, lrRuns.size - roleRuns.size)),
    meanRoleRunUSD: r2(costs(role) / Math.max(1, roleRuns.size)),
  };
  const runsPerRef = {};
  for (const a of lr) {
    if (!a.targetRef) continue;
    (runsPerRef[a.targetRef] || (runsPerRef[a.targetRef] = new Set())).add(
      a.session + "/" + a.wf,
    );
  }
  const rc = Object.values(runsPerRef).map((s) => s.size);
  out.refsReviewed = rc.length;
  out.runsPerRefMedian = quantile(rc, 0.5);
  out.runsPerRefP90 = quantile(rc, 0.9);
  out.runsPerRefMax = rc.length ? Math.max(...rc) : null;
  return { out, reviewFix };
}

function implementers(agents, sessions, reviewFix, grand) {
  const imp = agents.filter((a) => a.agentType === "implementer");
  const byModel = {};
  for (const a of imp) {
    const r =
      byModel[a.model] || (byModel[a.model] = { n: 0, usd: 0, calls: 0 });
    r.n++;
    r.usd += a.cost;
    r.calls += a.calls;
  }
  for (const r of Object.values(byModel)) {
    r.meanUSD = r2(r.usd / r.n);
    r.usdPerCall = r2((r.usd / r.calls) * 100) / 100;
    r.usd = r2(r.usd);
    r.callsPer = Math.round(r.calls / r.n);
  }
  const spawnCalls = sessions.reduce(
    (t, s) => t + s.spawns.filter((x) => x.type === "implementer").length,
    0,
  );
  const costs = imp.map((a) => a.cost);
  const out = {
    transcripts: imp.length,
    spawnToolCallsInMain: spawnCalls,
    totalUSD: r2(sum(costs)),
    share: r2(sum(costs) / grand),
    meanUSD: r2(sum(costs) / imp.length),
    medianUSD: r2(quantile(costs, 0.5)),
    p90USD: r2(quantile(costs, 0.9)),
    byModel,
    fixLike: {
      n: reviewFix.length,
      usd: r2(sum(reviewFix.map((a) => a.cost))),
    },
  };
  const opus55 = imp.filter((a) => a.model === "claude-opus-5-5");
  out.opus55FirstTs = opus55.map((a) => a.firstTs).sort()[0] || null;
  const after = imp.filter(
    (a) => a.model === "claude-opus-5" && a.firstTs >= out.opus55FirstTs,
  );
  out.opus5AfterOpus55Start = {
    n: after.length,
    meanUSD: r2(sum(after.map((a) => a.cost)) / Math.max(1, after.length)),
    callsPer: Math.round(
      sum(after.map((a) => a.calls)) / Math.max(1, after.length),
    ),
  };
  return out;
}

function sessionLength(sessions) {
  const orch = sessions.filter(
    (s) => s.kind === "session" && s.mainCalls >= 10,
  );
  const group = (list) => ({
    sessions: list.length,
    mainUSD: r2(sum(list.map((s) => s.cost.main))),
    mainCalls: sum(list.map((s) => s.mainCalls)),
    usdPerMainCall:
      r2(
        (sum(list.map((s) => s.cost.main)) /
          sum(list.map((s) => s.mainCalls))) *
          1000,
      ) / 1000,
    medianUsdPerMainCall:
      r2(
        quantile(
          list.map((s) => s.cost.main / s.mainCalls),
          0.5,
        ) * 1000,
      ) / 1000,
    meanCtxPerCall: Math.round(
      sum(list.map((s) => s.mainCtxPerCall * s.mainCalls)) /
        sum(list.map((s) => s.mainCalls)),
    ),
    totalUSDinclAgents: r2(sum(list.map((s) => s.cost.total))),
  });
  const fable = (s) => /fable/.test(s.domModel);
  return {
    over150: group(orch.filter((s) => s.mainCalls > 150)),
    upTo150: group(orch.filter((s) => s.mainCalls <= 150)),
    over150Fable: group(orch.filter((s) => s.mainCalls > 150 && fable(s))),
    upTo150Fable: group(orch.filter((s) => s.mainCalls <= 150 && fable(s))),
  };
}

function callIndex(tables) {
  const B = tables[0].buckets;
  for (const table of tables) {
    if (JSON.stringify(table.buckets) !== JSON.stringify(B)) {
      throw new Error(
        `call-index tables disagree on buckets: ${JSON.stringify(B)} and ${JSON.stringify(table.buckets)}`,
      );
    }
  }
  const split = B.findIndex((b, i) => i > 0 && B[i - 1] === 150 && b > 150);
  if (split < 0) {
    throw new Error(
      `call-index buckets ${JSON.stringify(B)} have no 150-call boundary`,
    );
  }
  const agg = B.map(() => ({ calls: 0, cost: 0, ctx: 0 }));
  const aggFable = B.map(() => ({ calls: 0, cost: 0, ctx: 0 }));
  let costPast150 = 0;
  for (const table of tables) {
    for (const s of table.sessions) {
      s.rows.forEach((r, i) => {
        for (const A of [
          agg,
          ...(/fable/.test(s.model || "") ? [aggFable] : []),
        ]) {
          A[i].calls += r.calls;
          A[i].cost += r.cost;
          A[i].ctx += r.ctx;
        }
        if (i >= split) costPast150 += r.cost;
      });
    }
  }
  const fmt = (A) =>
    A.map((r, i) => ({
      upTo: B[i] > 1e8 ? "max" : B[i],
      calls: r.calls,
      usdPerCall: r.calls ? r2((r.cost / r.calls) * 1000) / 1000 : null,
      meanCtx: r.calls ? Math.round(r.ctx / r.calls) : null,
      usd: r2(r.cost),
    }));
  const out = {
    all: fmt(agg),
    fable: fmt(aggFable),
    mainUSDpastCall150: r2(costPast150),
  };
  const total = (rows) =>
    rows.reduce((t, r) => ({ c: t.c + r.calls, u: t.u + r.cost }), {
      c: 0,
      u: 0,
    });
  const early = total(agg.slice(0, split));
  const late = total(agg.slice(split));
  out.usdPerCall_1to150 = r2((early.u / early.c) * 1000) / 1000;
  out.usdPerCall_151plus = r2((late.u / late.c) * 1000) / 1000;
  out.callsPast150 = late.c;
  out.savingIfPast150AtEarlyRate = r2(late.u - (late.c * early.u) / early.c);
  return out;
}

function ownerTurns(sessions) {
  const own = {};
  const kinds = {};
  for (const s of sessions) {
    for (const [day, k] of Object.entries(s.ownerByDay || {})) {
      const n = (k.typed || 0) + (k.command || 0) + (k.interrupt || 0);
      const d = own[day] || (own[day] = {});
      d[s.store] = (d[s.store] || 0) + n;
      d.all = (d.all || 0) + n;
      for (const [kk, v] of Object.entries(k)) kinds[kk] = (kinds[kk] || 0) + v;
    }
  }
  const days = Object.keys(own).sort();
  const bySeat = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(own[d]))
      bySeat[k] = (bySeat[k] || 0) + v;
  }
  return {
    byDay: Object.fromEntries(days.map((d) => [d, own[d]])),
    bySeat,
    kinds,
    days: days.length,
    perDayMean: r2(bySeat.all / days.length),
    perDayMedian: quantile(
      days.map((d) => own[d].all),
      0.5,
    ),
  };
}

function sizeBands(prCost) {
  const merged = prCost.filter((r) => r.costD > 0);
  const sizes = merged.map((r) => r.size).sort((a, b) => a - b);
  const cuts = [
    quantile(sizes, 0.25),
    quantile(sizes, 0.5),
    quantile(sizes, 0.75),
  ];
  const bands = [0, 1, 2, 3].map((i) => {
    const L = merged.filter((r) =>
      i === 0
        ? r.size <= cuts[0]
        : i === 3
          ? r.size > cuts[2]
          : r.size > cuts[i - 1] && r.size <= cuts[i],
    );
    return {
      band: i + 1,
      sizeMax: Math.max(...L.map((r) => r.size)),
      prs: L.length,
      medianUSD: r2(
        quantile(
          L.map((r) => r.costD),
          0.5,
        ),
      ),
    };
  });
  const xs = merged.map((r) => r.size);
  const ys = merged.map((r) => r.costD);
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  const pearson = r2(
    sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) /
      Math.sqrt(
        sum(xs.map((x) => (x - mx) ** 2)) * sum(ys.map((y) => (y - my) ** 2)),
      ),
  );
  return { bands, pearson };
}

/**
 * The measures over cost.mjs and map.mjs output. `input` has `sessions`,
 * `agents`, `prCost`, `rollups`, `pricing` (the `models` table), `callIndex`
 * (call-index tables, possibly empty) and `claudeMdBytes` (or null). Returns
 * analysis.json.
 */
export function analyze(input) {
  const { sessions, agents, prCost, rollups, pricing } = input;
  const grand = rollups.grandTotalUSD;
  const out = {};
  const { out: reviewOut, reviewFix } = review(agents, grand);
  out.review = reviewOut;
  out.implementers = implementers(agents, sessions, reviewFix, grand);
  out.sessionLength = sessionLength(sessions);
  if (input.callIndex.length) out.callIndex = callIndex(input.callIndex);
  out.ownerTurns = ownerTurns(sessions);
  out.topSessions = sessions.slice(0, 12).map((s) => ({
    store: s.store,
    id: s.id.slice(0, 8),
    first: s.winFirstTs?.slice(0, 16),
    last: s.winLastTs?.slice(0, 16),
    model: s.domModel,
    mainCalls: s.mainCalls,
    ctxPerCall: s.mainCtxPerCall,
    usdMain: s.cost.main,
    usdSubagents: s.cost.subagents,
    usdWorkflow: s.cost.workflow,
    usdTotal: s.cost.total,
    subagentCount: s.subagentCount,
    wfAgents: s.wfAgentCount,
    ownerTurns: s.userTurns,
  }));
  out.topSessionsShare = r2(
    sum(sessions.slice(0, 10).map((s) => s.cost.total)) / grand,
  );
  const { bands, pearson } = sizeBands(prCost);
  out.sizeBandsD = bands;
  out.costSizePearsonD = pearson;
  if (input.claudeMdBytes !== null) {
    const tokens = Math.round(input.claudeMdBytes / BYTES_PER_TOKEN);
    let tax = 0;
    for (const [m, u] of Object.entries(rollups.byModel)) {
      if (pricing[m]) tax += (u.calls * tokens * pricing[m].cacheRead) / 1e6;
    }
    out.harnessTax = {
      claudeMdBytes: input.claudeMdBytes,
      claudeMdTokensApprox: tokens,
      cacheReadUSD: r2(tax),
      totalCalls: sum(Object.values(rollups.byModel).map((u) => u.calls)),
    };
  }
  return out;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new UsageError(parsed.message);
  const { options } = parsed;
  const read = (f) => readJson(path.join(options.dir, f));
  const out = analyze({
    sessions: read("sessions-enriched.json"),
    agents: read("agents.json"),
    prCost: read("pr-cost.json"),
    rollups: read("rollups.json"),
    pricing: readJson(options.pricing).models,
    callIndex: options.callIndex.map(readJson),
    claudeMdBytes: options.claudeMd ? fs.statSync(options.claudeMd).size : null,
  });
  fs.writeFileSync(
    path.join(options.dir, "analysis.json"),
    JSON.stringify(out, null, 1),
  );
  console.log(
    JSON.stringify(
      { ...out, ownerTurns: { ...out.ownerTurns, byDay: undefined } },
      null,
      1,
    ),
  );
}

runWhenMain(import.meta.url, USAGE, main);
