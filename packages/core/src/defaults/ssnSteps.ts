import type { StandardizationStep } from "../config/standardizationSchema.js";

// The default `ssn` and `ssn4` pipelines, in a module of their own because
// field resolution (standardization.ts) derives `ssn4` from an `ssn` column
// with SSN4_STEPS, and builtInStandardization.ts imports standardization.ts.

// The ASCII hyphen and the Unicode dashes spreadsheet or word-processor
// autocorrect substitutes for it (U+2010 to U+2014 and the minus sign U+2212),
// as the body of a regex character class. A period is not among them.
const DASHES = "\\-\\x{2010}-\\x{2014}\\x{2212}";

// Each value of one digit repeated `length` times, for the placeholder lists.
// All ten are listed even where a structural screen already drops one, so an
// operator who edits that screen still drops the value.
function repeatedDigits(length: number): string[] {
  return Array.from({ length: 10 }, (_, digit) => String(digit).repeat(length));
}

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
  {
    function: "null_if",
    params: { values: [...repeatedDigits(9), "123456789"] },
  },
];

/** The default `ssn4` pipeline, which also derives `ssn4` from an `ssn` column. */
export const SSN4_STEPS: StandardizationStep[] = [
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
  // Zero-pad to 4 digits for SSN4 values stored without a leading zero.
  { function: "pad_left", params: { length: 4 } },
  { function: "extract_regex", params: { pattern: "(\\d{4})$" } },
  { function: "filter_regex", params: { pattern: "^\\d{4}$" } },
  { function: "null_if", params: { values: repeatedDigits(4) } },
];
