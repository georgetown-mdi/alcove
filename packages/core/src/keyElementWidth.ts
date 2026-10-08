/**
 * The width a linkage key element's transform chain bounds its standardized
 * value to, read from the agreed terms alone. A module of its own so both
 * `fuzzyComparisons.ts` and `standardization.ts` can import it.
 */

import type { TransformStep } from "./config/linkageTermsSchema.js";

/** The exact length of a `soundex` code, which `phonetic` emits or drops. */
export const SOUNDEX_CODE_LENGTH = 4;

/** The layout `parse_date` emits when it declares no string `outputFormat`. */
export const DEFAULT_DATE_OUTPUT_FORMAT = "YYYYMMDD";

// Bounded only by a positive integer `length` with a non-zero integer
// `start`, mirroring `substringWindow`; a negative length grows with the value.
function substringWidthBound(
  params: Record<string, unknown>,
): number | undefined {
  const { start, length } = params;
  if (typeof start !== "number" || !Number.isInteger(start) || start === 0)
    return undefined;
  if (typeof length !== "number" || !Number.isInteger(length) || length <= 0)
    return undefined;
  return length;
}

// Raises a width the chain already has and fixes none by itself, since a
// longer value passes through.
function padLeftWidthBound(
  params: Record<string, unknown>,
  carried: number | undefined,
): number | undefined {
  const { length } = params;
  if (typeof length !== "number" || !Number.isInteger(length) || length <= 0)
    return undefined;
  if (carried === undefined) return undefined;
  return Math.max(carried, length);
}

// Only `soundex` is implemented; any other algorithm derives no width.
function phoneticWidthBound(
  params: Record<string, unknown>,
): number | undefined {
  const { algorithm } = params;
  if (algorithm !== undefined && algorithm !== "soundex") return undefined;
  return SOUNDEX_CODE_LENGTH;
}

// Every format token renders at its own width, so the output is as wide as
// the format, the default layout when `outputFormat` is not a string.
function parseDateWidthBound(
  params: Record<string, unknown>,
): number | undefined {
  const { outputFormat } = params;
  return typeof outputFormat === "string"
    ? outputFormat.length
    : DEFAULT_DATE_OUTPUT_FORMAT.length;
}

/**
 * The most characters an element's standardized value can contain after its
 * `transform` chain, or `undefined` when the terms bound no width. Walked in
 * order: `substring`, `phonetic` and `parse_date` replace the width,
 * `pad_left` raises it, `null_if` and `filter_regex` pass it through, and
 * every other step clears it, since clearing is always safe and too small a
 * width refuses a valid row. A derived width is at least 1. See
 * docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare.
 */
export function elementValueWidthBound(
  steps: readonly TransformStep[] | undefined,
): number | undefined {
  let bound: number | undefined;
  for (const step of steps ?? []) {
    const params = step.params ?? {};
    switch (step.function) {
      case "substring":
        bound = substringWidthBound(params);
        break;
      case "pad_left":
        bound = padLeftWidthBound(params, bound);
        break;
      case "phonetic":
        bound = phoneticWidthBound(params);
        break;
      case "parse_date":
        bound = parseDateWidthBound(params);
        break;
      case "null_if":
      case "filter_regex":
        break;
      default:
        bound = undefined;
        break;
    }
  }
  return bound === undefined ? undefined : Math.max(1, bound);
}
