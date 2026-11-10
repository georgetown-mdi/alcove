#!/usr/bin/env node
//
// Follow-up step of the retro spend kit: for each pull request merged in the
// window, the earlier pull requests it follows up, planned or unplanned, from
// git blame. Writes followups.json to --dir, which trend.mjs reads.
//
// Usage:
//   node followups.mjs --repo DIR --ref REF --pr-range LO-HI --prs FILE
//     --dir DIR [--jobs N]
//
// The series is REF's first-parent commits whose subject ends `(#N)`, N in
// --pr-range; each is one squash-merged PR F, dated by its committer time.
// --prs is a JSON array of { number, body }, as
//   gh pr list --state merged --base staging --limit 1000
//     --search "merged:>=DATE" --json number,body
// writes it, DATE 7 days before the window's cut so each source's body is
// there. --jobs (default 8) bounds the concurrent blames.
//
// The rule:
//   - F's deleted lines are `git diff -M -U0 F^ F`, lockfiles and CHANGELOG.md
//     left out. Each is blamed with `git blame -w -M -C` at F^, with lines
//     older than 7 days cut off at a boundary commit. A file whose blame fails
//     is left out of F's count and recorded.
//   - F follows S when at least 5 and at least 50% of F's deleted lines blame
//     to S's commit, and S's committer time is under 7 days before F's.
//   - The link is planned when F's Part of, Follow-on or Follows line names S
//     (`#S`, `/pull/S`) or an item on S's Implements, Part of, Follow-on or
//     Depends on lines, or S's body names an item on such a line of F's.
//   - Left out: a PR titled Bump, as F or as S, and a link whose lines all lie
//     in a package.json or are image pins (a FROM or image: line, or an
//     @sha256: reference).

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  parseFlags,
  parseRange,
  readJson,
  runWhenMain,
  UsageError,
} from "./args.mjs";

const USAGE =
  "Usage: node followups.mjs --repo DIR --ref REF --pr-range LO-HI --prs FILE --dir DIR [--jobs N]\n";

const WEEK_S = 7 * 86400;
const MIN_LINES = 5;
const MIN_SHARE = 0.5;
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

/**
 * Parse the follow-up step's arguments. Returns `{ ok: true, options }` or
 * `{ ok: false, message }`.
 */
export function parseArgs(argv) {
  const parsed = parseFlags(argv, {
    values: ["--repo", "--ref", "--pr-range", "--prs", "--dir", "--jobs"],
    required: ["--repo", "--ref", "--pr-range", "--prs", "--dir"],
  });
  if (!parsed.ok) return parsed;
  if (parsed.positionals.length) {
    return { ok: false, message: `unexpected ${parsed.positionals[0]}` };
  }
  const v = parsed.values;
  const prRange = parseRange(v["--pr-range"]);
  if (!prRange) return { ok: false, message: "--pr-range is not LO-HI" };
  const jobs = Number(v["--jobs"] ?? 8);
  if (!Number.isInteger(jobs) || jobs < 1) {
    return { ok: false, message: "--jobs is not a positive integer" };
  }
  return {
    ok: true,
    options: {
      repo: v["--repo"],
      ref: v["--ref"],
      prRange,
      prs: v["--prs"],
      dir: v["--dir"],
      jobs,
    },
  };
}

const excludedPath = (p) => LOCKFILE.test(p) || p === "CHANGELOG.md";

/** Whether a deleted line is in a package manifest or pins an image. */
export function isManifestOrPin(file, text) {
  return (
    path.posix.basename(file) === "package.json" ||
    /^\s*(FROM\s|image:\s)/i.test(text) ||
    /@sha256:[0-9a-f]{64}/.test(text)
  );
}

/**
 * The deleted lines of a `git diff -U0` text, per file: `[{ file, lines:
 * [{ n, text }] }]`, `n` the line's number in the old file. A hunk's lines are
 * consumed by its header's counts, so a deleted line beginning `-- ` is
 * content, not a `--- ` file header.
 */
export function parseDeletedLines(diff) {
  const files = [];
  let cur = null;
  let del = 0;
  let add = 0;
  let next = 0;
  for (const line of diff.split("\n")) {
    if (del > 0 && line.startsWith("-")) {
      cur.lines.push({ n: next++, text: line.slice(1) });
      del--;
      continue;
    }
    if (add > 0 && line.startsWith("+")) {
      add--;
      continue;
    }
    if (line.startsWith("\\")) continue;
    del = 0;
    add = 0;
    if (line.startsWith("diff --git ")) {
      cur = { file: null, lines: [] };
      files.push(cur);
    } else if (cur && line.startsWith("--- ")) {
      // git ends the name with a tab when it holds a space.
      cur.file = line.startsWith("--- a/")
        ? line.slice(6).replace(/\t$/, "")
        : null;
    } else if (cur) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (m) {
        next = Number(m[1]);
        del = m[2] === undefined ? 1 : Number(m[2]);
        add = m[3] === undefined ? 1 : Number(m[3]);
      }
    }
  }
  return files.filter((f) => f.file && f.lines.length);
}

/**
 * The sources F follows. `lines` are F's blamed deleted lines, `[{ sha,
 * manifest }]`; `commits` maps a sha to `{ ct, pr, title, boundary }`; `ct` is
 * F's committer time. Returns `[{ sha, pr, lines }]`.
 */
export function followLinks({ ct, lines, commits }) {
  const bySha = new Map();
  for (const l of lines) {
    const c = commits.get(l.sha);
    if (!c || c.boundary || !(ct - c.ct < WEEK_S)) continue;
    const s =
      bySha.get(l.sha) || bySha.set(l.sha, { n: 0, manifest: 0 }).get(l.sha);
    s.n++;
    if (l.manifest) s.manifest++;
  }
  const links = [];
  for (const [sha, s] of bySha) {
    const c = commits.get(sha);
    if (s.n < MIN_LINES || s.n < MIN_SHARE * lines.length) continue;
    if (/^Bump /.test(c.title) || s.manifest === s.n) continue;
    links.push({ sha, pr: c.pr, lines: s.n });
  }
  return links;
}

const OWN_LINE = /^(Implements|Part of|Follow-on|Depends on)\b/i;
const LINK_LINE = /^(Part of|Follow-on|Follows)\b/i;
const itemIds = (text) => [...text.matchAll(/itemId=(\d+)/g)].map((m) => m[1]);
const linesOf = (body, re) =>
  (body || "").split(/\r?\n/).filter((l) => re.test(l.trim()));

/** Whether F's link to S (PR number `sPr`, or null) is planned. */
export function isPlanned(fBody, sBody, sPr) {
  const sOwn = new Set(linesOf(sBody, OWN_LINE).flatMap(itemIds));
  for (const line of linesOf(fBody, LINK_LINE)) {
    if (sPr !== null && new RegExp(`(?:#|/pull/)${sPr}\\b`).test(line))
      return true;
    if (itemIds(line).some((id) => sOwn.has(id))) return true;
  }
  const sAll = new Set(itemIds(sBody || ""));
  return linesOf(fBody, OWN_LINE)
    .flatMap(itemIds)
    .some((id) => sAll.has(id));
}

const prOf = (subject) => {
  const m = /\(#(\d+)\)$/.exec(subject);
  return m ? Number(m[1]) : null;
};

function blame(repo, sha, file, boundary) {
  const args = ["blame", "-w", "-M", "-C", "--porcelain"];
  if (boundary) args.push("^" + boundary);
  args.push(sha + "^", "--", file);
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd: repo, env: GIT_ENV });
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.resume();
    p.on("close", (code) =>
      resolve(
        code === 0
          ? parsePorcelain(Buffer.concat(chunks).toString("utf8"))
          : null,
      ),
    );
  });
}

/**
 * A `git blame --porcelain` text as `{ byLine, commits }`: the sha of each
 * line by its number in the blamed file, and each commit's committer time,
 * summary and boundary flag.
 */
export function parsePorcelain(text) {
  const byLine = [];
  const commits = new Map();
  let cur = null;
  for (const line of text.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (head) {
      byLine[Number(head[2])] = head[1];
      cur =
        commits.get(head[1]) ||
        commits
          .set(head[1], { ct: null, title: "", boundary: false })
          .get(head[1]);
    } else if (cur && line.startsWith("committer-time ")) {
      cur.ct = Number(line.slice(15));
    } else if (cur && line.startsWith("summary ")) {
      cur.title = line.slice(8);
    } else if (cur && line === "boundary") {
      cur.boundary = true;
    }
  }
  return { byLine, commits };
}

async function followsOf(repo, c) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repo,
      env: GIT_ENV,
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
  const diff = git([
    "diff",
    "-M",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    c.sha + "^",
    c.sha,
  ]);
  const files = parseDeletedLines(diff).filter((f) => !excludedPath(f.file));
  const boundary =
    git([
      "log",
      "--first-parent",
      "--format=%H",
      `--until=@${c.ct - WEEK_S}`,
      "-1",
      c.sha + "^",
    ]).trim() || null;
  const lines = [];
  const commits = new Map();
  const failed = [];
  for (const f of files) {
    const b = await blame(repo, c.sha, f.file, boundary);
    if (!b) {
      failed.push(f.file);
      continue;
    }
    for (const [sha, info] of b.commits) {
      commits.set(sha, { ...info, pr: prOf(info.title) });
    }
    for (const l of f.lines) {
      lines.push({
        sha: b.byLine[l.n],
        manifest: isManifestOrPin(f.file, l.text),
      });
    }
  }
  return {
    deleted: lines.length,
    failed,
    links: followLinks({ ct: c.ct, lines, commits }),
  };
}

/**
 * The follow-up series over `options` (as parseArgs returns them, with `bodies`
 * a Map of PR number to body). Returns the object the step writes.
 */
export async function followups(options) {
  const log = execFileSync(
    "git",
    ["log", "--first-parent", options.ref, "--format=%H%x09%ct%x09%s"],
    { cwd: options.repo, env: GIT_ENV, encoding: "utf8", maxBuffer: 1 << 30 },
  );
  const series = log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ct, subject] = l.split("\t");
      return { sha, ct: Number(ct), title: subject, pr: prOf(subject) };
    })
    .filter(
      (c) =>
        c.pr !== null &&
        c.pr >= options.prRange.lo &&
        c.pr <= options.prRange.hi,
    )
    .reverse();
  const prs = new Array(series.length);
  let next = 0;
  const worker = async () => {
    while (next < series.length) {
      const i = next++;
      const c = series[i];
      const row = {
        pr: c.pr,
        sha: c.sha,
        day: new Date(c.ct * 1000).toISOString().slice(0, 10),
        title: c.title,
        bump: /^Bump /.test(c.title),
        deleted: 0,
        failedFiles: [],
        follows: [],
      };
      if (!row.bump) {
        const r = await followsOf(options.repo, c);
        row.deleted = r.deleted;
        row.failedFiles = r.failed;
        row.follows = r.links.map((l) => ({
          ...l,
          planned: isPlanned(
            options.bodies.get(c.pr),
            options.bodies.get(l.pr),
            l.pr,
          ),
        }));
      }
      prs[i] = row;
    }
  };
  await Promise.all(Array.from({ length: options.jobs }, worker));
  const missingBodies = [
    ...new Set(prs.flatMap((p) => [p.pr, ...p.follows.map((l) => l.pr)])),
  ].filter((n) => n !== null && !options.bodies.has(n));
  return { ref: options.ref, prRange: options.prRange, missingBodies, prs };
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new UsageError(parsed.message);
  const { options } = parsed;
  const bodies = new Map(
    readJson(options.prs).map((p) => [p.number, p.body ?? ""]),
  );
  const out = await followups({ ...options, bodies });
  fs.writeFileSync(
    path.join(options.dir, "followups.json"),
    JSON.stringify(out),
  );
  const series = out.prs.filter((p) => !p.bump);
  const follows = series.filter((p) => p.follows.length);
  const planned = follows.filter((p) => p.follows.some((l) => l.planned));
  console.log(
    `${series.length} PRs, ${follows.length} follow-ups (${planned.length} planned), ` +
      `${out.missingBodies.length} PR bodies missing -> ${path.join(options.dir, "followups.json")}`,
  );
}

runWhenMain(import.meta.url, USAGE, main);
