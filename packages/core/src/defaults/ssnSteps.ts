import type { StandardizationStep } from "../config/standardizationSchema.js";

// The default `ssn` and `ssn4` pipelines, in a module of their own because
// field resolution (standardization.ts) derives `ssn4` from an `ssn` column
// with SSN4_STEPS, and builtInStandardization.ts imports standardization.ts.

// Explicitly allow invalid SSNs for now, area number 000 excepted.
/** The default `ssn` pipeline. */
export const SSN_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "remove_non_ascii" },
  // A masked value (***-**-8924, XXX-XX-8924) is not a full SSN; its last
  // four still reach ssn4 through that field's own pipeline.
  { function: "filter_regex", params: { pattern: "^[^*Xx#]*$" } },
  { function: "remove_dashes" },
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  // Drop a value that cleaned to empty (a blank or all-non-digit cell) here,
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
  {
    function: "null_if",
    params: { values: ["000000000", "111111111", "123456789"] },
  },
];

/** The default `ssn4` pipeline, which also derives `ssn4` from an `ssn` column. */
export const SSN4_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "remove_non_ascii" },
  { function: "remove_dashes" },
  { function: "replace_regex", params: { pattern: " ", replacement: "" } },
  // A value whose last four characters are not all digits is masked there
  // (078-05-XXXX); taking the last four digits wherever they sit would key
  // it on the group number. A 1-3 digit value is a last four that lost its
  // leading zeros.
  { function: "filter_regex", params: { pattern: "^\\d{1,3}$|\\d{4}$" } },
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  // Drop a value that cleaned to empty before pad_left masks it as "0000"; see
  // SSN_STEPS for why this explicit blank-drop is needed.
  { function: "null_if", params: { value: "" } },
  // Zero-pad to 4 digits for SSN4 values stored without a leading zero.
  { function: "pad_left", params: { length: 4 } },
  { function: "extract_regex", params: { pattern: "(\\d{4})$" } },
  { function: "filter_regex", params: { pattern: "^\\d{4}$" } },
  { function: "null_if", params: { values: ["0000"] } },
];
