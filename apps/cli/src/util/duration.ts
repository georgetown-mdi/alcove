import { UsageError } from "@alcove/core";

// Milliseconds per unit suffix. No calendar units: a month has no fixed length.
const UNIT_MS: Record<"s" | "m" | "h" | "d", number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// The coarse units plus `ms`, for {@link parseFineDuration} only.
const FINE_UNIT_MS: Record<"ms" | "s" | "m" | "h" | "d", number> = {
  ms: 1,
  ...UNIT_MS,
};
const COARSE_DURATION_RE = /^(\d+)(s|m|h|d)$/;
const FINE_DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

/**
 * The grammar both duration parsers share: a positive integer followed by a
 * required unit suffix from `units`, returned in milliseconds. `unitList` and
 * `examples` fill the refusal.
 */
function parseUnitDuration(
  input: string,
  units: Record<string, number>,
  re: RegExp,
  unitList: string,
  examples: string,
): number {
  const trimmed = input.trim();
  const match = re.exec(trimmed);
  if (match === null)
    throw new UsageError(
      `invalid duration ${JSON.stringify(trimmed)}: expected a positive ` +
        `integer followed by a unit (${unitList}), e.g. ${examples}`,
    );
  const magnitude = Number(match[1]);
  if (magnitude === 0)
    throw new UsageError(
      `duration must be greater than zero; got ${JSON.stringify(trimmed)}`,
    );
  const ms = magnitude * units[match[2]];
  if (!Number.isSafeInteger(ms))
    throw new UsageError(`duration ${JSON.stringify(trimmed)} is too large`);
  return ms;
}

/**
 * Parse a CLI duration such as `45s` or `30m` (units `s`, `m`, `h`, `d`) into
 * positive milliseconds: docs/CLI.md#configuration.
 *
 * @throws {UsageError} for a missing unit, a zero or non-integer magnitude, or
 * a value past a safe integer.
 */
export function parseDuration(input: string): number {
  return parseUnitDuration(
    input,
    UNIT_MS,
    COARSE_DURATION_RE,
    "s, m, h, or d",
    "45s, 30m, 2h, or 1d",
  );
}

/**
 * {@link parseDuration} plus the `ms` unit, for `--polling-frequency` only.
 *
 * @throws {UsageError} on the same conditions as {@link parseDuration}.
 */
export function parseFineDuration(input: string): number {
  return parseUnitDuration(
    input,
    FINE_UNIT_MS,
    FINE_DURATION_RE,
    "ms, s, m, h, or d",
    "100ms, 5s, 30m, or 1d",
  );
}

/** The `--help` fragment for the {@link parseDuration} syntax. */
export const DURATION_VALUE_HELP =
  "A duration with a required unit suffix: s, m, h, or d, e.g. 45s, 30m, 2h, or 1d";

/** The `--help` fragment for the {@link parseFineDuration} syntax. */
export const FINE_DURATION_VALUE_HELP =
  "A duration with a required unit suffix: ms, s, m, h, or d, e.g. 100ms, 5s, or 2m";

/**
 * {@link parseDuration} for a flag's value, naming the flag in any error. A
 * bare positive integer is refused with the suffixed value to use (`30` ->
 * `30s`).
 *
 * @param flag the flag name as written on the command line, e.g. `--peer-timeout`.
 * @throws {UsageError} for a bare integer, or any input parseDuration rejects.
 */
export function parseDurationFlag(flag: string, value: string): number {
  return parseDurationFlagWith(flag, value, parseDuration);
}

/**
 * {@link parseDurationFlag} through {@link parseFineDuration}, for
 * `--polling-frequency`.
 *
 * @param flag the flag name as written on the command line, e.g. `--polling-frequency`.
 * @throws {UsageError} for a bare integer, or any input parseFineDuration rejects.
 */
export function parseFineDurationFlag(flag: string, value: string): number {
  return parseDurationFlagWith(flag, value, parseFineDuration);
}

function parseDurationFlagWith(
  flag: string,
  value: string,
  parse: (input: string) => number,
): number {
  const trimmed = value.trim();
  // A bare 0 falls through to the parser's zero refusal: "0s" is no remedy.
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
    // A string op, not Number(), so a value past 2^53 is not rounded in the
    // hint; leading zeros go, since 007s parses as 7s.
    const canonical = trimmed.replace(/^0+(?=\d)/, "");
    throw new UsageError(
      `${flag} no longer accepts a bare number of seconds; durations need a ` +
        `unit suffix (s, m, h, or d) -- use ${canonical}s for ${canonical} ` +
        `seconds.`,
    );
  }
  try {
    return parse(trimmed);
  } catch (err) {
    if (err instanceof UsageError)
      throw new UsageError(`${flag}: ${err.message}`);
    throw err;
  }
}
