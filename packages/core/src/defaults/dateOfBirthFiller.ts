// The filler date of birth the default cleaning keeps and marks, in a module of
// its own because the key read (standardization.ts) applies the mark and
// builtInStandardization.ts imports standardization.ts.

// A `YYYYMMDD` date whose month and day are both 01.
const FILLER_DATE_OF_BIRTH = /^\d{4}0101$/;

/**
 * Whether a cleaned date of birth is a filler: a value in the default cleaning's
 * `YYYYMMDD` form whose month and day are both 01, the date a system writes for
 * an unknown month and day. The value is kept, but no key element reads it and
 * a missing-field condition counts it as missing
 * (docs/spec/DEFAULT_STANDARDIZATION.md#filler-dates).
 */
export function isFillerDateOfBirth(value: string): boolean {
  return FILLER_DATE_OF_BIRTH.test(value);
}
