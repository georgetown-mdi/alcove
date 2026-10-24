#!/usr/bin/env node
//
// Step 1 of the retro spend kit: aggregate one Claude Code transcript store
// into per-session JSON -- token usage by model in the window (main, sidechain,
// cross-file duplicates, per UTC day), owner turns, hook denials, tool use,
// branches and PR mentions, for every session and each of its subagents and
// workflow agents. cost.mjs prices the output. The pipeline: README.md in the
// directory above.
//
// Usage:
//   node aggregate.mjs --store NAME --cut ISO --end ISO --pr-range LO-HI
//     --out FILE [--exclude SESSION]... [--only SESSION]...
//     (--root DIR | PROJECT_DIR)...
//
// A store is a Claude Code `projects` directory: --root takes every project
// directory under DIR, a bare PROJECT_DIR one project directory. In each, a
// session is `<id>.jsonl`, its subagents `<id>/subagents/agent-*.jsonl`, its
// workflow agents `<id>/subagents/workflows/wf_*/agent-*.jsonl`, and a workflow
// run's record `<id>/workflows/<wf>.json`. --pr-range bounds the PR numbers
// recorded from mentions.
//
// Parsing rules, each with a fixture in aggregate.test.mjs:
//   - A line ends at "\n" only. JSON escapes \n and \r inside a string but not
//     U+2028 or U+2029, and node:readline in Node 26 splits a line at either.
//   - An entry is in the window when cut <= timestamp < end. A session whose
//     files were all last modified before the cut is skipped, and so is an
//     agent file last modified before it.
//   - A streamed message is logged as several entries sharing one message.id
//     (an entry with none is keyed by its uuid). It is counted once, in the
//     buckets of its first entry's timestamp, with the last entry's usage and
//     output_tokens the maximum over its entries. Some Claude Code versions log
//     a subagent's first entry with a partial output count; `outFirst` keeps
//     that count, which cost.mjs --first-entry-output prices.
//   - An assistant entry with no usage, or with model `<synthetic>`, is not a
//     call.
//   - Cache writes split into 5m and 1h by `usage.cache_creation`; without it,
//     `cache_creation_input_tokens` is counted as 5m.
//   - A main-session entry with `isSidechain` goes to the sidechain bucket.
//   - A message.id and requestId already seen in an earlier file of this run
//     is also added to the duplicates bucket.
//   - An owner turn is a main-session user entry that is not a tool result,
//     sidechain or meta entry, classified by `ownerKind`; `userTurns` counts
//     the typed, command and interrupt kinds.
//   - A tool result's text is classified as a denial by `classifyDenial`.
//   - A PR mention is `PR N`, `pull/N` or `#N`, four digits, in user text that
//     is not a tool result.
//   - Tool calls, spawns, skills and workflow calls are tallied from the
//     `tool_use` blocks of window assistant entries.

import fs from "node:fs";
import path from "node:path";

import {
  parseFlags,
  parseInstant,
  parseRange,
  runWhenMain,
  UsageError,
} from "./args.mjs";

const USAGE =
  "Usage: node aggregate.mjs --store NAME --cut ISO --end ISO --pr-range LO-HI --out FILE\n" +
  "         [--exclude SESSION]... [--only SESSION]... (--root DIR | PROJECT_DIR)...\n";

const USAGE_FIELDS = ["in", "out", "cacheRead", "cache5m", "cache1h"];

/**
 * Parse the aggregate step's arguments. Returns `{ ok: true, options }` or
 * `{ ok: false, message }`.
 */
export function parseArgs(argv) {
  const parsed = parseFlags(argv, {
    values: ["--store", "--cut", "--end", "--pr-range", "--out"],
    lists: ["--exclude", "--only", "--root"],
    required: ["--store", "--cut", "--end", "--pr-range", "--out"],
  });
  if (!parsed.ok) return parsed;
  const { values, lists, positionals } = parsed;
  const cutMs = parseInstant(values["--cut"]);
  const endMs = parseInstant(values["--end"]);
  if (cutMs === null) return { ok: false, message: "--cut is not an ISO date" };
  if (endMs === null) return { ok: false, message: "--end is not an ISO date" };
  if (endMs <= cutMs) return { ok: false, message: "--end is not after --cut" };
  const prRange = parseRange(values["--pr-range"]);
  if (!prRange) return { ok: false, message: "--pr-range is not LO-HI" };
  if (!lists["--root"].length && !positionals.length) {
    return { ok: false, message: "name a store with --root or a project dir" };
  }
  return {
    ok: true,
    options: {
      store: values["--store"],
      cut: values["--cut"],
      end: values["--end"],
      prRange,
      out: values["--out"],
      exclude: lists["--exclude"],
      only: lists["--only"],
      roots: lists["--root"],
      projectDirs: positionals,
    },
  };
}

/**
 * The lines of a file, split at "\n" only, in one batch per chunk read (a
 * trailing "\r" stays on its line, which JSON.parse takes as whitespace).
 */
export async function* fileLineBatches(file) {
  let pending = [];
  for await (const chunk of fs.createReadStream(file, { encoding: "utf8" })) {
    const lines = [];
    let start = 0;
    let newline;
    while ((newline = chunk.indexOf("\n", start)) !== -1) {
      pending.push(chunk.slice(start, newline));
      lines.push(pending.join(""));
      pending = [];
      start = newline + 1;
    }
    if (start < chunk.length) pending.push(chunk.slice(start));
    if (lines.length) yield lines;
  }
  if (pending.length) yield [pending.join("")];
}

function newUsage() {
  return {
    calls: 0,
    in: 0,
    out: 0,
    outFirst: 0,
    cacheRead: 0,
    cache1h: 0,
    cache5m: 0,
    ctxMax: 0,
  };
}

/** The token counts of an assistant entry's `message.usage`. */
export function usageVector(u) {
  const cc = u.cache_creation;
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cache5m: cc
      ? cc.ephemeral_5m_input_tokens || 0
      : u.cache_creation_input_tokens || 0,
    cache1h: cc ? cc.ephemeral_1h_input_tokens || 0 : 0,
  };
}

function addUsage(bucket, model, v, first) {
  const m = bucket[model] || (bucket[model] = newUsage());
  if (first) {
    m.calls++;
    m.outFirst += v.out;
  }
  for (const k of USAGE_FIELDS) m[k] += v[k];
  const ctx = v.in + v.cacheRead + v.cache5m + v.cache1h;
  if (first && ctx > m.ctxMax) m.ctxMax = ctx;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b.type === "text") return b.text || "";
        if (b.type === "tool_result") return textOf(b.content);
        return "";
      })
      .join("\n");
  }
  return "";
}

/**
 * The denial class of a tool result's text: `hook:<name>` or `hook:unknown`
 * for a hook's refusal, and for an error result `isolation`, `global-guard`,
 * `blocked-other`, `permission-deny` or `deny-rule`; null for anything else.
 */
export function classifyDenial(txt, isErr) {
  const t = txt.slice(0, 600);
  const hook = t.match(
    /^(?:PreToolUse|PostToolUse|UserPromptSubmit)[^\n]{0,40}hook error[^\n]*?hooks\/([a-z0-9-]+)\.(?:mjs|py|js)/,
  );
  if (hook) return "hook:" + hook[1];
  if (/^(?:PreToolUse|PostToolUse)[^\n]{0,40}hook (?:error|blocking)/.test(t)) {
    return "hook:unknown";
  }
  if (!isErr) return null;
  if (/isolated in the worktree/.test(t.slice(0, 200))) return "isolation";
  if (/^Blocked: /.test(t) && /global guard|outside the repo/.test(t)) {
    return "global-guard";
  }
  if (/^Blocked: /.test(t)) return "blocked-other";
  if (/^Permission to use .* has been denied/.test(t)) return "permission-deny";
  if (/was blocked by a deny rule/.test(t)) return "deny-rule";
  return null;
}

/**
 * The kind of an owner-side user entry: compact, notification, local-output,
 * interrupt, command, reminder, other-system, or typed.
 */
export function ownerKind(txt, e) {
  if (
    e.isCompactSummary ||
    /^This session is being continued from a previous conversation/.test(txt)
  ) {
    return "compact";
  }
  const t = txt.trimStart();
  if (t.startsWith("<task-notification>")) return "notification";
  if (
    t.startsWith("<local-command-stdout>") ||
    t.startsWith("<local-command-stderr>") ||
    t.startsWith("<local-command-caveat>") ||
    t.startsWith("Caveat:")
  ) {
    return "local-output";
  }
  if (t.startsWith("[Request interrupted")) return "interrupt";
  if (/<command-name>/.test(t)) return "command";
  if (
    t.startsWith("<system-reminder>") &&
    !t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
  ) {
    return "reminder";
  }
  if (/^\[Artifact comment|^<bash-input>|^<bash-stdout>/.test(t)) {
    return "other-system";
  }
  return "typed";
}

async function scanFile(file, rec, isSub, run) {
  const state = { rec, isSub, run, seenMsg: new Map(), firstPrompt: null };
  for await (const lines of fileLineBatches(file)) {
    for (const line of lines) scanLine(line, state);
  }
  return state.firstPrompt;
}

function scanLine(line, state) {
  const { rec, isSub, run, seenMsg } = state;
  if (!line.trim()) return;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    rec.parseErrors++;
    return;
  }
  const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
  const inWin = !Number.isNaN(ts) && ts >= run.cutMs && ts < run.endMs;
  if (!Number.isNaN(ts)) {
    if (!rec.firstTs || e.timestamp < rec.firstTs) rec.firstTs = e.timestamp;
    if (!rec.lastTs || e.timestamp > rec.lastTs) rec.lastTs = e.timestamp;
    if (inWin) {
      if (!rec.winFirstTs || e.timestamp < rec.winFirstTs) {
        rec.winFirstTs = e.timestamp;
      }
      if (!rec.winLastTs || e.timestamp > rec.winLastTs) {
        rec.winLastTs = e.timestamp;
      }
    }
  }
  if (e.gitBranch && inWin) {
    rec.branches[e.gitBranch] = (rec.branches[e.gitBranch] || 0) + 1;
  }
  if (e.type === "summary" || e.isCompactSummary) rec.compactions++;
  if (e.isApiErrorMessage) rec.apiErrors++;
  const side = isSub ? false : !!e.isSidechain;
  if (isSub && state.firstPrompt === null && e.type === "user" && e.message) {
    state.firstPrompt = textOf(e.message.content).slice(0, 4000);
  }
  if (e.type === "assistant" && e.message) {
    scanAssistant(e, rec, side, inWin, seenMsg, run);
  } else if (e.type === "user" && e.message && inWin) {
    scanUser(e, rec, side, isSub, run);
  }
}

function scanAssistant(e, rec, side, inWin, seenMsg, run) {
  const mid = e.message.id || e.uuid;
  const u = e.message.usage;
  const model = e.message.model || "unknown";
  const isCall = u && model !== "<synthetic>";
  const seen = isCall ? seenMsg.get(mid) : null;
  if (isCall && !seen) {
    const v = usageVector(u);
    const counted = { v, model, buckets: [] };
    seenMsg.set(mid, counted);
    const gkey = mid + "|" + (e.requestId || "");
    const dup = run.globalSeen.has(gkey);
    run.globalSeen.add(gkey);
    if (inWin) {
      counted.buckets.push(side ? rec.usageSidechainWin : rec.usageWin);
      if (dup) counted.buckets.push(rec.dupWin);
      const day = e.timestamp.slice(0, 10);
      counted.buckets.push(rec.byDay[day] || (rec.byDay[day] = {}));
    }
    for (const b of counted.buckets) addUsage(b, model, v, true);
  } else if (seen) {
    const last = usageVector(u);
    const target = { ...last, out: Math.max(seen.v.out, last.out) };
    const delta = {};
    let changed = false;
    for (const k of USAGE_FIELDS) {
      delta[k] = target[k] - seen.v[k];
      if (delta[k]) changed = true;
    }
    if (changed) {
      for (const b of seen.buckets) addUsage(b, seen.model, delta, false);
      seen.v = target;
      rec.streamRepeatsChanged++;
    }
  }
  if (inWin && Array.isArray(e.message.content)) {
    for (const b of e.message.content) {
      if (b.type !== "tool_use") continue;
      rec.toolUse[b.name] = (rec.toolUse[b.name] || 0) + 1;
      if ((b.name === "Task" || b.name === "Agent") && b.input) {
        rec.spawns.push({
          type: b.input.subagent_type || null,
          model: b.input.model || null,
          desc: (b.input.description || "").slice(0, 60),
        });
      }
      if (b.name === "Skill" && b.input) {
        const skill = b.input.skill || "?";
        rec.skills[skill] = (rec.skills[skill] || 0) + 1;
      }
      if (b.name === "Workflow") rec.workflowCalls++;
    }
  }
}

function scanUser(e, rec, side, isSub, run) {
  const c = e.message.content;
  const isToolResult =
    Array.isArray(c) && c.some((b) => b && b.type === "tool_result");
  const txt = textOf(c);
  if (isToolResult) {
    for (const b of c) {
      if (!b || b.type !== "tool_result") continue;
      const bt = textOf(b.content);
      if (b.is_error) rec.toolErrors++;
      const k = classifyDenial(bt, !!b.is_error);
      if (!k && b.is_error) {
        const prefix = bt
          .slice(0, 70)
          .replace(/[0-9a-f]{6,}/g, "H")
          .replace(/\d+/g, "N");
        run.errPrefixes[prefix] = (run.errPrefixes[prefix] || 0) + 1;
      }
      if (k) {
        rec.denials[k] = (rec.denials[k] || 0) + 1;
        if (rec.denialSamples.length < 30) {
          rec.denialSamples.push({
            ts: e.timestamp,
            k,
            snip: bt.slice(0, 200),
          });
        }
      }
    }
  } else if (!side && !isSub && !e.isMeta) {
    const k = ownerKind(txt, e);
    const day = e.timestamp.slice(0, 10);
    const d = rec.ownerByDay[day] || (rec.ownerByDay[day] = {});
    d[k] = (d[k] || 0) + 1;
    if (k === "typed" || k === "command" || k === "interrupt") rec.userTurns++;
    if (k === "interrupt") rec.interrupts++;
    const cmd = txt.match(/<command-name>([^<]+)<\/command-name>/);
    if (cmd) {
      const name = cmd[1].trim();
      rec.commands[name] = (rec.commands[name] || 0) + 1;
    }
  }
  if (!isToolResult) {
    for (const m of txt.matchAll(/(?:PR |pull\/|#)(\d{4})\b/g)) {
      const n = +m[1];
      if (n >= run.prRange.lo && n <= run.prRange.hi) {
        rec.prMentions[n] = (rec.prMentions[n] || 0) + 1;
      }
    }
  }
}

function newRec(id, kind, projectDir) {
  return {
    id,
    kind,
    projectDir: path.basename(projectDir),
    firstTs: null,
    lastTs: null,
    winFirstTs: null,
    winLastTs: null,
    usageWin: {},
    usageSidechainWin: {},
    dupWin: {},
    byDay: {},
    userTurns: 0,
    interrupts: 0,
    streamRepeatsChanged: 0,
    compactions: 0,
    apiErrors: 0,
    toolErrors: 0,
    parseErrors: 0,
    denials: {},
    denialSamples: [],
    ownerByDay: {},
    branches: {},
    toolUse: {},
    skills: {},
    commands: {},
    prMentions: {},
    spawns: [],
    workflowCalls: 0,
  };
}

function subSummary(srec, extra) {
  const { spawns, ownerByDay, userTurns, interrupts, commands, ...rest } = srec;
  return {
    ...rest,
    spawnCount: spawns.length,
    spawnModels: spawns.map((s) => `${s.type || "?"}:${s.model || "?"}`),
    ...extra,
  };
}

function readJsonOrNull(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/** The `meta.name` a workflow run's script declares, else its record's name. */
export function workflowName(wfJson) {
  if (!wfJson) return null;
  const m = (wfJson.script || "").match(
    /meta\s*=\s*\{[\s\S]{0,200}?name:\s*["'`]([^"'`]+)["'`]/,
  );
  return m ? m[1] : wfJson.name || null;
}

/** The ref a review workflow agent's first prompt names, or null. */
export function targetRef(prompt) {
  if (!prompt) return null;
  const m =
    prompt.match(/reviewing the ref ([A-Za-z0-9._/-]+)/) ||
    prompt.match(/origin\/staging\.\.\.([A-Za-z0-9._/-]+)/);
  return m ? m[1].replace(/[.,;:]+$/, "") : null;
}

function agentFiles(sessDir) {
  const subDir = path.join(sessDir, "subagents");
  const files = [];
  if (!fs.existsSync(subDir)) return files;
  for (const sf of fs.readdirSync(subDir)) {
    if (sf.endsWith(".jsonl"))
      files.push({ f: path.join(subDir, sf), wf: null });
  }
  const wfRoot = path.join(subDir, "workflows");
  if (!fs.existsSync(wfRoot)) return files;
  for (const w of fs.readdirSync(wfRoot)) {
    const wd = path.join(wfRoot, w);
    if (!fs.statSync(wd).isDirectory()) continue;
    for (const sf of fs.readdirSync(wd)) {
      if (sf.startsWith("agent-") && sf.endsWith(".jsonl")) {
        files.push({ f: path.join(wd, sf), wf: w });
      }
    }
  }
  return files;
}

function workflowRuns(sessDir) {
  const runs = {};
  const dir = path.join(sessDir, "workflows");
  if (!fs.existsSync(dir)) return runs;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const j = readJsonOrNull(path.join(dir, f));
    runs[f.replace(/\.json$/, "")] = {
      name: workflowName(j),
      ts: j?.timestamp || null,
    };
  }
  return runs;
}

/**
 * Aggregate the store `options` names (as parseArgs returns them). Returns the
 * object the step writes to --out.
 */
export async function aggregate(options) {
  const t0 = Date.now();
  const run = {
    cutMs: parseInstant(options.cut),
    endMs: parseInstant(options.end),
    prRange: options.prRange,
    globalSeen: new Set(),
    errPrefixes: {},
  };
  const exclude = new Set(options.exclude);
  const only = new Set(options.only);
  const projectDirs = [...options.projectDirs];
  for (const root of options.roots) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) projectDirs.push(path.join(root, e.name));
    }
  }
  const sessions = [];
  for (const pd of projectDirs) {
    let entries;
    try {
      entries = fs.readdirSync(pd, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      const id = ent.name.replace(/\.jsonl$/, "");
      if (exclude.has(id)) continue;
      if (only.size && !only.has(id)) continue;
      const file = path.join(pd, ent.name);
      const sessDir = path.join(pd, id);
      const subFiles = agentFiles(sessDir);
      let newest = fs.statSync(file).mtimeMs;
      for (const s of subFiles) {
        newest = Math.max(newest, fs.statSync(s.f).mtimeMs);
      }
      if (newest < run.cutMs) continue;
      const kind = ent.name.startsWith("agent-") ? "worktree-agent" : "session";
      const rec = newRec(id, kind, pd);
      await scanFile(file, rec, false, run);
      rec.subagents = [];
      const wfNames = workflowRuns(sessDir);
      rec.workflowRuns = wfNames;
      for (const s of subFiles) {
        if (fs.statSync(s.f).mtimeMs < run.cutMs) continue;
        const sid = path.basename(s.f).replace(/\.jsonl$/, "");
        const srec = newRec(sid, s.wf ? "workflow-agent" : "subagent", pd);
        const prompt = await scanFile(s.f, srec, true, run);
        const meta =
          readJsonOrNull(s.f.replace(/\.jsonl$/, ".meta.json")) || {};
        rec.subagents.push(
          subSummary(srec, {
            agentType: meta.agentType || null,
            metaModel: meta.model || null,
            desc: (meta.description || "").slice(0, 80),
            spawnDepth: meta.spawnDepth ?? null,
            wf: s.wf,
            wfName: s.wf ? wfNames[s.wf]?.name || null : null,
            targetRef: s.wf ? targetRef(prompt) : null,
            promptHead: (prompt || "").slice(0, 160),
          }),
        );
      }
      sessions.push(rec);
    }
  }
  const topUnclassifiedErrors = Object.fromEntries(
    Object.entries(run.errPrefixes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 80),
  );
  return {
    store: options.store,
    cut: options.cut,
    end: options.end,
    excluded: [...exclude],
    only: [...only],
    topUnclassifiedErrors,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    sessions,
  };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new UsageError(parsed.message);
  const { options } = parsed;
  const result = await aggregate(options);
  fs.writeFileSync(options.out, JSON.stringify(result));
  const agents = result.sessions.flatMap((s) => s.subagents);
  const nsub = agents.filter((a) => a.kind === "subagent").length;
  const nwf = agents.filter((a) => a.kind === "workflow-agent").length;
  console.log(
    `${result.store}: ${result.sessions.length} sessions, ${nsub} subagents, ` +
      `${nwf} workflow agents, ${result.elapsedSec}s -> ${options.out}`,
  );
}

runWhenMain(import.meta.url, USAGE, main);
