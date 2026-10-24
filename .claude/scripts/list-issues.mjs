#!/usr/bin/env node
//
// List a GitHub Projects v2 board's items -- non-Done by default, everything
// under --all -- with their triage fields, fully paginated. Companion to
// fetch-issues.mjs (read one item by ID), list-epic.mjs (this listing filtered
// to one Epic), and edit-issue.mjs (write).
//
// A board-hygiene pass needs the whole inventory in one round-trip: every item
// with its numeric `?itemId=N` id, its `PVTI_` node id, status, Epic, and
// Order. `gh project item-list` cannot supply that -- its JSON
// omits the numeric id and the custom fields, and it silently caps at `--limit`
// (board 9 already holds more than one 100-item page), so a too-low limit drops
// items with no warning. This script goes through the same paginated GraphQL
// path as list-epic.mjs (shared fetchAllItems), which checks the pages against
// the item count the API reports for the board and retries a run that falls
// short: it prints every item that count covers, or exits 1 naming what did not
// add up. The completeness check and its limit: fetchAllItems in
// lib/projectItems.mjs.
//
// Usage:
//   node list-issues.mjs [--json] [--all | --status NAME...]
//                        [--skip-parked | --parked] <project-number>
//
// Flags and the project number may appear in any order.
//
// Default output is human-readable: one tab-separated line per item with numeric
// id, node id, status, [Order], Epic, and title, in board order.
// --json emits a compact array of { id, nodeId, status, epic, order, title } for
// programmatic consumers, consistent with fetch-issues.mjs and list-epic.mjs.
//
// By default every item whose Status is not Done is listed -- what a backlog or
// orchestration session needs, without paying for the board's Done history.
// --all lists every item including Done (the dedupe/hygiene view, where a Done
// item covering the work is itself the answer). Each --status NAME (repeatable)
// keeps only items whose Status equals NAME (case-insensitive); e.g.
// `--status Done` reads the history the default omits. --all and --status are
// rejected together: --all means "no filter", so pass the statuses alone.
// --open (the historical name for the default) is still accepted.
//
// A parked item's body has a `Parked until: <trigger>` line
// (.claude/pm/ruleset.md, Task template). --skip-parked leaves those items out
// and counts them on stderr; --parked keeps only them, each with its trigger
// (`parkedUntil` under --json). Either one reads the bodies of the items the
// status view kept, one request per hundred items.

import { fileURLToPath } from "node:url";
import { fetchAllItems, fetchItems, PAGE_SIZE } from "./lib/projectItems.mjs";

const USAGE =
  "Usage: node list-issues.mjs [--json] [--all | --status NAME...] [--skip-parked | --parked] <project-number>\n" +
  "       (lists non-Done items by default; flags may appear in any order)\n";

const PARKED_LINE = /^Parked until:[ \t]*(\S.*?)\s*$/m;

/**
 * Parse the option flags (--json, --all, --status NAME repeatable, --open,
 * --skip-parked, --parked) and the project-number positional, in any order.
 * Returns { ok: true, asJson, all, statuses, parked, projectNumber } on success,
 * parked being "skip", "only" or null, or { ok: false, message } (a
 * newline-terminated string ready to write straight to stderr) on any malformed
 * input, including contradictory filter flags. Pure, so a test can drive it
 * without touching argv or the network.
 */
export function parseArgs(argv) {
  let asJson = false;
  let open = false;
  let all = false;
  let skipParked = false;
  let onlyParked = false;
  const statuses = [];
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--json") {
      asJson = true;
      i += 1;
    } else if (arg === "--skip-parked") {
      skipParked = true;
      i += 1;
    } else if (arg === "--parked") {
      onlyParked = true;
      i += 1;
    } else if (arg === "--open") {
      open = true;
      i += 1;
    } else if (arg === "--all") {
      all = true;
      i += 1;
    } else if (arg === "--status") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: "error: --status requires a value\n" };
      }
      statuses.push(value.toLowerCase());
      i += 2;
    } else if (arg.startsWith("--")) {
      return { ok: false, message: USAGE };
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  if (all && (open || statuses.length > 0)) {
    return {
      ok: false,
      message:
        "error: --all cannot be combined with --open or --status -- pick one view: --all (everything), --status NAME (a subset), or no flag (non-Done, the default)\n",
    };
  }
  if (open && statuses.length > 0) {
    return {
      ok: false,
      message:
        "error: --open cannot be combined with --status -- non-Done is already the default, so pass the statuses alone\n",
    };
  }

  if (skipParked && onlyParked) {
    return {
      ok: false,
      message:
        "error: --skip-parked cannot be combined with --parked -- pick one: --skip-parked (leave parked items out) or --parked (list only them)\n",
    };
  }

  const projectNumber = Number(positionals[0]);
  if (!Number.isInteger(projectNumber) || positionals.length !== 1) {
    return { ok: false, message: USAGE };
  }

  const parked = skipParked ? "skip" : onlyParked ? "only" : null;
  return { ok: true, asJson, all, statuses, parked, projectNumber };
}

/**
 * The trigger a body's `Parked until:` line names, or null when the body has
 * no such line or the line names nothing. Only the body's first non-empty
 * line is read, so an example line lower down or in a fenced block parks
 * nothing.
 */
export function parkedTrigger(body) {
  if (typeof body !== "string") return null;
  const top = body.split(/\r?\n/).find((line) => /\S/.test(line));
  if (top === undefined) return null;
  const match = PARKED_LINE.exec(top);
  return match ? match[1] : null;
}

/**
 * Apply a --skip-parked ("skip") or --parked ("only") view to items already
 * filtered by status, given a Map of item id -> trigger (null when not
 * parked). "skip" drops every parked item; "only" keeps just those, adding
 * each one's trigger as `parkedUntil`. Pure, so a test can drive it with
 * synthetic items.
 */
export function applyParkedView(items, triggers, view) {
  if (view === "skip") return items.filter((item) => !triggers.get(item.id));
  return items
    .filter((item) => triggers.get(item.id))
    .map((item) => ({ ...item, parkedUntil: triggers.get(item.id) }));
}

async function readParkedTriggers(projectNumber, ids) {
  const triggers = new Map();
  for (let start = 0; start < ids.length; start += PAGE_SIZE) {
    const fetched = await fetchItems(
      projectNumber,
      ids.slice(start, start + PAGE_SIZE),
    );
    for (const entry of fetched) {
      triggers.set(entry.id, parkedTrigger(entry.body));
    }
  }
  return triggers;
}

/**
 * Filter mapped items ({ id, nodeId, status, epic, order, title }) by the parsed
 * --status / --all options. --status keeps only matching Statuses
 * (case-insensitive). --all passes every item through. The default keeps every
 * item whose Status is not Done (case-insensitive), including one with no
 * Status at all. Pure, so a test can drive it with synthetic items.
 */
export function filterItems(items, { statuses, all }) {
  const wanted = new Set(statuses);
  if (wanted.size > 0) {
    return items.filter(
      (item) => item.status !== null && wanted.has(item.status.toLowerCase()),
    );
  }
  if (all) return items;
  return items.filter(
    (item) => item.status === null || item.status.toLowerCase() !== "done",
  );
}

async function main() {
  // A whole-board dump is routinely piped to `head`/`grep`, which closes the
  // read end early; exit quietly on the resulting EPIPE instead of crashing.
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(parsed.message);
    process.exit(2);
  }
  const { asJson, all, statuses, parked, projectNumber } = parsed;

  let items = filterItems(
    (await fetchAllItems(projectNumber)).map((item) => ({
      id: item.id,
      nodeId: item.nodeId,
      status: item.fields.Status ?? null,
      epic: item.fields.Epic ?? null,
      order: item.fields["Order"],
      title: item.title,
    })),
    { statuses, all },
  );

  if (parked !== null) {
    const triggers = await readParkedTriggers(
      projectNumber,
      items.map((item) => item.id),
    );
    const kept = applyParkedView(items, triggers, parked);
    if (parked === "skip" && kept.length < items.length) {
      const skipped = items.length - kept.length;
      process.stderr.write(
        `${skipped} parked item${skipped === 1 ? "" : "s"} left out; --parked lists them\n`,
      );
    }
    items = kept;
  }

  if (asJson) {
    // Compact, not pretty-printed: --json feeds programmatic/agent consumers,
    // where indentation is dead weight in the reader's context.
    process.stdout.write(JSON.stringify(items) + "\n");
    return;
  }

  if (items.length === 0) {
    const filter =
      statuses.length > 0
        ? ` matching status ${[...new Set(statuses)].join(", ")}`
        : all
          ? ""
          : " with Status != Done (--all includes Done)";
    const kind = parked === "only" ? "parked items" : "items";
    process.stdout.write(`no ${kind} on project ${projectNumber}${filter}\n`);
    return;
  }

  for (const m of items) {
    const order = typeof m.order === "number" ? String(m.order) : "-";
    const trigger =
      m.parkedUntil === undefined ? "" : `\tParked until: ${m.parkedUntil}`;
    process.stdout.write(
      `${m.id}\t${m.nodeId}\t${m.status ?? "-"}\t[${order}]\t${m.epic ?? "-"}\t${m.title}${trigger}\n`,
    );
  }
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message ?? err}\n`);
    process.exit(1);
  });
}
