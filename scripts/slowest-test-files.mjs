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
// not in it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How many files the table lists unless `--top` says otherwise. */
export const DEFAULT_TOP = 20;

/**
 * One row per test file across `reports`, slowest first, its path relative to
 * `root`. A file two runs both report is listed once per run.
 */
export function fileDurations(reports, root) {
  const rows = [];
  for (const report of reports) {
    for (const result of report.testResults ?? []) {
      rows.push({
        file: relative(root, result.name),
        durationMs: Math.max(0, result.endTime - result.startTime),
        tests: result.assertionResults?.length ?? 0,
        status: result.status,
      });
    }
  }
  return rows.sort((a, b) => b.durationMs - a.durationMs);
}

/** The markdown table of the `top` slowest rows, under `title`. */
export function formatSlowest(rows, { top = DEFAULT_TOP, title } = {}) {
  const heading = `### Slowest test files${title ? `: ${title}` : ""}`;
  if (rows.length === 0)
    return `${heading}\n\nNo vitest JSON report was found.\n`;
  const lines = [
    heading,
    "",
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { top, title, paths } = parseArgs(process.argv.slice(2));
    const reports = reportPaths(paths).map((path) =>
      JSON.parse(readFileSync(path, "utf8")),
    );
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    process.stdout.write(
      formatSlowest(fileDurations(reports, root), { top, title }),
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 2;
  }
}
