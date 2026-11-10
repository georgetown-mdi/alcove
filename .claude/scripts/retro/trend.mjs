#!/usr/bin/env node
//
// Trend step of the retro spend kit: compares the current window's kit output
// with the baseline window's, one row per measure, per day beside per merged
// PR. Writes trend.json to --out and the table to stdout.
//
// Usage:
//   node trend.mjs --baseline DIR --current DIR [--review-day FILE]
//     [--out FILE] [--draws N] [--seed N]
//
// Each DIR is one window's kit output: rollups.json, sessions-enriched.json
// and agents.json from cost.mjs, pr-cost.json from map.mjs, and followups.json
// when followups.mjs has run over it. --out defaults to trend.json in the
// current DIR. --review-day is the review-day reader's output,
// `{ usdPerLandedUnitByLens: { <lens>: number }, escapes: number }`.
//
// Rules:
//   - A day is a UTC day with spend, a merge or an owner turn. A merged PR
//     counts on its merge day, an agent's cost on its first call's day.
//   - Each ratio is current over baseline. Its interval is the 2.5% and 97.5%
//     quantiles over --draws (default 2000) draws, each resampling both
//     windows' days with replacement (seeded by --seed); a draw with no finite
//     ratio is dropped. A row is moved only when 1.0 lies outside its interval.
//   - Size bands are the fixed cuts 65 / 451 / 1,203 changed lines.
//   - Cost per merged PR is method D (`costD`), each window's band means
//     weighted by the baseline's band shares.
//   - A row whose input a window lacks, and every row no kit output measures,
//     prints as not measured with its reason, never as zero.

import fs from "node:fs";
import path from "node:path";

import { isApparatusOrFix, PEAK_CTX_REPORTED } from "./analyze.mjs";
import { parseFlags, readJson, runWhenMain, UsageError } from "./args.mjs";

const USAGE =
  "Usage: node trend.mjs --baseline DIR --current DIR [--review-day FILE]\n" +
  "         [--out FILE] [--draws N] [--seed N]\n";

/** The fixed size cuts, in changed lines (additions plus deletions). */
export const SIZE_CUTS = [65, 451, 1203];

const NOT_IN_KIT = [
  [
    "majors per lens round",
    "read from the review ledgers, which no kit step reads",
  ],
  [
    "verifier's refuted share",
    "read from the review ledgers, which no kit step reads",
  ],
  [
    "docket count, owner turns and share",
    "needs the owner-turn labels scout B writes",
  ],
  [
    "audit day's problems found and fixed",
    "no kit input records the audit day",
  ],
];

/**
 * Parse the trend step's arguments. Returns `{ ok: true, options }` or
 * `{ ok: false, message }`.
 */
export function parseArgs(argv) {
  const parsed = parseFlags(argv, {
    values: [
      "--baseline",
      "--current",
      "--review-day",
      "--out",
      "--draws",
      "--seed",
    ],
    required: ["--baseline", "--current"],
  });
  if (!parsed.ok) return parsed;
  if (parsed.positionals.length) {
    return { ok: false, message: `unexpected ${parsed.positionals[0]}` };
  }
  const v = parsed.values;
  const draws = Number(v["--draws"] ?? 2000);
  const seed = Number(v["--seed"] ?? 1);
  if (!Number.isInteger(draws) || draws < 1) {
    return { ok: false, message: "--draws is not a positive integer" };
  }
  if (!Number.isInteger(seed)) {
    return { ok: false, message: "--seed is not an integer" };
  }
  return {
    ok: true,
    options: {
      baseline: v["--baseline"],
      current: v["--current"],
      reviewDay: v["--review-day"] ?? null,
      out: v["--out"] ?? path.join(v["--current"], "trend.json"),
      draws,
      seed,
    },
  };
}

/** A seeded uniform generator on [0, 1). */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sizeBand = (size) => {
  const i = SIZE_CUTS.findIndex((cut) => size <= cut);
  return i < 0 ? SIZE_CUTS.length : i;
};

const bandRange = (i) =>
  i === 0
    ? `<=${SIZE_CUTS[0]} lines`
    : i === SIZE_CUTS.length
      ? `>${SIZE_CUTS.at(-1)} lines`
      : `${SIZE_CUTS[i - 1] + 1}-${SIZE_CUTS[i]} lines`;

function newDay() {
  return {
    spend: 0,
    merged: 0,
    mainUSD: 0,
    ownerTurns: 0,
    apparatusUSD: 0,
    compactManual: 0,
    compactAuto: 0,
    compactTurns: 0,
    implOver500k: 0,
    followups: 0,
    planned: 0,
    unplanned: 0,
    seriesPRs: 0,
    bands: SIZE_CUTS.concat(0).map(() => ({ n: 0, usd: 0 })),
  };
}

/**
 * One window's kit output as per-day records, with the inputs it lacks.
 * `kit` has `rollups`, `sessions`, `agents`, `prCost` and `followups` (or null).
 * Returns `{ days, missing, over500k }`: `missing` maps an input name to why
 * it is absent.
 */
export function windowDays(kit) {
  const byDay = new Map();
  const day = (d) => byDay.get(d) || byDay.set(d, newDay()).get(d);
  const missing = {};
  for (const [d, usd] of Object.entries(kit.rollups.byDay)) day(d).spend += usd;
  if (kit.rollups.mainByDay) {
    for (const [d, usd] of Object.entries(kit.rollups.mainByDay)) {
      day(d).mainUSD += usd;
    }
  } else missing.mainByDay = "rollups.json has no mainByDay";
  for (const p of kit.prCost) {
    const r = day(p.mergedAt.slice(0, 10));
    r.merged++;
    const b = r.bands[sizeBand(p.size)];
    b.n++;
    b.usd += p.costD;
  }
  if (kit.sessions.every((s) => s.compactByDay)) {
    for (const s of kit.sessions) {
      for (const [d, k] of Object.entries(s.ownerByDay || {})) {
        day(d).ownerTurns +=
          (k.typed || 0) + (k.command || 0) + (k.interrupt || 0);
      }
      for (const [d, c] of Object.entries(s.compactByDay)) {
        const r = day(d);
        r.compactManual += c.manual;
        r.compactAuto += c.auto;
        r.compactTurns += c.ownerTurns;
      }
    }
  } else {
    missing.sessionFields =
      "sessions-enriched.json predates the command-twin and compaction counts";
  }
  for (const a of kit.agents) {
    if (isApparatusOrFix(a)) day(a.firstTs.slice(0, 10)).apparatusUSD += a.cost;
  }
  const over500k = [];
  if (kit.agents.every((a) => "peakCtx" in a)) {
    for (const a of kit.agents) {
      if (a.agentType !== "implementer" || !(a.peakCtx > PEAK_CTX_REPORTED))
        continue;
      day(a.firstTs.slice(0, 10)).implOver500k++;
      over500k.push({
        session: a.session.slice(0, 8),
        id: a.id,
        desc: a.desc,
        peakCtx: a.peakCtx,
        usd: a.cost,
      });
    }
  } else missing.peakCtx = "agents.json has no peak context";
  if (kit.followups) {
    for (const p of kit.followups.prs) {
      if (p.bump) continue;
      const r = day(p.day);
      r.seriesPRs++;
      if (!p.follows.length) continue;
      r.followups++;
      if (p.follows.some((l) => l.planned)) r.planned++;
      else r.unplanned++;
    }
  } else missing.followups = "followups.json is missing; run followups.mjs";
  return { days: [...byDay.values()], missing, over500k };
}

const total = (days, f) => days.reduce((t, d) => t + f(d), 0);

/** A per-day rate: the sum of `num` over the days, over the day count. */
export const perDay = (num) => (days) => total(days, num) / days.length;

/** A ratio of sums over the days, times `scale`. */
export const ratioOfSums =
  (num, den, scale = 1) =>
  (days) =>
    (scale * total(days, num)) / total(days, den);

/**
 * Method D cost per merged PR in each window, standardized to the baseline's
 * size mix: each window's band means weighted by the baseline's band shares.
 * A band either window has no PR in is left out of both, the weights
 * renormalized over the bands both hold. Returns `[baseline, current, note]`,
 * where `note` names the left-out bands that held PRs in the other window.
 */
export function standardizedCost(baseDays, curDays) {
  const bands = (days) =>
    SIZE_CUTS.concat(0).map((_, i) => ({
      n: total(days, (d) => d.bands[i].n),
      usd: total(days, (d) => d.bands[i].usd),
    }));
  const base = bands(baseDays);
  const cur = bands(curDays);
  const shared = base.map((b, i) => b.n > 0 && cur[i].n > 0);
  const n = base.reduce((t, b, i) => t + (shared[i] ? b.n : 0), 0);
  let vb = 0;
  let vc = 0;
  base.forEach((b, i) => {
    if (!shared[i]) return;
    vb += (b.n / n) * (b.usd / b.n);
    vc += (b.n / n) * (cur[i].usd / cur[i].n);
  });
  const left = [...base.keys()].filter(
    (i) => !shared[i] && base[i].n + cur[i].n > 0,
  );
  const note = left.length
    ? `left out, absent from one window: ${left.map(bandRange).join("; ")}`
    : undefined;
  return n > 0 ? [vb, vc, note] : [NaN, NaN, note];
}

const quantile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/**
 * Compare two windows' days under `pair`, which maps `(baseDays, curDays)` to
 * `[baseline, current]` or `[baseline, current, note]`. Returns the point
 * values, their ratio, its bootstrap interval over days, whether the row moved
 * and the pair's note on the full windows, if any.
 */
export function bootstrapRatio(
  baseDays,
  curDays,
  pair,
  { draws = 2000, random },
) {
  const [baseline, current, note] = pair(baseDays, curDays);
  const resample = (days) =>
    days.map(() => days[Math.floor(random() * days.length)]);
  const ratios = [];
  for (let i = 0; i < draws; i++) {
    const [b, c] = pair(resample(baseDays), resample(curDays));
    const r = c / b;
    if (Number.isFinite(r)) ratios.push(r);
  }
  ratios.sort((x, y) => x - y);
  const lo = ratios.length ? quantile(ratios, 0.025) : null;
  const hi = ratios.length ? quantile(ratios, 0.975) : null;
  return {
    baseline,
    current,
    ratio: current / baseline,
    lo,
    hi,
    moved: lo !== null && (lo > 1 || hi < 1),
    ...(note ? { note } : {}),
  };
}

const both = (stat) => (b, c) => [stat(b), stat(c)];

function rowSpecs() {
  const band = (i) =>
    ratioOfSums(
      (d) => d.bands[i].usd,
      (d) => d.bands[i].n,
    );
  const bandName = (i) => `method D cost per merged PR, ${bandRange(i)}`;
  const merged = (d) => d.merged;
  return [
    ["spend per day", [], both(perDay((d) => d.spend))],
    ["spend per merged PR", [], both(ratioOfSums((d) => d.spend, merged))],
    ["merged PRs per day", [], both(perDay(merged))],
    ["cost per merged PR, baseline size mix", [], standardizedCost],
    ...SIZE_CUTS.concat(0).map((_, i) => [bandName(i), [], both(band(i))]),
    [
      "owner turns per day",
      ["sessionFields"],
      both(perDay((d) => d.ownerTurns)),
    ],
    [
      "owner turns per merged PR",
      ["sessionFields"],
      both(ratioOfSums((d) => d.ownerTurns, merged)),
    ],
    [
      "main-session cost per day",
      ["mainByDay"],
      both(perDay((d) => d.mainUSD)),
    ],
    [
      "main-session cost per merged PR",
      ["mainByDay"],
      both(ratioOfSums((d) => d.mainUSD, merged)),
    ],
    [
      "review apparatus plus fix implementers per day",
      [],
      both(perDay((d) => d.apparatusUSD)),
    ],
    [
      "review apparatus plus fix implementers per merged PR",
      [],
      both(ratioOfSums((d) => d.apparatusUSD, merged)),
    ],
    [
      "manual compactions per day",
      ["sessionFields"],
      both(perDay((d) => d.compactManual)),
    ],
    [
      "auto compactions per day",
      ["sessionFields"],
      both(perDay((d) => d.compactAuto)),
    ],
    [
      "owner turns on compaction per day",
      ["sessionFields"],
      both(perDay((d) => d.compactTurns)),
    ],
    [
      "implementer runs with peak context over 500k per day",
      ["peakCtx"],
      both(perDay((d) => d.implOver500k)),
    ],
    ["follow-ups per day", ["followups"], both(perDay((d) => d.followups))],
    [
      "follow-ups per 100 merged PRs",
      ["followups"],
      both(
        ratioOfSums(
          (d) => d.followups,
          (d) => d.seriesPRs,
          100,
        ),
      ),
    ],
    [
      "planned follow-ups per 100 merged PRs",
      ["followups"],
      both(
        ratioOfSums(
          (d) => d.planned,
          (d) => d.seriesPRs,
          100,
        ),
      ),
    ],
    [
      "unplanned follow-ups per 100 merged PRs",
      ["followups"],
      both(
        ratioOfSums(
          (d) => d.unplanned,
          (d) => d.seriesPRs,
          100,
        ),
      ),
    ],
  ];
}

/**
 * The trend table. `baseline` and `current` are windows as windowDays returns
 * them; `reviewDay` is the review-day reader's output or null. Returns
 * `{ rows, over500k }`.
 */
export function trend(baseline, current, reviewDay, { draws, seed }) {
  const random = seededRandom(seed);
  const rows = [];
  for (const [row, needs, pair] of rowSpecs()) {
    const gap = needs
      .flatMap((k) => [
        baseline.missing[k] && `baseline: ${baseline.missing[k]}`,
        current.missing[k] && `current: ${current.missing[k]}`,
      ])
      .filter(Boolean);
    if (gap.length) {
      rows.push({ row, notMeasured: gap.join("; ") });
      continue;
    }
    rows.push({
      row,
      ...bootstrapRatio(baseline.days, current.days, pair, { draws, random }),
    });
  }
  if (reviewDay) {
    for (const [lens, usd] of Object.entries(
      reviewDay.usdPerLandedUnitByLens,
    )) {
      rows.push({
        row: `review day dollars per landed unit, ${lens}`,
        value: usd,
      });
    }
    rows.push({ row: "review day escape count", value: reviewDay.escapes });
  } else {
    for (const row of [
      "review day dollars per landed unit by lens",
      "review day escape count",
    ]) {
      rows.push({
        row,
        notMeasured: "no review-day reader output given (--review-day)",
      });
    }
  }
  for (const [row, why] of NOT_IN_KIT) rows.push({ row, notMeasured: why });
  return { rows, over500k: current.over500k };
}

const fmt = (x) =>
  x === null || x === undefined
    ? "-"
    : Number(x.toFixed(x < 10 ? 3 : 1)).toString();

/** The trend table as text, one row per line. */
export function formatTable(rows) {
  return rows
    .map((r) => {
      if (r.notMeasured) return `${r.row}: not measured (${r.notMeasured})`;
      if ("value" in r) return `${r.row}: ${fmt(r.value)}`;
      const moved = r.moved ? "  MOVED" : "";
      const note = r.note ? ` (${r.note})` : "";
      return `${r.row}: ${fmt(r.baseline)} -> ${fmt(r.current)}, ratio ${fmt(r.ratio)} [${fmt(r.lo)}, ${fmt(r.hi)}]${moved}${note}`;
    })
    .join("\n");
}

function readKit(dir) {
  const read = (f) => readJson(path.join(dir, f));
  const followupsFile = path.join(dir, "followups.json");
  return {
    rollups: read("rollups.json"),
    sessions: read("sessions-enriched.json"),
    agents: read("agents.json"),
    prCost: read("pr-cost.json"),
    followups: fs.existsSync(followupsFile) ? readJson(followupsFile) : null,
  };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new UsageError(parsed.message);
  const { options } = parsed;
  const out = trend(
    windowDays(readKit(options.baseline)),
    windowDays(readKit(options.current)),
    options.reviewDay ? readJson(options.reviewDay) : null,
    options,
  );
  fs.writeFileSync(options.out, JSON.stringify(out, null, 1));
  console.log(formatTable(out.rows));
  for (const a of out.over500k) {
    console.log(
      `  implementer over 500k: ${a.session} ${a.id} ${a.desc} peak ${a.peakCtx}, $${a.usd}`,
    );
  }
}

runWhenMain(import.meta.url, USAGE, main);
