import { UsageError } from "./errors.js";
import { isCalendarDateValid } from "./utils/calendarDate.js";
import type { GenerateFuzzyComparisons } from "./config/linkageTermsSchema.js";

/**
 * The longest standardized value the fuzzy expansion accepts. Expansion
 * allocates work growing with the square (deletions) or cube (transpositions)
 * of the value's length, the value is local row data nothing upstream bounds,
 * and the partner's terms decide whether to expand it. A longer value is
 * refused, not matched on its exact value alone. See
 * docs/spec/CHANNEL_SECURITY.md#unbounded-transform-parameter-rejection.
 */
export const MAX_FUZZY_EXPANSION_INPUT_LENGTH = 128;

/** The canonical date layout the date kinds expand, the `parse_date` default. */
const CANONICAL_DATE_LAYOUT = "YYYYMMDD";

const CANONICAL_DATE_PATTERN = /^[0-9]{8}$/;

// The refusals below interpolate neither the row value (local PII) nor the
// partner-authored element name.
function fuzzyValueTooLongRefusal(kind: GenerateFuzzyComparisons): UsageError {
  return new UsageError(
    `a linkage-key element declares "${kind}" fuzzy comparisons, but a row's ` +
      "standardized value is longer than the " +
      `${MAX_FUZZY_EXPANSION_INPUT_LENGTH}-character limit the expansion ` +
      "accepts: expanding it would allocate work that grows with at least the square " +
      "of the value's length, and matching the row on its exact value alone " +
      "would match on less than the terms declare. The exchange is refused " +
      "instead. Shorten the field with an element transform, or remove the " +
      "fuzzy comparison from the element.",
  );
}

function nonCanonicalDateRefusal(kind: GenerateFuzzyComparisons): UsageError {
  return new UsageError(
    `a linkage-key element declares "${kind}" fuzzy comparisons, but a row's ` +
      "standardized value is not a canonical " +
      `${CANONICAL_DATE_LAYOUT} date: its year, month, and day cannot be ` +
      "located, so the element would match on its exact value alone rather " +
      "than on the candidates the terms declare. The exchange is refused " +
      `instead. Add a "parse_date" element transform emitting ` +
      `${CANONICAL_DATE_LAYOUT}, or remove the fuzzy comparison from the ` +
      "element.",
  );
}

/**
 * Refuse a value the declared expansion cannot be applied to: the one place
 * both input conditions live, so `buildKeyStrings` screens an element's whole
 * pre-expansion list on exactly what the expansion refuses. See
 * docs/spec/CHANNEL_SECURITY.md#unbounded-transform-parameter-rejection.
 *
 * @throws {UsageError} if `value` is above
 * {@link MAX_FUZZY_EXPANSION_INPUT_LENGTH}, or if `kind` is
 * `adjacent_years` or `day_month_swaps` and `value` is not a canonical
 * `YYYYMMDD` date.
 */
export function assertFuzzyExpansionAccepts(
  value: string,
  kind: GenerateFuzzyComparisons,
): void {
  if (value.length > MAX_FUZZY_EXPANSION_INPUT_LENGTH)
    throw fuzzyValueTooLongRefusal(kind);
  switch (kind) {
    case "adjacent_years":
    case "day_month_swaps":
      if (!CANONICAL_DATE_PATTERN.test(value))
        throw nonCanonicalDateRefusal(kind);
      return;
    case "transpositions":
    case "edit_distances":
      return;
  }
}

/**
 * Every swap of two unequal code points at any two positions of `value`, a
 * full-variant enumeration, so one party expanding suffices
 * (docs/notes/one-sided-fuzzy-expansion.md). Code points, not UTF-16 units,
 * so a swap never splits a surrogate pair.
 */
export function transpositionCandidates(value: string): string[] {
  const points = Array.from(value);
  const candidates: string[] = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      if (points[i] === points[j]) continue;
      const swapped = [...points];
      swapped[i] = points[j];
      swapped[j] = points[i];
      candidates.push(swapped.join(""));
    }
  return candidates;
}

/**
 * Every single code point deletion of `value`, deduplicated. A deletion
 * neighbourhood, not a full-variant enumeration, so both parties expand
 * (docs/notes/one-sided-fuzzy-expansion.md).
 */
export function deletionCandidates(value: string): string[] {
  const points = Array.from(value);
  const candidates = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    candidates.add([...points.slice(0, i), ...points.slice(i + 1)].join(""));
  }
  return [...candidates];
}

/**
 * The calendar-valid dates one year either side of a canonical `YYYYMMDD`
 * value. An input that is not itself a valid date emits none, which keeps the
 * relation symmetric ("19990229" would otherwise expand to "20000229").
 *
 * @throws {UsageError} when `value` is not a canonical `YYYYMMDD` date.
 */
export function adjacentYearCandidates(value: string): string[] {
  assertFuzzyExpansionAccepts(value, "adjacent_years");
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  if (!isCalendarDateValid(year, month, day)) return [];
  const candidates: string[] = [];
  for (const shifted of [Number(year) - 1, Number(year) + 1]) {
    if (shifted < 0 || shifted > 9999) continue;
    const shiftedYear = String(shifted).padStart(4, "0");
    if (!isCalendarDateValid(shiftedYear, month, day)) continue;
    candidates.push(`${shiftedYear}${month}${day}`);
  }
  return candidates;
}

/**
 * The canonical `YYYYMMDD` value with day and month exchanged, when both
 * readings are valid dates and differ; a full-variant enumeration
 * (docs/notes/one-sided-fuzzy-expansion.md).
 * Requiring the input to be valid keeps the relation an involution.
 *
 * @throws {UsageError} when `value` is not a canonical `YYYYMMDD` date.
 */
export function dayMonthSwapCandidates(value: string): string[] {
  assertFuzzyExpansionAccepts(value, "day_month_swaps");
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const exchangedMonth = day;
  const exchangedDay = month;
  if (exchangedMonth === exchangedDay) return [];
  if (!isCalendarDateValid(year, month, day)) return [];
  if (!isCalendarDateValid(year, exchangedMonth, exchangedDay)) return [];
  return [`${year}${exchangedMonth}${exchangedDay}`];
}

/**
 * Whether only the resolved PSI receiver expands `kind`: true for the
 * full-variant kinds, false for the `edit_distances` deletion neighbourhood,
 * which both sides must expand. A local execution choice keyed on the
 * resolved role (`resolveRole`); it moves no term or wire byte. Pure, so both
 * parties classify a kind identically. See
 * docs/notes/one-sided-fuzzy-expansion.md.
 */
export function expandsOnReceiverOnly(kind: GenerateFuzzyComparisons): boolean {
  switch (kind) {
    case "transpositions":
    case "adjacent_years":
    case "day_month_swaps":
      return true;
    case "edit_distances":
      return false;
  }
}

/**
 * The most candidates `kind` can realize from one value, counting the value
 * itself: the factor a fuzzy element adds to its key's declared width, so it
 * must bound {@link expandFuzzyComparisons}'s result from above.
 * `valueWidthBound` (`elementValueWidthBound`) is clamped to
 * {@link MAX_FUZZY_EXPANSION_INPUT_LENGTH}, which also applies when it is
 * `undefined`. Pure, so both parties derive the same factor. See
 * docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare.
 */
export function fuzzyCandidateCeiling(
  kind: GenerateFuzzyComparisons,
  valueWidthBound?: number,
): number {
  const width = Math.min(
    valueWidthBound ?? MAX_FUZZY_EXPANSION_INPUT_LENGTH,
    MAX_FUZZY_EXPANSION_INPUT_LENGTH,
  );
  switch (kind) {
    case "adjacent_years":
      return 3;
    case "day_month_swaps":
      return 2;
    case "edit_distances":
      return width + 1;
    case "transpositions":
      return (width * (width - 1)) / 2 + 1;
  }
}

/**
 * The match candidates a `generateFuzzyComparisons` rule declares for one
 * standardized value: `value` first, then the kind's candidates, deduplicated
 * and in a stable order.
 *
 * @throws {UsageError} under the conditions {@link assertFuzzyExpansionAccepts}
 * names, rather than matching the row on its exact value alone.
 */
export function expandFuzzyComparisons(
  value: string,
  kind: GenerateFuzzyComparisons,
): string[] {
  assertFuzzyExpansionAccepts(value, kind);

  let candidates: string[];
  switch (kind) {
    case "transpositions":
      candidates = transpositionCandidates(value);
      break;
    case "edit_distances":
      candidates = deletionCandidates(value);
      break;
    case "adjacent_years":
      candidates = adjacentYearCandidates(value);
      break;
    case "day_month_swaps":
      candidates = dayMonthSwapCandidates(value);
      break;
  }

  return [...new Set([value, ...candidates])];
}
