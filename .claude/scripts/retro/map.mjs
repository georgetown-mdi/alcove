#!/usr/bin/env node
//
// Step 3 of the retro spend kit: attribute the priced sessions and agents in
// --dir (cost.mjs's output) to the window's pull requests, by three methods:
//   A  a session's main and subagent cost, workflow agents left out, split
//      evenly over the window PRs whose head branch its main or subagent
//      entries name; else over the merged window PRs its user text mentions.
//   B  as A, with workflow-agent cost included and their branches and review
//      target refs added to the branch set.
//   D  each subagent's or workflow agent's cost to the PR its own branch,
//      target ref or mentions name; main cost and unmapped agent cost split
//      evenly over the session's B set.
// Writes pr-cost.json (one row per merged PR) and map-summary.json (the true
// mean per merged PR, all and non-dependabot, and each method's median, mean
// and p90) to --dir, and records each agent's PR in its agents.json row.
//
// Usage:
//   node map.mjs --dir DIR --prs FILE --pr-range LO-HI
//
// --prs is a JSON array of pull requests with number, title, state, mergedAt,
// headRefName, author.login, additions, deletions and changedFiles, as
//   gh pr list --state all --limit 1000 --search "created:>=DATE"
//     --json number,title,state,createdAt,mergedAt,closedAt,headRefName,author,additions,deletions,changedFiles
// writes it; --pr-range keeps the window's PRs.

import fs from "node:fs";
import path from "node:path";

import {
  parseFlags,
  parseRange,
  r2,
  readJson,
  runWhenMain,
  UsageError,
} from "./args.mjs";

const USAGE = "Usage: node map.mjs --dir DIR --prs FILE --pr-range LO-HI\n";

/**
 * Parse the map step's arguments. Returns `{ ok: true, options }` or
 * `{ ok: false, message }`.
 */
export function parseArgs(argv) {
  const parsed = parseFlags(argv, {
    values: ["--dir", "--prs", "--pr-range"],
    required: ["--dir", "--prs", "--pr-range"],
  });
  if (!parsed.ok) return parsed;
  if (parsed.positionals.length) {
    return { ok: false, message: `unexpected ${parsed.positionals[0]}` };
  }
  const prRange = parseRange(parsed.values["--pr-range"]);
  if (!prRange) return { ok: false, message: "--pr-range is not LO-HI" };
  return {
    ok: true,
    options: {
      dir: parsed.values["--dir"],
      prs: parsed.values["--prs"],
      prRange,
    },
  };
}

const isSkippedBranch = (b) =>
  b === "staging" ||
  b === "main" ||
  b === "HEAD" ||
  b.startsWith("worktree-agent-");

const quantile = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];

/**
 * Attribute `sessions` and `agents` (cost.mjs's rows; each agent gains a `pr`)
 * to the PRs in `allPrs` numbered within `prRange`. Returns `{ summary, rows }`,
 * map-summary.json and pr-cost.json.
 */
export function mapToPrs(sessions, agents, allPrs, prRange) {
  const prs = allPrs.filter(
    (p) => p.number >= prRange.lo && p.number <= prRange.hi,
  );
  const prBy = new Map(prs.map((p) => [p.number, p]));
  const b2p = new Map(prs.map((p) => [p.headRefName, p.number]));
  const branchPrs = (obj) => {
    const s = new Set();
    for (const b of Object.keys(obj || {})) {
      if (isSkippedBranch(b)) continue;
      const n = b2p.get(b) || b2p.get(b.replace(/^origin\//, ""));
      if (n) s.add(n);
    }
    return s;
  };
  const mergedMentions = (obj) =>
    Object.keys(obj || {})
      .map(Number)
      .filter((n) => prBy.get(n)?.state === "MERGED");

  const M = { A: new Map(), B: new Map(), D: new Map() };
  const unmapped = { A: 0, B: 0, D: 0 };
  const mapped = { A: 0, B: 0, D: 0 };
  const attribute = (method, nums, amount) => {
    if (!nums.length) {
      unmapped[method] += amount;
      return;
    }
    mapped[method] += amount;
    for (const n of nums) {
      M[method].set(n, (M[method].get(n) || 0) + amount / nums.length);
    }
  };
  const agentsBySession = new Map();
  for (const a of agents) {
    const k = a.store + "/" + a.session;
    if (!agentsBySession.has(k)) agentsBySession.set(k, []);
    agentsBySession.get(k).push(a);
  }

  for (const s of sessions) {
    const c = s.cost;
    const aSet = new Set([
      ...branchPrs(s.branches),
      ...branchPrs(s.subBranches),
    ]);
    const aNums = aSet.size ? [...aSet] : mergedMentions(s.prMentions);
    attribute("A", aNums, c.main + c.subagents);
    const bSet = new Set([
      ...aSet,
      ...branchPrs(s.wfBranches),
      ...branchPrs(s.wfRefs),
    ]);
    const bNums = bSet.size ? [...bSet] : mergedMentions(s.prMentions);
    attribute("B", bNums, c.total);
    let rest = c.main;
    for (const a of agentsBySession.get(s.store + "/" + s.id) || []) {
      const own = branchPrs(Object.fromEntries(a.branches.map((b) => [b, 1])));
      if (a.targetRef) {
        for (const n of branchPrs({ [a.targetRef]: 1 })) own.add(n);
      }
      let nums = [...own];
      if (!nums.length) {
        nums = a.prMentions.filter((n) => prBy.get(n)?.state === "MERGED");
      }
      a.pr = nums.length === 1 ? nums[0] : nums.length ? nums : null;
      if (nums.length) attribute("D", nums, a.cost);
      else rest += a.cost;
    }
    attribute("D", bNums, rest);
  }

  const merged = prs.filter((p) => p.state === "MERGED");
  const stats = (method) => {
    const rows = merged
      .filter((p) => M[method].has(p.number))
      .map((p) => M[method].get(p.number))
      .sort((x, y) => x - y);
    const closedCost = prs
      .filter((p) => p.state !== "MERGED")
      .reduce((t, p) => t + (M[method].get(p.number) || 0), 0);
    return {
      mappedUSD: r2(mapped[method]),
      unmappedUSD: r2(unmapped[method]),
      mergedWithCost: rows.length,
      mergedWithoutCost: merged.length - rows.length,
      meanOverMapped: r2(rows.reduce((t, x) => t + x, 0) / rows.length),
      median: r2(quantile(rows, 0.5)),
      p90: r2(quantile(rows, 0.9)),
      max: r2(rows[rows.length - 1]),
      closedUnmergedUSD: r2(closedCost),
    };
  };
  const grand = sessions.reduce((t, s) => t + s.cost.total, 0);
  const nonDep = merged.filter(
    (p) => !p.author.login.includes("dependabot"),
  ).length;
  const summary = {
    sessions: sessions.length,
    mergedPrs: merged.length,
    mergedNonDependabot: nonDep,
    closedUnmerged: prs.length - merged.length,
    grandUSD: r2(grand),
    meanPerMergedPr: r2(grand / merged.length),
    meanPerNonDependabotMergedPr: r2(grand / nonDep),
    A: stats("A"),
    B: stats("B"),
    D: stats("D"),
  };
  const rows = merged.map((p) => ({
    number: p.number,
    title: p.title.slice(0, 70),
    mergedAt: p.mergedAt,
    author: p.author.login,
    size: p.additions + p.deletions,
    files: p.changedFiles,
    costA: r2(M.A.get(p.number) || 0),
    costB: r2(M.B.get(p.number) || 0),
    costD: r2(M.D.get(p.number) || 0),
  }));
  return { summary, rows };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new UsageError(parsed.message);
  const { dir, prs, prRange } = parsed.options;
  const sessions = readJson(path.join(dir, "sessions-enriched.json"));
  const agents = readJson(path.join(dir, "agents.json"));
  const { summary, rows } = mapToPrs(sessions, agents, readJson(prs), prRange);
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify(agents));
  fs.writeFileSync(
    path.join(dir, "pr-cost.json"),
    JSON.stringify(rows, null, 1),
  );
  fs.writeFileSync(
    path.join(dir, "map-summary.json"),
    JSON.stringify(summary, null, 1),
  );
  console.log(JSON.stringify(summary, null, 1));
}

runWhenMain(import.meta.url, USAGE, main);
