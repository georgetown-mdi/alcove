/**
 * Format a count with grouped digits under an EXPLICIT locale, so the grouping
 * separator is the same ASCII bytes on every host and in every browser: the
 * CLI's console sentinel fails a line holding a byte outside printable ASCII,
 * which a locale-default separator (a non-breaking space in several) would put
 * there.
 *
 * The one formatter for every figure an operator-facing sentence states, so
 * no two of them group digits differently. A non-finite number is written as
 * `String` writes it, since the formatter would write infinity as a non-ASCII
 * symbol. Rounds a fraction to at most three places; a caller counting whole
 * items truncates first.
 */
export function formatCount(count: number | bigint): string {
  if (typeof count === "number" && !Number.isFinite(count))
    return String(count);
  return new Intl.NumberFormat("en-US").format(count);
}
