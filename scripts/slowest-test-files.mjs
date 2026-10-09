#!/usr/bin/env node
// Ranks test files by duration from vitest JSON reports, the files
// scripts/lib/jsonReportReporter.mjs writes when ALCOVE_VITEST_JSON_DIR is set.
//
//   node scripts/slowest-test-files.mjs [--top N] [--title TEXT] <file-or-dir>...
//
// A directory is read for every `.json` file directly inside it. The table is
// markdown, so CI appends it to the job summary. A file's duration is the span
// from its first test's start to its last test's end, as vitest's JSON report
// records it: the module's import and collection time before its first test is
// not in it. A report that cannot be read is named in a note and skipped; the
// exit is 2 only when reports were found and none could be read.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** How many files the table lists unless `--top` says otherwise. */
export const DEFAULT_TOP = 20;

/** The top-level directories of this repository a test file can sit under. */
const WORKSPACE_DIRECTORIES = new Set([
  "apps",
  "packages",
  "scripts",
  ".claude",
]);

/**
 * `file` as the table shows it: relative to `root` when inside it, otherwise,
 * as for a report a CI runner wrote, from its first segment naming a
 * {@link WORKSPACE_DIRECTORIES} entry, or its parent and base name.
 */
export function displayPath(file, root) {
  const inside = relative(root, file);
  const outside =
    inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  if (inside !== "" && !outside) return inside.split(sep).join("/");
  const segments = file.split(/[\\/]/);
  const start = segments.findIndex((segment) =>
    WORKSPACE_DIRECTORIES.has(segment),
  );
  if (start !== -1) return segments.slice(start).join("/");
  return segments.slice(-2).join("/");
}

/**
 * One row per test file across `reports`, slowest first, and how many entries
 * lacked a start or end time, each listed at zero. A file two runs both report
 * is listed once per run.
 */
export function fileDurations(reports, root) {
  const rows = [];
  let untimed = 0;
  for (const report of reports) {
    for (const result of report.testResults ?? []) {
      const timed =
        Number.isFinite(result.startTime) && Number.isFinite(result.endTime);
      if (!timed) untimed += 1;
      rows.push({
        file: displayPath(result.name, root),
        durationMs: timed ? Math.max(0, result.endTime - result.startTime) : 0,
        tests: result.assertionResults?.length ?? 0,
        status: result.status,
      });
    }
  }
  return { rows: rows.sort((a, b) => b.durationMs - a.durationMs), untimed };
}

/**
 * The markdown table of the `top` slowest rows, under `title`, after a line
 * for each of `notes`.
 */
export function formatSlowest(
  rows,
  { top = DEFAULT_TOP, title, notes = [] } = {},
) {
  const heading = `### Slowest test files${title ? `: ${title}` : ""}`;
  const noteLines = notes.flatMap((note) => [note, ""]);
  if (rows.length === 0)
    return [
      heading,
      "",
      ...noteLines,
      "No vitest JSON report was found.",
      "",
    ].join("\n");
  const lines = [
    heading,
    "",
    ...noteLines,
    `${Math.min(top, rows.length)} of ${rows.length} files.`,
    "",
    "| # | File | Seconds | Tests | Status |",
    "| -: | :- | -: | -: | :- |",
  ];
  rows.slice(0, top).forEach((row, index) => {
    lines.push(
      `| ${index + 1} | \`${row.file}\` | ${(row.durationMs / 1000).toFixed(1)} | ${row.tests} | ${row.status} |`,
    );
  });
  return `${lines.join("\n")}\n`;
}

function reportPaths(paths) {
  const found = [];
  for (const path of paths) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      found.push(path);
      continue;
    }
    for (const name of readdirSync(path).sort())
      if (name.endsWith(".json")) found.push(join(path, name));
  }
  return found;
}

function parseArgs(argv) {
  const options = { top: DEFAULT_TOP, title: undefined, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--top") {
      options.top = Number(argv[(index += 1)]);
      if (!Number.isInteger(options.top) || options.top < 1)
        throw new Error("--top takes a positive whole number");
    } else if (arg === "--title") {
      options.title = argv[(index += 1)];
    } else {
      options.paths.push(arg);
    }
  }
  if (options.paths.length === 0)
    throw new Error(
      "usage: slowest-test-files.mjs [--top N] [--title TEXT] <file-or-dir>...",
    );
  return options;
}

/**
 * The parsed reports at `paths`, and a note naming those that could not be
 * read, or undefined when every one was.
 */
export function readReports(paths) {
  const reports = [];
  const unreadable = [];
  for (const path of paths) {
    try {
      reports.push(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      unreadable.push(path);
    }
  }
  const note =
    unreadable.length === 0
      ? undefined
      : `Skipped ${unreadable.length} unreadable report${unreadable.length === 1 ? "" : "s"}: ${unreadable.join(", ")}.`;
  return { reports, note };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { top, title, paths } = parseArgs(process.argv.slice(2));
    const found = reportPaths(paths);
    const { reports, note } = readReports(found);
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const { rows, untimed } = fileDurations(reports, root);
    const notes = [note].filter((each) => each !== undefined);
    if (untimed > 0)
      notes.push(
        `${untimed} file${untimed === 1 ? " has" : "s have"} no start or end time and ${untimed === 1 ? "is" : "are"} listed at 0 seconds.`,
      );
    process.stdout.write(formatSlowest(rows, { top, title, notes }));
    if (found.length > 0 && reports.length === 0) process.exitCode = 2;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 2;
  }
}
