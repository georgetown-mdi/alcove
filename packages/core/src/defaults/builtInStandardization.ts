import { cleanedTitles, resolveFieldColumns } from "../standardization.js";

import type {
  Standardization,
  StandardizationStep,
} from "../config/standardizationSchema.js";
import type { ColumnMetadata } from "../config/metadata.js";
import type { LinkageTerms } from "../config/linkageTermsSchema.js";
import { SSN4_STEPS, SSN_MAX_PEOPLE_PER_VALUE, SSN_STEPS } from "./ssnSteps.js";

// --- Step arrays -------------------------------------------------------------

// Shared pipeline for first and last names, before their screens. Produces
// uppercase letters and spaces only, with affixes (Dr., Jr., etc.) removed,
// matching the `allowedCharacters: "A-Z "` constraint on the default linkage
// fields.
const NAME_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  // The three steps before remove_non_ascii turn non-ASCII characters into
  // ASCII ones it would otherwise delete: Unicode whitespace becomes a space,
  // an accented or stroked letter its base letter (e-acute -> e, L-stroke ->
  // L, sharp s -> ss), and a typographic apostrophe or dash a word break, so
  // O'Brien -> O BRIEN and Mary-Jane -> MARY JANE in either spelling.
  { function: "squash_spaces" },
  { function: "remove_accents" },
  { function: "replace_separators_with_spaces" },
  { function: "remove_non_ascii" },
  { function: "to_upper_case" },
  { function: "remove_affixes" },
  { function: "remove_punctuation" },
  { function: "squash_spaces" },
  { function: "trim_whitespace" },
  // Null out values that are empty after cleaning.
  { function: "filter_regex", params: { pattern: "[A-Z]" } },
  // remove_affixes keeps a value that is only a title, so drop every title
  // word, none of which is a name alone, as the SSN pipelines drop their
  // placeholders.
  { function: "null_if", params: { values: [...cleanedTitles] } },
];

const NAME_PLACEHOLDER_STEP: StandardizationStep = {
  function: "null_if",
  params: {
    values: [
      "UNKNOWN",
      "UNK",
      "DOE",
      "BABY",
      "BOY",
      "GIRL",
      "TWIN",
      "MALE",
      "FEMALE",
      "TRAUMA",
      "REFUSED",
      "ANONYMOUS",
      "NONE",
      "TEST",
    ],
  },
};

// A one-letter first name is kept: the built-in keys beside a full SSN match
// on the first initial alone.
const FIRST_NAME_STEPS: StandardizationStep[] = [
  ...NAME_STEPS,
  NAME_PLACEHOLDER_STEP,
];

const LAST_NAME_STEPS: StandardizationStep[] = [
  ...NAME_STEPS,
  // Every one-character value is a letter here, so this drops an initial.
  { function: "filter_regex", params: { pattern: "^.{2,}$" } },
  NAME_PLACEHOLDER_STEP,
];

/** The `date_of_birth` input format used when none is supplied or inferred. */
export const DEFAULT_DATE_INPUT_FORMAT = "MM/DD/YYYY";

/**
 * The parsing steps of the default `date_of_birth` pipeline for one input
 * format. Date-format inference ({@link inferDateFormat}) tests each candidate
 * with these steps alone, so the format inferred for a column does not depend
 * on the screens that follow.
 */
export function dateOfBirthParseSteps(
  inputFormat: string,
): StandardizationStep[] {
  return [
    { function: "trim_whitespace" },
    { function: "remove_non_ascii" },
    {
      function: "parse_date",
      params: { inputFormat, outputFormat: "YYYYMMDD" },
    },
  ];
}

// Drop a year before 1900. A future date is kept: cleaning reads no clock, so
// two parties could not agree on which day is today.
const DATE_OF_BIRTH_SCREEN_STEPS: StandardizationStep[] = [
  { function: "filter_regex", params: { pattern: "^(?:19|[2-9])" } },
  { function: "null_if", params: { values: ["19000101", "19010101"] } },
];

/** The default `date_of_birth` pipeline for one input format: parse, then screen. */
export function dateOfBirthSteps(inputFormat: string): StandardizationStep[] {
  return [...dateOfBirthParseSteps(inputFormat), ...DATE_OF_BIRTH_SCREEN_STEPS];
}

// US 10-digit phone (digits only). A leading US country code (+1 or 1) on an
// 11-digit number is stripped before validation.
const PHONE_NUMBER_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "remove_non_ascii" },
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  {
    function: "replace_regex",
    params: { pattern: "^1(\\d{10})$", replacement: "$1" },
  },
  { function: "filter_regex", params: { pattern: "^\\d{10}$" } },
  // A run of seven or more 9s or 0s is filler such as 999-999-9999.
  {
    function: "replace_regex",
    params: { pattern: "^\\d*(?:9{7}|0{7})\\d*$", replacement: "" },
  },
  { function: "null_if", params: { value: "" } },
];

const EMAIL_ADDRESS_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "remove_non_ascii" },
  { function: "to_lower_case" },
  {
    function: "filter_regex",
    params: { pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
  },
];

// The house number an address value starts with: its leading run of digits,
// leading zeros removed, so `0042 Elm` and `42 Elm` agree. A unit letter, a
// range's second number or a fraction after it is not kept, and a value that
// starts with no digit, or whose number is all zeros, is dropped.
const STREET_NUMBER_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "extract_regex", params: { pattern: "^0*([1-9][0-9]*)" } },
];

// US 5-digit ZIP. Strip every non-digit (subsuming a leading trim and
// non-ASCII removal), keep the first 5 digits so a ZIP+4 collapses to its
// 5-digit prefix, then zero-pad a short value to 5 (a New England ZIP
// stored without its leading zero). The explicit null_if drops a value
// that cleaned to empty before pad_left can mask it as "00000"; substring
// already nulls an empty slice, so this mirrors the SSN pipeline's
// null-before-pad rather than adding new coverage. A value starting 000
// after padding is a fragment or a filler such as 00000, and 99999 and 88888
// are unknown and foreign-address codes; "00000" is listed too so a
// pipeline without the 000 screen still drops it.
const ZIP_CODE_STEPS: StandardizationStep[] = [
  { function: "replace_regex", params: { pattern: "[^0-9]", replacement: "" } },
  { function: "substring", params: { start: 1, length: 5 } },
  { function: "null_if", params: { value: "" } },
  { function: "pad_left", params: { length: 5 } },
  { function: "filter_regex", params: { pattern: "^0{0,2}[1-9]" } },
  { function: "null_if", params: { values: ["00000", "99999", "88888"] } },
];

// A US state, DC or inhabited territory as its two-letter postal code, from
// the code or the full name in any case and punctuation.
const STATE_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "squash_spaces" },
  { function: "remove_non_ascii" },
  { function: "to_upper_case" },
  { function: "remove_punctuation" },
  { function: "squash_spaces" },
  { function: "trim_whitespace" },
  { function: "state_code" },
];

// An uppercase county name with the word COUNTY, a leading "COUNTY OF", and
// punctuation removed. A hyphen or typographic dash becomes a space first, so
// MIAMI-DADE and MIAMI DADE agree.
const COUNTY_STEPS: StandardizationStep[] = [
  { function: "trim_whitespace" },
  { function: "squash_spaces" },
  { function: "remove_accents" },
  {
    function: "replace_regex",
    params: { pattern: "[\\-\\x{2010}-\\x{2015}\\x{2212}]", replacement: " " },
  },
  { function: "remove_non_ascii" },
  { function: "to_upper_case" },
  { function: "remove_punctuation" },
  {
    function: "replace_regex",
    params: { pattern: "^COUNTY OF |\\bCOUNTY\\b", replacement: "" },
  },
  { function: "squash_spaces" },
  { function: "trim_whitespace" },
  { function: "filter_regex", params: { pattern: "[A-Z0-9]" } },
];

// The most distinct people one value may belong to in a party's own file. A
// household shares a phone or an email, so five keeps most of them, while an
// organization's number on dozens of clients is dropped.
const MAX_PEOPLE_PER_VALUE: Readonly<Partial<Record<string, number>>> = {
  ssn: SSN_MAX_PEOPLE_PER_VALUE,
  phone_number: 5,
  email_address: 5,
};

// --- Default standardization -------------------------------------------------

interface DefaultStandardizationOptions {
  /**
   * Input date format for the `date_of_birth` pipeline, passed as `inputFormat`
   * to `parse_date`. Defaults to `"MM/DD/YYYY"` when omitted. Pair with
   * {@link inferDateFormat} to detect the format automatically.
   */
  dateInputFormat?: string;
}

function stepsForType(
  semanticType: string,
  opts: DefaultStandardizationOptions,
): StandardizationStep[] | undefined {
  switch (semanticType) {
    case "ssn":
      return SSN_STEPS;
    case "ssn4":
      return SSN4_STEPS;
    case "first_name":
      return FIRST_NAME_STEPS;
    case "last_name":
      return LAST_NAME_STEPS;
    case "date_of_birth":
      return dateOfBirthSteps(
        opts.dateInputFormat ?? DEFAULT_DATE_INPUT_FORMAT,
      );
    case "phone_number":
      return PHONE_NUMBER_STEPS;
    case "email_address":
      return EMAIL_ADDRESS_STEPS;
    case "street_number":
      return STREET_NUMBER_STEPS;
    case "zip_code":
      return ZIP_CODE_STEPS;
    case "state":
      return STATE_STEPS;
    case "county":
      return COUNTY_STEPS;
    default:
      return undefined;
  }
}

/**
 * A copy of the default pipeline for a column of `semanticType`, or `undefined`
 * for a type with none.
 */
export function defaultStepsForType(
  semanticType: string,
  options: DefaultStandardizationOptions = {},
): StandardizationStep[] | undefined {
  const steps = stepsForType(semanticType, options);
  return steps === undefined ? undefined : structuredClone(steps);
}

/**
 * Generates a default {@link Standardization} for the linkage fields in
 * `terms`, sourcing input column names from `metadata`.
 *
 * For each linkage field whose semantic type has a known default pipeline,
 * a transformation maps the first `role: linkage` metadata column of that
 * type to the field name. Semantic types without defaults (`identifier`,
 * `other`) are skipped, as are linkage fields with no `role: linkage`
 * column of their type, except an `ssn4` field, which is derived from the
 * first `role: linkage` `ssn` column when the input has no `ssn4` one.
 *
 * An `ssn`, `phone_number` or `email_address` field's transformation also
 * states `maxPeoplePerValue`, the shared-value screen over the whole file.
 *
 * The returned value can be passed directly to
 * {@link buildStandardizedDataset} and is appropriate when the user has
 * not provided explicit standardization configuration.
 *
 * The `date_of_birth` pipeline uses `options.dateInputFormat` when
 * provided, otherwise defaults to `"MM/DD/YYYY"`; pair with
 * {@link inferDateFormat} to detect the format automatically.
 */
export function getDefaultStandardization(
  metadata: ColumnMetadata[],
  terms: LinkageTerms,
  options: DefaultStandardizationOptions = {},
): Standardization {
  // Derive each field's input column from the same resolution primitive the
  // builder and satisfiability checker use, so the default-term mapping
  // cannot diverge from how the exchange actually binds columns. With no
  // explicit standardization this is the type fallback (first `role: linkage`
  // metadata column of the field's type) or a derived binding, which states
  // its own steps; a semantic type with no default pipeline still falls
  // through to the builder's own identity type-fallback at exchange time.
  const resolution = resolveFieldColumns(terms, undefined, metadata);
  const result: Standardization = [];

  for (const field of terms.linkageFields) {
    const resolved = resolution.get(field.name);
    const column = resolved?.column;
    if (column === undefined) continue;
    const steps =
      resolved?.transform?.steps ?? stepsForType(field.type, options);
    if (steps === undefined) continue;
    const maxPeoplePerValue = MAX_PEOPLE_PER_VALUE[field.type];
    // The step arrays are module constants shared across fields and calls.
    result.push({
      output: field.name,
      input: column,
      steps: structuredClone(steps),
      ...(maxPeoplePerValue === undefined ? {} : { maxPeoplePerValue }),
    });
  }

  return result;
}
