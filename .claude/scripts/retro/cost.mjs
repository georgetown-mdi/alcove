#!/usr/bin/env node
//
// Step 2 of the retro spend kit: price the store aggregates aggregate.mjs
// wrote and split every session into main, subagent and workflow-agent
// components. Writes to --out-dir:
//   rollups.json            totals, window days and spend per day, and spend by
//                           model, store (`bySeat`), component, UTC day, cost
//                           anatomy, context per call, workflow name and denial;
//                           `streamFix` compares each model and component's
//                           output with its first-entry count
//   sessions-enriched.json  one row per session with spend or owner turns
//   agents.json             one row per subagent or workflow agent with calls
//
// Usage:
//   node cost.mjs --out-dir DIR [--pricing FILE] [--first-entry-output]
//     AGGREGATE...
//
// --pricing defaults to pricing.json beside this script: USD per million
// tokens by model, for input, output, cache reads and 5m and 1h cache writes.
// --first-entry-output prices each streamed message's output at its first
// entry's count (`outFirst`), the total with the streamed-usage rule left out.
// The aggregates must share one window. Window days run from the cut to the
// latest window entry in any of them.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFlags, r2, readJson, runWhenMain, UsageError } from "./args.mjs";

const USAGE =
  "Usage: node cost.mjs --out-dir DIR [--pricing FILE] [--first-entry-output] AGGREGATE...\n";

const DEFAULT_PRICING = fileURLToPath(new URL("pricing.json", import.meta.url));

/**
 * Parse the cost step's arguments. Returns `{ ok: true, options }` or
 * `{ ok: false, message }`.
 */
export function parseArgs(argv) {
  const parsed = parseFlags(argv, {
    values: ["--out-dir", "--pricing"],
    booleans: ["--first-entry-output"],
    required: ["--out-dir"],
  });
  if (!parsed.ok) return parsed;
  if (!parsed.positionals.length) {
    return { ok: false, message: "name at least one aggregate" };
  }
  return {
    ok: true,
    options: {
      outDir: parsed.values["--out-dir"],
      pricing: parsed.values["--pricing"] ?? DEFAULT_PRICING,
      firstEntryOutput: parsed.booleans["--first-entry-output"],
      aggregates: parsed.positionals,
    },
  };
}

function useFirstEntryOutput(sessions) {
  const fix = (bucket) => {
    for (const u of Object.values(bucket || {})) {
      if (u && typeof u === "object" && "outFirst" in u) u.out = u.outFirst;
    }
  };
  for (const s of sessions) {
    for (const r of [s, ...(s.subagents || [])]) {
      fix(r.usageWin);
      fix(r.usageSidechainWin);
      fix(r.dupWin);
      for (const d of Object.values(r.byDay || {})) fix(d);
    }
  }
}

function tier(m) {
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "other";
}

function callsOf(byModel) {
  return Object.values(byModel || {}).reduce((a, u) => a + u.calls, 0);
}

function ctxTokens(u) {
  return u.in + u.cacheRead + u.cache5m + u.cache1h;
}

function windowOf(aggregates) {
  const [first] = aggregates;
  for (const a of aggregates) {
    if (
      Date.parse(a.cut) !== Date.parse(first.cut) ||
      Date.parse(a.end) !== Date.parse(first.end)
    ) {
      throw new UsageError(
        `aggregates ${first.store} and ${a.store} cover different windows`,
      );
    }
  }
  let lastEntryTs = null;
  for (const a of aggregates) {
    for (const s of a.sessions) {
      for (const r of [s, ...s.subagents]) {
        if (r.winLastTs && (!lastEntryTs || r.winLastTs > lastEntryTs)) {
          lastEntryTs = r.winLastTs;
        }
      }
    }
  }
  const days = lastEntryTs
    ? (Date.parse(lastEntryTs) - Date.parse(first.cut)) / 864e5
    : 0;
  return { cut: first.cut, end: first.end, lastEntryTs, days };
}

/**
 * Price `aggregates` (parsed aggregate.mjs outputs, modified in place under
 * firstEntryOutput) under `pricing` (the `models` table). Returns `{ rollups,
 * enriched, agents }`, the three files the step writes.
 */
export function cost(aggregates, pricing, { firstEntryOutput = false } = {}) {
  const unknownModels = {};
  const price = (model, alt) =>
    alt && model === "claude-sonnet-5"
      ? pricing["claude-sonnet-5-intro"]
      : pricing[model];
  const parts = (model, u, alt) => {
    const p = price(model, alt);
    if (!p) return null;
    return {
      in: (u.in * p.in) / 1e6,
      out: (u.out * p.out) / 1e6,
      cacheRead: (u.cacheRead * p.cacheRead) / 1e6,
      cacheWrite: (u.cache5m * p.cache5m + u.cache1h * p.cache1h) / 1e6,
    };
  };
  const costOf = (byModel, alt) => {
    let c = 0;
    for (const [m, u] of Object.entries(byModel || {})) {
      const p = parts(m, u, alt);
      if (p) c += p.in + p.out + p.cacheRead + p.cacheWrite;
    }
    return c;
  };

  const byModel = {};
  const bySeat = {};
  const byDay = {};
  const anatomy = {};
  const ctx = {};
  const denials = {};
  const wfNames = {};
  const streamFix = {};
  let grand = 0;
  let grandAlt = 0;
  let dupCost = 0;
  const roll = (store, comp, usage, dayUsage) => {
    for (const [m, u] of Object.entries(usage || {})) {
      const p = parts(m, u);
      if (!p) {
        unknownModels[m] = (unknownModels[m] || 0) + u.calls;
        continue;
      }
      const c = p.in + p.out + p.cacheRead + p.cacheWrite;
      const bm =
        byModel[m] ||
        (byModel[m] = {
          calls: 0,
          cost: 0,
          main: 0,
          subagent: 0,
          "workflow-agent": 0,
        });
      bm.calls += u.calls;
      bm.cost += c;
      bm[comp] += c;
      const bs =
        bySeat[store] ||
        (bySeat[store] = {
          cost: 0,
          main: 0,
          subagent: 0,
          "workflow-agent": 0,
          calls: 0,
        });
      bs.cost += c;
      bs[comp] += c;
      bs.calls += u.calls;
      const t = tier(m);
      const sf =
        streamFix[`${m}|${comp}`] ||
        (streamFix[`${m}|${comp}`] = {
          calls: 0,
          outTok: 0,
          outFirstTok: 0,
          extraUSD: 0,
          costUSD: 0,
        });
      sf.calls += u.calls;
      sf.outTok += u.out;
      sf.outFirstTok += u.outFirst || 0;
      sf.extraUSD += ((u.out - (u.outFirst || 0)) * pricing[m].out) / 1e6;
      sf.costUSD += c;
      for (const k of [t, "all"]) {
        const a =
          anatomy[k] ||
          (anatomy[k] = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
        a.in += p.in;
        a.out += p.out;
        a.cacheRead += p.cacheRead;
        a.cacheWrite += p.cacheWrite;
      }
      const ck = `${t}|${comp}`;
      const x =
        ctx[ck] || (ctx[ck] = { calls: 0, ctxTok: 0, outTok: 0, max: 0 });
      x.calls += u.calls;
      x.ctxTok += ctxTokens(u);
      x.outTok += u.out;
      x.max = Math.max(x.max, u.ctxMax || 0);
      grand += c;
    }
    grandAlt += costOf(usage, true);
    for (const [day, du] of Object.entries(dayUsage || {})) {
      byDay[day] = (byDay[day] || 0) + costOf(du);
    }
  };
  const addDenials = (comp, d) => {
    for (const [k, n] of Object.entries(d || {})) {
      const r =
        denials[k] ||
        (denials[k] = { main: 0, subagent: 0, "workflow-agent": 0 });
      r[comp] += n;
    }
  };

  const window = windowOf(aggregates);
  const enriched = [];
  const agents = [];
  for (const { store, sessions } of aggregates) {
    if (firstEntryOutput) useFirstEntryOutput(sessions);
    for (const s of sessions) {
      const mainUsage = {};
      for (const src of [s.usageWin, s.usageSidechainWin]) {
        for (const [m, u] of Object.entries(src || {})) {
          const t =
            mainUsage[m] ||
            (mainUsage[m] = {
              calls: 0,
              in: 0,
              out: 0,
              outFirst: 0,
              cacheRead: 0,
              cache5m: 0,
              cache1h: 0,
              ctxMax: 0,
            });
          for (const k of [
            "calls",
            "in",
            "out",
            "outFirst",
            "cacheRead",
            "cache5m",
            "cache1h",
          ]) {
            t[k] += u[k];
          }
          t.ctxMax = Math.max(t.ctxMax, u.ctxMax || 0);
        }
      }
      roll(store, "main", mainUsage, s.byDay);
      addDenials("main", s.denials);
      dupCost += costOf(s.dupWin);
      const mainCost = costOf(mainUsage);
      let subCost = 0;
      let wfCost = 0;
      const subBranches = {};
      const wfBranches = {};
      const wfRefs = {};
      const mentions = { ...s.prMentions };
      // An agent file written after the cut may contain only entries past --end.
      const windowAgents = s.subagents.filter((a) => a.winFirstTs);
      for (const a of windowAgents) {
        roll(store, a.kind, a.usageWin, a.byDay);
        addDenials(a.kind, a.denials);
        dupCost += costOf(a.dupWin);
        const c = costOf(a.usageWin);
        if (a.kind === "workflow-agent") {
          wfCost += c;
          const n = a.wfName || "unknown";
          const w =
            wfNames[n] ||
            (wfNames[n] = { agents: 0, cost: 0, runs: new Set() });
          w.agents++;
          w.cost += c;
          w.runs.add(s.id + "/" + a.wf);
          for (const [b, k] of Object.entries(a.branches)) {
            wfBranches[b] = (wfBranches[b] || 0) + k;
          }
          if (a.targetRef) wfRefs[a.targetRef] = (wfRefs[a.targetRef] || 0) + 1;
        } else {
          subCost += c;
          for (const [b, k] of Object.entries(a.branches)) {
            subBranches[b] = (subBranches[b] || 0) + k;
          }
        }
        for (const [n, k] of Object.entries(a.prMentions)) {
          mentions[n] = (mentions[n] || 0) + k;
        }
        const models = Object.entries(a.usageWin)
          .sort((x, y) => y[1].calls - x[1].calls)
          .map(([m]) => m);
        const calls = callsOf(a.usageWin);
        const ctxTok = Object.values(a.usageWin).reduce(
          (t, u) => t + ctxTokens(u),
          0,
        );
        if (calls) {
          agents.push({
            store,
            session: s.id,
            id: a.id,
            kind: a.kind,
            agentType: a.agentType,
            metaModel: a.metaModel,
            model: models[0] || null,
            desc: a.desc,
            wf: a.wf,
            wfName: a.wfName,
            targetRef: a.targetRef,
            firstTs: a.winFirstTs,
            calls,
            cost: r2(c),
            ctxPerCall: Math.round(ctxTok / calls),
            branches: Object.keys(a.branches),
            prMentions: Object.keys(a.prMentions).map(Number),
            denials: a.denials,
            toolErrors: a.toolErrors,
            promptHead: a.promptHead,
          });
        }
      }
      const total = mainCost + subCost + wfCost;
      if (total < 0.005 && !Object.keys(s.ownerByDay).length) continue;
      const mainCalls = callsOf(mainUsage);
      enriched.push({
        store,
        id: s.id,
        kind: s.kind,
        projectDir: s.projectDir,
        winFirstTs: s.winFirstTs,
        winLastTs: s.winLastTs,
        mainModels: Object.keys(mainUsage),
        domModel:
          Object.entries(mainUsage).sort(
            (x, y) => y[1].calls - x[1].calls,
          )[0]?.[0] || null,
        mainCalls,
        cost: {
          main: r2(mainCost),
          subagents: r2(subCost),
          workflow: r2(wfCost),
          total: r2(total),
        },
        mainCtxPerCall: mainCalls
          ? Math.round(
              Object.values(mainUsage).reduce((t, u) => t + ctxTokens(u), 0) /
                mainCalls,
            )
          : 0,
        subagentCount: windowAgents.filter((a) => a.kind === "subagent").length,
        wfAgentCount: windowAgents.filter((a) => a.kind === "workflow-agent")
          .length,
        workflowRuns: Object.keys(s.workflowRuns || {}).length,
        userTurns: s.userTurns,
        interrupts: s.interrupts,
        ownerByDay: s.ownerByDay,
        compactions: s.compactions,
        toolErrors: s.toolErrors,
        denials: s.denials,
        branches: s.branches,
        subBranches,
        wfBranches,
        wfRefs,
        prMentions: mentions,
        spawns: s.spawns,
        commands: s.commands,
        skills: s.skills,
      });
    }
  }
  enriched.sort((a, b) => b.cost.total - a.cost.total);
  const roundAll = (o) => {
    for (const v of Object.values(o)) {
      for (const k of Object.keys(v)) {
        if (typeof v[k] === "number") v[k] = r2(v[k]);
      }
    }
    return o;
  };
  const anat = {};
  for (const [k, a] of Object.entries(anatomy)) {
    const t = a.in + a.out + a.cacheRead + a.cacheWrite;
    anat[k] = {
      totalUSD: r2(t),
      input: r2(a.in / t),
      output: r2(a.out / t),
      cacheRead: r2(a.cacheRead / t),
      cacheWrite: r2(a.cacheWrite / t),
    };
  }
  const ctxOut = {};
  for (const [k, x] of Object.entries(ctx)) {
    ctxOut[k] = {
      calls: x.calls,
      meanCtxTok: Math.round(x.ctxTok / x.calls),
      meanOutTok: Math.round(x.outTok / x.calls),
      maxCtxTok: x.max,
    };
  }
  const wfOut = {};
  for (const [k, w] of Object.entries(wfNames)) {
    wfOut[k] = { runs: w.runs.size, agents: w.agents, cost: r2(w.cost) };
  }
  const sfOut = {};
  let sfExtra = 0;
  for (const [k, x] of Object.entries(streamFix)) {
    sfExtra += x.extraUSD;
    sfOut[k] = {
      calls: x.calls,
      outTok: x.outTok,
      outFirstTok: x.outFirstTok,
      outFactor: x.outFirstTok ? r2(x.outTok / x.outFirstTok) : null,
      costUSD: r2(x.costUSD),
      uncorrectedUSD: r2(x.costUSD - x.extraUSD),
      costFactor: r2(x.costUSD / (x.costUSD - x.extraUSD)),
    };
  }
  const rollups = {
    grandTotalUSD: r2(grand),
    uncorrectedTotalUSD: r2(grand - sfExtra),
    firstEntryOutput,
    window: { ...window, days: r2(window.days) },
    perDayUSD: window.days ? r2(grand / window.days) : null,
    uncorrectedPerDayUSD: window.days
      ? r2((grand - sfExtra) / window.days)
      : null,
    streamFix: sfOut,
    grandTotalSonnetIntroUSD: r2(grandAlt),
    crossFileDuplicateUSD: r2(dupCost),
    byModel: roundAll(byModel),
    bySeat: roundAll(bySeat),
    anatomy: anat,
    contextPerCall: ctxOut,
    workflowsByName: wfOut,
    denials,
    byDay: Object.fromEntries(
      Object.entries(byDay)
        .sort()
        .map(([d, c]) => [d, r2(c)]),
    ),
    unknownModels,
  };
  return { rollups, enriched, agents };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new UsageError(parsed.message);
  const { options } = parsed;
  const pricing = readJson(options.pricing).models;
  const aggregates = options.aggregates.map(readJson);
  const { rollups, enriched, agents } = cost(aggregates, pricing, options);
  fs.mkdirSync(options.outDir, { recursive: true });
  const write = (name, value, indent) =>
    fs.writeFileSync(
      path.join(options.outDir, name),
      JSON.stringify(value, null, indent),
    );
  write("sessions-enriched.json", enriched, 1);
  write("agents.json", agents);
  write("rollups.json", rollups, 1);
  console.log(JSON.stringify({ ...rollups, byDay: undefined }, null, 1));
}

runWhenMain(import.meta.url, USAGE, main);
