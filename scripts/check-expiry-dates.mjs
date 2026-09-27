#!/usr/bin/env node
// Expiry date check, run by static_checks.yaml through check:all.
//
// Every repository check and every tool hook has a date after which it stands
// only if someone renews it, so the layer of checks and hooks is reviewed
// rather than only grown. This check fails, naming the entry, when one has no
// date or when its date has passed:
//
//   - every entry of CHECKS, OUT_OF_CHECK_ALL and SEPARATE_WORKFLOW_STEPS in
//     scripts/run-checks.mjs, by its `expiresOn` field;
//   - every hook file .claude/settings.json registers, by an
//     `export const EXPIRES_ON = "YYYY-MM-DD";` line in the file itself, the
//     shape scripts/check-no-legacy-names.mjs set.
//
// A date is the last day, UTC, the entry passes. A new check or hook picks its
// own date when it is proposed. 2026-12-31, on every entry older than this
// check, is an arbitrary working value the first review below re-fits.
//
// REVIEW AT EACH RETRO. Run
//
//   node scripts/check-expiry-dates.mjs --expiring-before <next retro date>
//
// which lists every entry whose date falls before that day. For each, either
// renew it with a new date, or delete it: the check's script, its test, its
// root package.json script and its entry in scripts/run-checks.mjs; or the
// hook file, its test, its registration in .claude/settings.json and any
// `Enforced by` line naming it.
//
// `--today YYYY-MM-DD` stands in for the current date and `--root <tree>` for
// this repository, so the test can drive both arms against a fixture tree.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { registeredHooks } from "./check-enforcement-claims.mjs";
import { obligationRoot } from "./lib/deferredObligation.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HOOK_EXPIRY = /^export const EXPIRES_ON = "([^"]*)";$/m;

/** Whether `value` is a real calendar date written YYYY-MM-DD. */
export function isCalendarDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * The dated entries in the tree at `root`: `{name, expiresOn}`, where
 * `expiresOn` is undefined for an entry that states none.
 */
export async function datedEntries(root) {
  const lists = await import(
    pathToFileURL(resolve(root, "scripts/run-checks.mjs")).href
  );
  const entries = [];
  for (const [list, key] of [
    ["CHECKS", "script"],
    ["OUT_OF_CHECK_ALL", "script"],
    ["SEPARATE_WORKFLOW_STEPS", "command"],
  ]) {
    for (const entry of lists[list] ?? []) {
      entries.push({
        name: `scripts/run-checks.mjs ${list} entry ${entry[key]}`,
        expiresOn: entry.expiresOn,
      });
    }
  }
  const settings = JSON.parse(
    readFileSync(resolve(root, ".claude/settings.json"), "utf8"),
  );
  const hookFiles = [
    ...new Set(registeredHooks(settings).map((hook) => hook.file)),
  ];
  for (const file of hookFiles) {
    const path = resolve(root, ".claude/hooks", file);
    const source = existsSync(path) ? readFileSync(path, "utf8") : "";
    entries.push({
      name: `.claude/hooks/${file}`,
      expiresOn: HOOK_EXPIRY.exec(source)?.[1],
    });
  }
  return entries;
}

/** The entries that state no valid date, or whose date is before `today`. */
export function expiryViolations(entries, today) {
  const violations = [];
  for (const { name, expiresOn } of entries) {
    if (expiresOn === undefined) {
      violations.push(`${name}: states no expiry date.`);
    } else if (!isCalendarDate(expiresOn)) {
      violations.push(
        `${name}: expiry date "${expiresOn}" is not a YYYY-MM-DD calendar date.`,
      );
    } else if (expiresOn < today) {
      violations.push(`${name}: expired on ${expiresOn}.`);
    }
  }
  return violations;
}

/** The entries with a valid date before `day`, soonest first. */
export function expiringBefore(entries, day) {
  return entries
    .filter(({ expiresOn }) => isCalendarDate(expiresOn) && expiresOn < day)
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
}

function dateFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!isCalendarDate(value)) {
    console.error(
      "usage: node scripts/check-expiry-dates.mjs [--root <tree>] [--today YYYY-MM-DD] [--expiring-before YYYY-MM-DD]",
    );
    process.exit(2);
  }
  return value;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = obligationRoot(args, "scripts/check-expiry-dates.mjs");
  const today =
    dateFlag(args, "--today") ?? new Date().toISOString().slice(0, 10);
  const before = dateFlag(args, "--expiring-before");
  const entries = await datedEntries(root);
  if (before !== undefined) {
    const due = expiringBefore(entries, before);
    console.log(`${due.length} entries expire before ${before}:`);
    for (const { name, expiresOn } of due)
      console.log(`  ${expiresOn}  ${name}`);
    process.exit(0);
  }
  const violations = expiryViolations(entries, today);
  if (violations.length > 0) {
    console.error("expiry date check failed:\n");
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      "\nRenew each entry with a new date, or delete it; the steps are in the header of scripts/check-expiry-dates.mjs.",
    );
    process.exit(1);
  }
  console.log(
    `expiry date check passed: ${entries.length} checks and hooks are dated, none past ${today}.`,
  );
}
