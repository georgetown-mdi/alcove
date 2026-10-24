// Argument and file helpers the retro kit's four steps share.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

// A date-only value is UTC; a value with a time names its zone, since a bare
// local time would shift the window by the running machine's offset.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Parse `argv` against `spec`: `values` names flags taking one value, `lists`
 * repeatable flags taking one value each, `booleans` flags taking none.
 * Anything not starting with `--` is a positional. Returns `{ ok: true, values,
 * lists, booleans, positionals }` or `{ ok: false, message }`.
 */
export function parseFlags(argv, spec) {
  const values = {};
  const lists = Object.fromEntries((spec.lists ?? []).map((f) => [f, []]));
  const booleans = Object.fromEntries(
    (spec.booleans ?? []).map((f) => [f, false]),
  );
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if ((spec.booleans ?? []).includes(arg)) {
      booleans[arg] = true;
      continue;
    }
    const takesValue = (spec.values ?? []).includes(arg);
    const repeats = (spec.lists ?? []).includes(arg);
    if (!takesValue && !repeats) {
      return { ok: false, message: `unknown option ${arg}` };
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `${arg} needs a value` };
    }
    i++;
    if (repeats) lists[arg].push(value);
    else if (arg in values) {
      return { ok: false, message: `${arg} given twice` };
    } else values[arg] = value;
  }
  for (const flag of spec.required ?? []) {
    if (!(flag in values)) return { ok: false, message: `${flag} is required` };
  }
  return { ok: true, values, lists, booleans, positionals };
}

/** The epoch milliseconds of an ISO 8601 instant, or null when malformed. */
export function parseInstant(value) {
  if (!ISO_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** `{ lo, hi }` from a `LO-HI` range of PR numbers, or null when malformed. */
export function parseRange(value) {
  const m = /^(\d+)-(\d+)$/.exec(value);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return lo <= hi ? { lo, hi } : null;
}

/** Round to cents, the precision every dollar figure is written at. */
export const r2 = (x) => +(+x).toFixed(2);

/** Parse a JSON file. */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Run `main(argv)` when the module at `moduleUrl` is the process entry point,
 * printing `usage` and exiting 2 on an argument error it throws as a
 * UsageError.
 */
export function runWhenMain(moduleUrl, usage, main) {
  if (process.argv[1] !== fileURLToPath(moduleUrl)) return;
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .catch((err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`${err.message}\n${usage}`);
        process.exit(2);
      }
      process.stderr.write(`${err.stack || err}\n`);
      process.exit(1);
    });
}

/** An argument error: the runner prints it with the step's usage. */
export class UsageError extends Error {}
