/**
 * Whether `year`-`month`-`day` names a real calendar date.
 *
 * The ISO-string `Date` constructor rolls an out-of-range day or month over
 * (Feb 29 in a non-leap year becomes Mar 1) instead of returning an Invalid
 * Date, so `isNaN` alone would accept it; the parsed UTC components are
 * round-tripped against the input to catch the rollover.
 *
 * Shared by the `parse_date` standardization step, which rejects a row whose
 * components do not form a date, and by the date fuzzy expansions, which drop
 * an input or candidate that is not a real date: a shifted year landing on Feb
 * 29 of a non-leap year for `adjacent_years`, a day above 12 becoming a month
 * for `day_month_swaps`, and an input that is not itself a real date for
 * `adjacent_days`.
 *
 * Each component is the plain decimal string the caller already holds; `month`
 * and `day` are expected zero-padded to two digits, `year` to four.
 */
export function isCalendarDateValid(
  year: string,
  month: string,
  day: string,
): boolean {
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    !isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The canonical `YYYYMMDD` date `offsetDays` days from `year`-`month`-`day`,
 * or `undefined` when the input is not a real calendar date or the result
 * falls outside the four-digit years 0000 to 9999. Counted in UTC, where every
 * day is the same length.
 */
export function calendarDateDaysAway(
  year: string,
  month: string,
  day: string,
  offsetDays: number,
): string | undefined {
  if (!isCalendarDateValid(year, month, day)) return undefined;
  const origin = Date.parse(`${year}-${month}-${day}T00:00:00Z`);
  const shifted = new Date(origin + offsetDays * MILLISECONDS_PER_DAY);
  const shiftedYear = shifted.getUTCFullYear();
  if (shiftedYear < 0 || shiftedYear > 9999) return undefined;
  return (
    String(shiftedYear).padStart(4, "0") +
    String(shifted.getUTCMonth() + 1).padStart(2, "0") +
    String(shifted.getUTCDate()).padStart(2, "0")
  );
}
