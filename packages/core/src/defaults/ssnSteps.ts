import type { StandardizationStep } from "../config/standardizationSchema.js";

// The default `ssn` and `ssn4` pipelines and the default `ssn` shared-value
// limit, in a module of their own because field resolution (standardization.ts)
// derives `ssn4` from an `ssn` column with SSN4_FROM_SSN_STEPS and screens that
// column, and builtInStandardization.ts imports standardization.ts.

// The ASCII hyphen and the Unicode dashes spreadsheet or word-processor
// autocorrect substitutes for it (U+2010 to U+2014 and the minus sign U+2212),
// as the body of a regex character class. A period is not among them.
const DASHES = "\\-\\x{2010}-\\x{2014}\\x{2212}";

// Each value of one digit repeated `length` times, for the placeholder lists.
// All ten are listed even where a structural screen already drops one, so a
// pipeline authored with the list but without that screen still drops it.
function repeatedDigits(length: number): string[] {
  return Array.from({ length: 10 }, (_, digit) => String(digit).repeat(length));
}

// The first nine digits of each rotation of 0123456789, then each of those
// reversed: 012345678 to 901234567, then 876543210 to 765432109.
function sequentialDigitRuns(): string[] {
  const digits = "0123456789";
  const forward = Array.from({ length: 10 }, (_, start) =>
    (digits.slice(start) + digits.slice(0, start)).slice(0, 9),
  );
  return [...forward, ...forward.map((run) => [...run].reverse().join(""))];
}

// The values the default `ssn` pipeline drops as placeholders, which the
// `ssn4` derived from an `ssn` column drops too.
const SSN_PLACEHOLDERS: readonly string[] = [
  ...repeatedDigits(9),
  ...sequentialDigitRuns(),
  "078051120",
  "219099999",
  "111223333",
];

// Seven or more 9s in a row, or seven or more 0s in a row, is filler such as
// 129-99-9999 or 100-00-0001. A zero run is exempt when the area number is 000:
// it is the padding of a masked value such as ***-**-0012, whose last four the
// derived `ssn4` keeps.
const SSN_FILLER_STEPS: StandardizationStep[] = [
  {
    function: "replace_regex",
    params: {
      pattern: "^(?:\\d*9{7}|0{0,2}[1-9]\\d*0{7})\\d*$",
      replacement: "",
    },
  },
  { function: "null_if", params: { value: "" } },
];

/**
 * The most distinct people one cleaned SSN may belong to in a party's own file
 * under the default cleaning (docs/spec/DEFAULT_STANDARDIZATION.md,
 * Shared-value screens).
 */
export const SSN_MAX_PEOPLE_PER_VALUE = 1;

/** The default `ssn` pipeline. */
export const SSN_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  // Only ASCII digits, spaces and dashes, checked before any character is
  // removed: deleting a mask (***-**-8924), a non-ASCII digit or a decimal
  // point would leave other digits that pad to a different SSN. A masked
  // value's last four still reach ssn4 through that field's own pipeline.
  { function: "filter_regex", params: { pattern: `^[0-9 ${DASHES}]*$` } },
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  // Drop a value that cleaned to empty (a blank or all-hyphen cell) here,
  // before pad_left can mask it: an empty string would otherwise pad to
  // "000000000" and be dropped only as a side effect of a later step. The
  // linkage layer does not drop "" together with the no-key sentinel, so the
  // blank-cell hazard must be prevented explicitly here -- and stays
  // prevented even if an operator edits the later steps for their own data.
  { function: "null_if", params: { value: "" } },
  // Zero-pad to 9 digits for SSNs stored without their leading zeros.
  { function: "pad_left", params: { length: 9 } },
  { function: "filter_regex", params: { pattern: "^\\d{9}$" } },
  // No SSN is issued with area number 000, so a value whose first three
  // digits are 000 after padding is a fragment (a last four, say) or a
  // zero-masked value such as 000-00-8924, not a full SSN.
  { function: "filter_regex", params: { pattern: "^0{0,2}[1-9]" } },
  // The SSA never issues area 666 or 900 to 999, group 00 or serial 0000.
  {
    function: "filter_regex",
    params: { pattern: "^(?:[0-578]|6[0-57-9]|66[0-57-9])" },
  },
  {
    function: "filter_regex",
    params: { pattern: "^\\d{3}(?:[1-9]\\d|\\d[1-9])" },
  },
  { function: "filter_regex", params: { pattern: "[1-9]\\d{0,3}$" } },
  { function: "null_if", params: { values: [...SSN_PLACEHOLDERS] } },
  ...SSN_FILLER_STEPS,
];

// The `ssn4` steps up to and including the empty-value drop.
const SSN4_DIGIT_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  // Keep a value of only ASCII digits, spaces and dashes, or one ending in
  // four ASCII digits (spaces and dashes aside), whose mask lies before its
  // last four (***-**-8924). Any other value is masked in its last four, by
  // ASCII or non-ASCII characters (078-05-XXXX): removing the mask would key
  // it on other digits of the SSN.
  {
    function: "filter_regex",
    params: {
      pattern: `^[0-9 ${DASHES}]*$|(?:[0-9][ ${DASHES}]*){4}$`,
    },
  },
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  // Drop a value that cleaned to empty before pad_left masks it as "0000"; see
  // SSN_STEPS for why this explicit blank-drop is needed.
  { function: "null_if", params: { value: "" } },
];

const SSN4_LAST_FOUR_STEPS: StandardizationStep[] = [
  // Zero-pad to 4 digits for SSN4 values stored without a leading zero.
  { function: "pad_left", params: { length: 4 } },
  { function: "extract_regex", params: { pattern: "(\\d{4})$" } },
  { function: "filter_regex", params: { pattern: "^\\d{4}$" } },
  { function: "null_if", params: { values: repeatedDigits(4) } },
];

/** The default `ssn4` pipeline. */
export const SSN4_STEPS: StandardizationStep[] = [
  ...SSN4_DIGIT_STEPS,
  ...SSN4_LAST_FOUR_STEPS,
];

/**
 * The default steps that derive `ssn4` from an `ssn` column:
 * {@link SSN4_STEPS} with the digits padded to nine and screened against the
 * `ssn` placeholders and filler runs. A value masked in its first five digits
 * pads to area 000, where the only placeholder is 000000000 and a run of zeros
 * is exempt, so its last four are kept.
 */
export const SSN4_FROM_SSN_STEPS: StandardizationStep[] = [
  ...SSN4_DIGIT_STEPS,
  { function: "pad_left", params: { length: 9 } },
  { function: "null_if", params: { values: [...SSN_PLACEHOLDERS] } },
  ...SSN_FILLER_STEPS,
  ...SSN4_LAST_FOUR_STEPS,
];
