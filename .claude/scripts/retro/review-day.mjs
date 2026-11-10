#!/usr/bin/env node
//
// Review-day step of the retro spend kit: reads each review day's
// FINAL/record.json, joins every finding's item to the board's `Delivered by:`
// line and the kit's per-PR costs, and writes the result to --out, which
// trend.mjs reads as --review-day, with a summary to stdout.
//
// Usage:
//   node review-day.mjs --days DIR --out FILE [--cut DATE] [--end DATE]
//     [--board FILE] [--pr-cost FILE] [--followups FILE] [--usage FILE]
//     [--retro-start ISO --retro-end ISO [--retro-usd N]]
//
// --days holds one directory per day, `<date>/FINAL/` as
// .claude/commands/review-day.md writes it; --cut and --end keep the days
// named cut <= date < end. --board is a JSON object of `<board>/<itemId>` to
// item body; without it the bodies are read through fetch-issues.mjs.
// --pr-cost is map.mjs's pr-cost.json, --followups followups.mjs's
// followups.json. --usage is the weekly-allowance log, default
// ~/.claude/usage-readings.jsonl, one JSON line per reading:
// `{t, weeklyUsedPercent, resetsAt, session}`. --retro-start and --retro-end
// bound the retro's own session, priced at --retro-usd.
//
// Rules:
//   - A finding's item is its `outcome` when that is `<board>/<itemId>`, else
//     the item the day's FINAL/filed.md (`<draft> -> <board>/<itemId>`) maps
//     the outcome to; any other outcome has no item.
//   - A finding the verifier refuted counts nowhere.
//   - A value unit is a finding whose item has a `Delivered by:` line. Lenses 1
//     and 2 count a behaviour-changing finding only: its item names the test
//     failing on the old code (.claude/review-day/consolidate-brief.md, step 1).
//     Lenses 3 and 4 count any finding: a claim corrected, a proposal or trim
//     merged.
//   - A lens's cost on a day is its slices' cost, scaled up to the record's
//     `spend.day` when that is larger. Each fix PR's `costD` is shared evenly
//     over the units its PR delivered in the window. Dollars per landed unit
//     are the lens's day cost plus its units' fix share, over its units.
//   - Escapes are findings in code a per-branch round reviewed (`window`
//     reviewed); the fix pipeline's lag is findings with `raisedBefore`.
//   - A day's window is the first and last modification time of its files.
//     Its spend as a share of the weekly allowance is the sum of the changes
//     between the last reading at or before the window's start and each
//     reading inside it. A reading at or after the previous reading's reset
//     time follows a reset, and adds its whole share. The share is
//     account-wide: other use in those hours counts too.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFlags,
  parseInstant,
  r2,
  readJson,
  runWhenMain,
  UsageError,
} from "./args.mjs";

const USAGE =
  "Usage: node review-day.mjs --days DIR --out FILE [--cut DATE] [--end DATE]\n" +
  "         [--board FILE] [--pr-cost FILE] [--followups FILE] [--usage FILE]\n" +
  "         [--retro-start ISO --retro-end ISO [--retro-usd N]]\n";

const LENSES = ["1", "2", "3", "4"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BOARD_ITEM = /^\d+\/\d+$/;
const FETCH_ISSUES = fileURLToPath(
  new URL("../fetch-issues.mjs", import.meta.url),
);

/** The share's scope, printed beside every share. */
export const ACCOUNT_WIDE =
  "the weekly share is account-wide: other use in those hours counts too";

/**
 * Parse the review-day step's arguments. Returns `{ ok: true, options }` or
 * `{ ok: false, message }`.
 */
export function parseArgs(argv) {
  const parsed = parseFlags(argv, {
    values: [
      "--days",
      "--out",
      "--cut",
      "--end",
      "--board",
      "--pr-cost",
      "--followups",
      "--usage",
      "--retro-start",
      "--retro-end",
      "--retro-usd",
    ],
    required: ["--days", "--out"],
  });
  if (!parsed.ok) return parsed;
  if (parsed.positionals.length) {
    return { ok: false, message: `unexpected ${parsed.positionals[0]}` };
  }
  const v = parsed.values;
  for (const flag of ["--cut", "--end"]) {
    if (v[flag] !== undefined && !DATE.test(v[flag])) {
      return { ok: false, message: `${flag} is not YYYY-MM-DD` };
    }
  }
  let retro = null;
  if (v["--retro-start"] !== undefined || v["--retro-end"] !== undefined) {
    const from = parseInstant(v["--retro-start"] ?? "");
    const to = parseInstant(v["--retro-end"] ?? "");
    if (from === null || to === null) {
      return {
        ok: false,
        message: "--retro-start and --retro-end are both ISO instants",
      };
    }
    const usd =
      v["--retro-usd"] === undefined ? null : Number(v["--retro-usd"]);
    if (usd !== null && !Number.isFinite(usd)) {
      return { ok: false, message: "--retro-usd is not a number" };
    }
    retro = { from, to, usd };
  } else if (v["--retro-usd"] !== undefined) {
    return { ok: false, message: "--retro-usd needs --retro-start" };
  }
  return {
    ok: true,
    options: {
      days: v["--days"],
      out: v["--out"],
      cut: v["--cut"] ?? null,
      end: v["--end"] ?? null,
      board: v["--board"] ?? null,
      prCost: v["--pr-cost"] ?? null,
      followups: v["--followups"] ?? null,
      usage:
        v["--usage"] ??
        path.join(os.homedir(), ".claude", "usage-readings.jsonl"),
      retro,
    },
  };
}

/**
 * The readings of a weekly-allowance log, sorted by time, each `{ t }` in
 * epoch ms; null when the file does not exist. A malformed line is skipped.
 */
export function readUsageLog(file) {
  if (!fs.existsSync(file)) return null;
  const readings = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(r.t);
    if (
      Number.isNaN(t) ||
      !Number.isFinite(r.weeklyUsedPercent) ||
      !Number.isFinite(r.resetsAt)
    )
      continue;
    readings.push({
      t,
      weeklyUsedPercent: r.weeklyUsedPercent,
      resetsAt: r.resetsAt,
    });
  }
  return readings.sort((a, b) => a.t - b.t);
}

/**
 * The weekly-allowance share, in percentage points, used between `from` and
 * `to` (epoch ms), by the rule in the header; null with no reading inside.
 */
export function weeklyShare(readings, from, to) {
  const inside = readings.filter((r) => r.t > from && r.t <= to);
  if (!inside.length) return null;
  const before = readings.filter((r) => r.t <= from).at(-1);
  const seq = before ? [before, ...inside] : inside;
  let share = 0;
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1];
    const cur = seq[i];
    share +=
      cur.t >= prev.resetsAt * 1000
        ? cur.weeklyUsedPercent
        : cur.weeklyUsedPercent - prev.weeklyUsedPercent;
  }
  return share;
}

/**
 * The spend of a window: `{ usd, weeklySharePct, shareNote }`, the share null
 * and `shareNote` saying why when the log is missing or has no reading inside.
 */
export function spendInWindow(usd, readings, usagePath, from, to) {
  if (readings === null) {
    return {
      usd,
      weeklySharePct: null,
      shareNote: `no usage log at ${usagePath}; dollars alone`,
    };
  }
  const share = weeklyShare(readings, from, to);
  return share === null
    ? {
        usd,
        weeklySharePct: null,
        shareNote: "no weekly-allowance reading in the window; dollars alone",
      }
    : { usd, weeklySharePct: share, shareNote: ACCOUNT_WIDE };
}

/**
 * Whether an item body has a `Delivered by:` line, with the PR numbers it
 * names: `{ delivered, prs }`.
 */
export function deliveredBy(body) {
  const m = typeof body === "string" && /^Delivered by: (\S.*)$/m.exec(body);
  if (!m) return { delivered: false, prs: [] };
  return {
    delivered: true,
    prs: [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1])),
  };
}

/** A FINAL/filed.md's draft-to-item map. */
export function parseFiled(text) {
  const filed = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\S.*?)\s+->\s+(\d+\/\d+)\s*$/.exec(line);
    if (m) filed.set(m[1], m[2]);
  }
  return filed;
}

function walkMtimes(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMtimes(p, out);
    else if (entry.isFile()) out.push(fs.statSync(p).mtimeMs);
  }
  return out;
}

/**
 * The days under `daysDir` named within [cut, end), each `{ day, record,
 * filed, from, to }`, with `skipped`, the days in range with no record.
 */
export function readDays(daysDir, cut, end) {
  const days = [];
  const skipped = [];
  if (!fs.existsSync(daysDir)) return { days, skipped };
  for (const day of fs.readdirSync(daysDir).sort()) {
    const dir = path.join(daysDir, day);
    if (!fs.statSync(dir).isDirectory()) continue;
    if ((cut && day < cut) || (end && day >= end)) continue;
    const recordFile = path.join(dir, "FINAL", "record.json");
    if (!fs.existsSync(recordFile)) {
      skipped.push(day);
      continue;
    }
    const filedFile = path.join(dir, "FINAL", "filed.md");
    const mtimes = walkMtimes(dir);
    days.push({
      day,
      record: readJson(recordFile),
      filed: fs.existsSync(filedFile)
        ? parseFiled(fs.readFileSync(filedFile, "utf8"))
        : new Map(),
      from: Math.min(...mtimes),
      to: Math.max(...mtimes),
    });
  }
  return { days, skipped };
}

/** The finding's board item, `<board>/<itemId>`, or null. */
export function itemOf(finding, filed) {
  const outcome = finding.outcome;
  if (typeof outcome !== "string") return null;
  if (BOARD_ITEM.test(outcome)) return outcome;
  return filed.get(outcome) ?? null;
}

/** Every board item the days name, through a finding or FINAL/filed.md. */
export function itemsNamed(days) {
  const refs = new Set();
  for (const d of days) {
    for (const ref of d.filed.values()) refs.add(ref);
    for (const f of d.record.findings ?? []) {
      const ref = itemOf(f, d.filed);
      if (ref) refs.add(ref);
    }
  }
  return [...refs].sort();
}

/** Whether a finding is a value unit once its item is delivered. */
export function isUnitFinding(f) {
  const lens = String(f.lens);
  if (lens === "1" || lens === "2") return f.behaviourChanging === true;
  return lens === "3" || lens === "4";
}

const byLens = (f) => Object.fromEntries(LENSES.map((l) => [l, f(l)]));
const isRefuted = (f) => String(f.verdict).toUpperCase() === "REFUTED";
const ratio = (num, den) => (den > 0 ? r2(num / den) : null);

/**
 * The review-day reader's output over `days` (as readDays returns them).
 * `bodies` maps `<board>/<itemId>` to its body (undefined when not found);
 * `prCost` is pr-cost.json's rows or null; `followups` followups.json or null;
 * `readings` readUsageLog's result; `retro` `{ from, to, usd }` or null.
 */
export function reviewDayReport({
  days,
  skipped = [],
  bodies,
  prCost,
  followups,
  readings,
  usagePath,
  retro,
}) {
  const notes = [];
  const costOf = new Map((prCost ?? []).map((p) => [p.number, p.costD]));
  if (!prCost) notes.push("no --pr-cost given; fix PR costs left out");
  if (skipped.length) {
    notes.push(`days with no FINAL/record.json: ${skipped.join(", ")}`);
  }
  const notFound = itemsNamed(days).filter((ref) => bodies.get(ref) == null);
  if (notFound.length) {
    notes.push(`items not found on the board: ${notFound.join(", ")}`);
  }
  const delivery = (ref) => deliveredBy(bodies.get(ref));

  const units = [];
  const perDay = days.map((d) => {
    const findings = (d.record.findings ?? []).filter((f) => !isRefuted(f));
    const slices = d.record.slices ?? [];
    const sliceCost = byLens((l) =>
      slices
        .filter((s) => String(s.lens) === l)
        .reduce((t, s) => t + (Number(s.cost) || 0), 0),
    );
    const sliceTotal = LENSES.reduce((t, l) => t + sliceCost[l], 0);
    const dayUsd = Number(d.record.spend?.day);
    const scale =
      Number.isFinite(dayUsd) && sliceTotal > 0 && dayUsd > sliceTotal
        ? dayUsd / sliceTotal
        : 1;
    const lensCost = byLens((l) => sliceCost[l] * scale);
    const dayUnits = [];
    for (const f of findings) {
      const ref = itemOf(f, d.filed);
      if (!ref || !isUnitFinding(f)) continue;
      const { delivered, prs } = delivery(ref);
      if (!delivered) continue;
      const unit = { day: d.day, lens: String(f.lens), prs, fixUsd: 0 };
      dayUnits.push(unit);
      units.push(unit);
    }
    const filedRefs = [...new Set(d.filed.values())];
    const deliveredRefs = filedRefs.filter((ref) => delivery(ref).delivered);
    return {
      d,
      findings,
      lensCost,
      dayUnits,
      filedRefs,
      deliveredRefs,
      usd: Number.isFinite(dayUsd) ? dayUsd : sliceTotal,
      usdFrom: Number.isFinite(dayUsd) ? "spend.day" : "slice costs",
    };
  });

  const unitsByPr = new Map();
  for (const u of units) {
    for (const pr of u.prs) {
      if (!unitsByPr.has(pr)) unitsByPr.set(pr, []);
      unitsByPr.get(pr).push(u);
    }
  }
  const uncosted = [];
  for (const [pr, prUnits] of unitsByPr) {
    if (!costOf.has(pr)) {
      if (prCost) uncosted.push(pr);
      continue;
    }
    for (const u of prUnits) u.fixUsd += costOf.get(pr) / prUnits.length;
  }
  if (uncosted.length) {
    notes.push(
      `fix PRs not in pr-cost.json, their cost left out: ${uncosted
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(", ")}`,
    );
  }

  const followedPrs = followups
    ? new Set(
        followups.prs.flatMap((p) =>
          p.bump ? [] : p.follows.map((l) => l.pr),
        ),
      )
    : null;
  const seriesPrs = followups ? new Set(followups.prs.map((p) => p.pr)) : null;
  if (!followups) {
    notes.push(
      "no --followups given; fix PRs a follow-up amended are left out",
    );
  }

  const measures = (rows) => {
    const findings = rows.flatMap((r) => r.findings);
    const dayUnits = rows.flatMap((r) => r.dayUnits);
    const unitCount = byLens(
      (l) => dayUnits.filter((u) => u.lens === l).length,
    );
    const fixPrs = [
      ...new Set(
        rows.flatMap((r) =>
          r.deliveredRefs.flatMap((ref) => delivery(ref).prs),
        ),
      ),
    ];
    const inSeries = followups ? fixPrs.filter((n) => seriesPrs.has(n)) : [];
    return {
      findings: findings.length,
      escapes: findings.filter((f) => f.window === "reviewed").length,
      security: findings.filter((f) => f.security === true).length,
      escapesSecurity: findings.filter(
        (f) => f.window === "reviewed" && f.security === true,
      ).length,
      raisedBefore: findings.filter((f) => f.raisedBefore === true).length,
      ownerCalls: rows.reduce(
        (t, r) => t + (Number(r.d.record.totals?.ownerCalls) || 0),
        0,
      ),
      itemsFiled: rows.reduce((t, r) => t + r.filedRefs.length, 0),
      itemsDelivered: rows.reduce((t, r) => t + r.deliveredRefs.length, 0),
      fixPrsInFollowupSeries: followups ? inSeries.length : null,
      fixPrsAmended: followups
        ? inSeries.filter((n) => followedPrs.has(n)).length
        : null,
      landedUnitsByLens: unitCount,
      usdPerLandedUnitByLens: byLens((l) =>
        ratio(
          rows.reduce((t, r) => t + r.lensCost[l], 0) +
            dayUnits
              .filter((u) => u.lens === l)
              .reduce((t, u) => t + u.fixUsd, 0),
          unitCount[l],
        ),
      ),
    };
  };

  return {
    records: days.length,
    ...measures(perDay),
    days: perDay.map((r) => ({
      day: r.d.day,
      ...measures([r]),
      spend: {
        ...spendInWindow(r2(r.usd), readings, usagePath, r.d.from, r.d.to),
        usdFrom: r.usdFrom,
        from: new Date(r.d.from).toISOString(),
        to: new Date(r.d.to).toISOString(),
      },
    })),
    retro: retro
      ? {
          ...spendInWindow(
            retro.usd,
            readings,
            usagePath,
            retro.from,
            retro.to,
          ),
          from: new Date(retro.from).toISOString(),
          to: new Date(retro.to).toISOString(),
        }
      : null,
    notes,
  };
}

/** Item bodies by `<board>/<itemId>`, read through fetch-issues.mjs. */
export function readBoard(refs) {
  const byBoard = new Map();
  for (const ref of refs) {
    const [board, id] = ref.split("/");
    if (!byBoard.has(board)) byBoard.set(board, []);
    byBoard.get(board).push(id);
  }
  const bodies = new Map();
  for (const [board, ids] of byBoard) {
    const out = execFileSync(
      process.execPath,
      [FETCH_ISSUES, "--json", board, ...ids],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const item of JSON.parse(out)) {
      if (item.type !== "missing" && typeof item.body === "string") {
        bodies.set(`${board}/${item.id}`, item.body);
      }
    }
  }
  return bodies;
}

const fmtSpend = (s) =>
  s.weeklySharePct === null
    ? `${s.usd === null ? "dollars not given" : `$${s.usd}`} (${s.shareNote})`
    : `${s.usd === null ? "dollars not given" : `$${s.usd}`}, ${s.weeklySharePct}% of the weekly allowance (${s.shareNote})`;

const fmtLenses = (m) =>
  LENSES.map(
    (l) =>
      `lens ${l} ${m.landedUnitsByLens[l]} landed` +
      (m.usdPerLandedUnitByLens[l] === null
        ? ""
        : ` at $${m.usdPerLandedUnitByLens[l]}`),
  ).join("; ");

const fmtFollowups = (m) =>
  m.fixPrsAmended === null
    ? "follow-ups not read"
    : `${m.fixPrsAmended} of ${m.fixPrsInFollowupSeries} fix PRs amended by a follow-up`;

/** The reader's output as text. */
export function formatReport(out) {
  const line = (label, m) =>
    `${label}: ${m.escapes} of ${m.findings} findings escaped a per-branch round ` +
    `(${m.escapesSecurity} of ${m.security} security); ${m.raisedBefore} raised before and still true; ` +
    `${m.ownerCalls} owner calls; ${m.itemsDelivered} of ${m.itemsFiled} filed items delivered; ` +
    `${fmtFollowups(m)}; ${fmtLenses(m)}`;
  const lines = [];
  for (const d of out.days) {
    lines.push(line(d.day, d), `  spend ${fmtSpend(d.spend)}`);
  }
  lines.push(line(`window, ${out.records} days`, out));
  if (out.retro) lines.push(`retro spend ${fmtSpend(out.retro)}`);
  for (const n of out.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new UsageError(parsed.message);
  const { options } = parsed;
  const { days, skipped } = readDays(options.days, options.cut, options.end);
  const bodies = options.board
    ? new Map(Object.entries(readJson(options.board)))
    : readBoard(itemsNamed(days));
  const out = reviewDayReport({
    days,
    skipped,
    bodies,
    prCost: options.prCost ? readJson(options.prCost) : null,
    followups: options.followups ? readJson(options.followups) : null,
    readings: readUsageLog(options.usage),
    usagePath: options.usage,
    retro: options.retro,
  });
  fs.writeFileSync(options.out, JSON.stringify(out, null, 1));
  console.log(formatReport(out));
}

runWhenMain(import.meta.url, USAGE, main);
