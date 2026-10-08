// Reading a single option off a parsed yargs argv: each helper rejects a repeat
// and a malformed value as a flag-named UsageError, so a bad value is refused at
// the command line rather than reaching the code that would misuse it.

import type { Arguments } from "yargs";

import { USAGE_EXIT_CODE } from "@alcove/cli-contract";
import {
  csvDelimiterRefusal,
  isCsvDelimiterChoice,
  MAX_TIMEOUT_SECONDS,
  MAX_TIMER_MS,
  normalizeCsvDelimiter,
  sanitizeErrorForDisplay,
  UsageError,
} from "@alcove/core";

import { BARE_INVOCATION_SUMMARY, BareInvocationError } from "../usageHints";
import { parseDurationFlag, parseFineDurationFlag } from "./duration";

/**
 * Read a single-value CLI option, throwing a {@link UsageError} for a repeated
 * flag, which yargs collects into an array. Returns the value uncast, or
 * `undefined` when absent. Not for `count` or `boolean` options, where a repeat
 * is valid.
 */
export function singleValue(argv: Arguments, name: string): unknown {
  const value = argv[name];
  if (Array.isArray(value))
    throw new UsageError(`--${name} may be given only once`);
  return value;
}

/**
 * Reject a `--`-prefixed positional as an unknown option, in yargs'
 * `strictOptions` wording. For commands that set `unknown-options-as-args` so
 * a `-`-leading invitation survives as a positional; no legitimate positional
 * starts with `--`, and a single-`-` token is left alone.
 */
export function assertNoUnknownOptions(positionals: Array<unknown>): void {
  const unknown = positionals
    .map(String)
    .filter((token) => token.startsWith("--"));
  if (unknown.length === 0) return;
  throw new UsageError(
    `Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
  );
}

/**
 * The ceiling on the duration-valued timeout flags, shared with the console
 * through core; rationale in `packages/core/src/config/connection.ts`.
 */
export { MAX_TIMEOUT_SECONDS };

/**
 * Read a duration-valued CLI option as whole seconds, or `undefined` when
 * absent. A repeat, a malformed or bare-integer value, or a value above
 * `maxSeconds` is a flag-named {@link UsageError}; `ceilingMeaning`, when
 * given, follows the stated maximum in parentheses.
 */
export function durationFlagSeconds(
  argv: Arguments,
  name: string,
  maxSeconds: number,
  ceilingMeaning?: string,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  // String() so a non-string value gets the flag-named UsageError, not a
  // TypeError from .trim().
  const seconds = parseDurationFlag(`--${name}`, String(raw)) / 1000;
  if (seconds > maxSeconds) {
    const maximum =
      maxSeconds % 86_400 === 0
        ? `${String(maxSeconds / 86_400)}d`
        : `${String(maxSeconds)}s`;
    const meaning = ceilingMeaning === undefined ? "" : ` (${ceilingMeaning})`;
    throw new UsageError(
      `--${name} must not exceed ${maximum}${meaning}; got ${String(raw)}`,
    );
  }
  return seconds;
}

/**
 * Read a duration-valued CLI option as whole milliseconds, accepting a
 * `100ms`-style value, or `undefined` when absent. The value arms a timer, so
 * it is capped at {@link MAX_TIMER_MS}; a repeat, a malformed value or one
 * above the cap is a flag-named {@link UsageError}.
 */
export function durationFlagMs(
  argv: Arguments,
  name: string,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  const ms = parseFineDurationFlag(`--${name}`, String(raw));
  if (ms > MAX_TIMER_MS)
    throw new UsageError(
      `--${name} must not exceed ${String(MAX_TIMER_MS)}ms ` +
        `(about ${String(Math.floor(MAX_TIMER_MS / 86_400_000))} days); ` +
        `got ${String(raw)}`,
    );
  return ms;
}

/**
 * Read a count-valued CLI option as a non-negative safe integer, matching the
 * schema's `z.int().nonnegative()`, or `undefined` when absent; `maxValue` is
 * an inclusive ceiling. A rejected value is echoed in the error, so route no
 * secret-valued flag through here: {@link sanitizeErrorForDisplay} redacts PEM
 * blocks, not a bare token.
 */
export function nonNegativeIntFlag(
  argv: Arguments,
  name: string,
  maxValue?: number,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw new UsageError(
      `--${name} must be a non-negative whole number; got ${String(raw)}`,
    );
  if (maxValue !== undefined && raw > maxValue)
    throw new UsageError(
      `--${name} must not exceed ${maxValue}; got ${String(raw)}`,
    );
  return raw;
}

/**
 * Read `--csv-delimiter`: a single character or `detect`, or `undefined` when
 * absent (commas). The rule is core's, shared with the configuration schema;
 * a refused value is a {@link UsageError} at parse time.
 */
export function csvDelimiterFlag(argv: Arguments): string | undefined {
  const raw = singleValue(argv, "csv-delimiter");
  if (raw === undefined) return undefined;
  const resolved = normalizeCsvDelimiter(String(raw));
  if (!isCsvDelimiterChoice(resolved))
    throw new UsageError(
      `--csv-delimiter: ${csvDelimiterRefusal(String(raw))}`,
    );
  return resolved;
}

/**
 * Run a parse step that precedes the logger, printing a {@link UsageError} to
 * stderr and exiting 64; other errors propagate. A
 * {@link BareInvocationError} prints {@link BARE_INVOCATION_SUMMARY} as
 * written.
 */
export function parseOrExit<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(
      err instanceof BareInvocationError
        ? BARE_INVOCATION_SUMMARY
        : sanitizeErrorForDisplay(err),
    );
    process.exit(USAGE_EXIT_CODE);
  }
}
