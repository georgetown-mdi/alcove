import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";
import { MAX_LINKAGE_ENTRIES } from "./linkageTermsBounds.js";
import { declaredWidthRefusal } from "../fanOutFunctions.js";
import { AlgorithmSchema } from "../types.js";
import type { Algorithm } from "../types.js";
import { camelizeKeys, MAX_NESTING_DEPTH } from "../utils/camelizeKeys.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import { droppedSettingIssues } from "./unreadKeys.js";
import { boundedArray } from "../utils/boundedArray.js";
import { patternConformsToDialect } from "../utils/linearRegex.js";
import {
  findTransformRegexRefusal,
  regexStepPatternParam,
  transformPatternSizeMessage,
} from "./transformRegexDialect.js";
import type { TransformRegexRefusal } from "./transformRegexDialect.js";
import {
  transformParamAbsenceRefusals,
  transformParamTypeRefusals,
} from "./transformParamTypes.js";
import type { TransformParamRefusalOptions } from "./transformParamTypes.js";
import { transformParamDisplayRefusals } from "./transformParamDisplay.js";
import { exceedsOwnKeyCount } from "../utils/objectKeyCount.js";
import { loneSurrogateIndex } from "../utils/wellFormedString.js";
import { BIDI_CONTROL_PATTERN } from "../utils/nameControls.js";
import { holdsPrivateKeyMaterial } from "../utils/sanitizeErrorForDisplay.js";
import {
  COUNT_ONLY_SHAPE_REFUSALS,
  countOnlyShapeViolation,
  swapPairFuzzyComparisonsDiffer,
  swapPairTransformsDiffer,
  termsCandidateSetRefusal,
} from "../linkageTermsPolicy.js";

// --- Untrusted-input bounds --------------------------------------------------

// These terms arrive from a partner, in an invitation token and off the
// exchange wire. Every partner-controlled free-text string has a length ceiling
// in `maxCodeUnits` code units, and every partner-controlled collection a count
// bound applied before per-element validation
// (docs/spec/CHANNEL_SECURITY.md#application-layer-parsed-input-bounds).

/**
 * Upper bound on a short identifier-like string: every name-class field
 * ({@link NAME_SHAPE_PATTERN}), the `version` string, and a name-constraint
 * `allowedCharacters` class. Also used by the operator-local metadata column
 * `name` (config/metadata.ts).
 */
export const MAX_NAME_LENGTH = 256;

/**
 * Upper bound on a free-text field: a party `identity`, a legal-agreement
 * `purpose`, a payload column `description`, or a constraint `exclude` value.
 */
export const MAX_TEXT_LENGTH = 1024;

/**
 * The control characters refused in every {@link MAX_TEXT_LENGTH}-bounded
 * free-text field: C0 (NUL, tab, LF and CR included), DEL and C1. Enforced at
 * parse, so every reader of a live document inherits it; a reader of an
 * already-recorded value relies on display escaping instead.
 *
 * The web console's `--identity` label applies the same ranges
 * (`IDENTITY_CONTROL_CHAR_PATTERN`, held equal by identityLabelParity.test.ts),
 * so a label bound into a certificate is one a terms document can state
 * ({@link reasonTermsCannotStateIdentity}).
 */
export const TEXT_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Shared refusal message for a free-text control character. A fixed literal
 * naming no submitted value: the issue `path` locates the field and is escaped
 * at the display sink.
 */
export const TEXT_CONTROL_CHAR_MESSAGE =
  "a linkage terms free-text value must not contain control characters";

/**
 * The second class refused by the three free-text fields a record stores
 * verbatim (`identity`, `purpose`, a payload `description`): the nine
 * bidirectional characters `BIDI_CONTROL_PATTERN` names. A constraint `exclude`
 * value is a data value that reaches no record, so it is outside the rule
 * (docs/spec/CHANNEL_SECURITY.md#linkage-terms-name-class-character-rule). A
 * fixed literal, as {@link TEXT_CONTROL_CHAR_MESSAGE} is.
 */
export const TEXT_DIRECTION_MESSAGE =
  "a linkage terms free-text value must not contain a text-direction character";

/**
 * Refusal message for a party `identity` the private-key redaction would
 * replace ({@link holdsPrivateKeyMaterial}): a redaction marker on the line
 * naming the partner would look like one Alcove placed. A fixed literal, as
 * {@link TEXT_CONTROL_CHAR_MESSAGE} is.
 */
export const PRIVATE_KEY_IDENTITY_MESSAGE =
  "a linkage terms identity must not contain private key material";

/**
 * Why no terms document may state `identity` as a party name, as a clause, or
 * undefined when one may. The one answer the CLI's certificate-divergence
 * warning and core's `assertLocalCertificateAuthorizesAgreedIdentity` read:
 * where there is a reason, a config edit cannot reconcile the label and a
 * re-key is the remedy.
 *
 * Asks every `identity` rule but the non-empty floor, which the certificate
 * schema also applies. The clause names the class, never the label.
 */
export function reasonTermsCannotStateIdentity(
  identity: string,
): string | undefined {
  if (
    TEXT_CONTROL_CHAR_PATTERN.test(identity) ||
    BIDI_CONTROL_PATTERN.test(identity)
  )
    return "it holds a control or text-direction character";
  if (holdsPrivateKeyMaterial(identity)) return "it holds private key material";
  if (loneSurrogateIndex(identity) >= 0)
    return "it holds an unpaired UTF-16 surrogate";
  if (identity.length > MAX_TEXT_LENGTH)
    return `it is longer than ${MAX_TEXT_LENGTH} characters`;
  return undefined;
}

/**
 * The shape every name-class value must match beyond its
 * {@link MAX_NAME_LENGTH} cap: no {@link TEXT_CONTROL_CHAR_PATTERN} character
 * and none of the nine `BIDI_CONTROL_PATTERN` characters. Applied at each
 * field, a `params` record key included and its value not
 * (docs/spec/CHANNEL_SECURITY.md#linkage-terms-name-class-character-rule).
 *
 * One literal rather than a composition. nameShapeParity.test.ts sweeps every
 * BMP code point to keep it equal to the union and to the class the CSV header
 * read strips (`NAME_CONTROL_CHAR_PATTERN`).
 */
export const NAME_SHAPE_PATTERN =
  /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/u;

/**
 * Shared refusal message for a name-class shape rejection. A fixed literal, as
 * {@link TEXT_CONTROL_CHAR_MESSAGE} is.
 */
export const NAME_SHAPE_MESSAGE =
  "a linkage terms name must not contain a control or text-direction character";

/**
 * Shared refusal message for a terms string or object key that is not
 * well-formed UTF-16. A fixed literal, as {@link TEXT_CONTROL_CHAR_MESSAGE} is.
 */
export const LONE_SURROGATE_MESSAGE =
  "a linkage terms text value must not contain an unpaired UTF-16 surrogate";

/**
 * Shared refusal message for a terms document nesting deeper than
 * {@link MAX_NESTING_DEPTH}. A fixed literal.
 */
export const NESTING_DEPTH_MESSAGE = `a linkage terms value must not nest deeper than ${MAX_NESTING_DEPTH} levels`;

// Declared in linkageTermsBounds.js to avoid an evaluation cycle with the
// fan-out derivation, and re-exported here for consumers.
export { MAX_LINKAGE_ENTRIES };

/**
 * Upper bound on the number of entries in a transform step's `params` record,
 * checked by key count before per-key validation, so an over-count record
 * yields one issue. It also short-circuits the camelize pre-pass.
 */
export const MAX_PARAMS_ENTRIES = 256;

/**
 * Upper bound on `pad_left`'s numeric `length`, which drives a per-row
 * `padStart` allocation
 * (docs/spec/CHANNEL_SECURITY.md#unbounded-transform-parameter-rejection).
 */
export const MAX_PAD_LEFT_LENGTH = 256;

/**
 * Upper bound on `parse_date`'s `inputFormat` and `outputFormat`, which drive
 * a per-row regex build and allocation
 * (docs/spec/CHANNEL_SECURITY.md#unbounded-transform-parameter-rejection).
 */
export const MAX_DATE_FORMAT_LENGTH = 256;

/**
 * Upper bound on a raw partner-controlled regex: the `pattern` of
 * `replace_regex`, `extract_regex` and `filter_regex`, and `split_on`'s
 * `delimiter`. A compile-cost ceiling, checked per step and by the dialect gate
 * (docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect).
 */
export const MAX_TRANSFORM_PATTERN_LENGTH = 1000;

/**
 * Upper bound on every string value of a `transform.params` record. Bounds what
 * the partner may write; {@link MAX_TRANSFORMED_VALUE_LENGTH} bounds what a row
 * derives (docs/spec/CHANNEL_SECURITY.md#unbounded-transform-parameter-rejection).
 */
export const MAX_TRANSFORM_PARAM_LENGTH = 1000;

/**
 * Upper bound on the entry count of every list value of a `transform.params`
 * record, equal to {@link MAX_EXCLUDE_ENTRIES} since `null_if`'s `values` is a
 * denylist (docs/spec/CHANNEL_SECURITY.md#application-layer-parsed-input-bounds).
 */
export const MAX_TRANSFORM_PARAM_ENTRIES = 4096;

/**
 * Upper bound on the values in a constraint `exclude` denylist, which can
 * legitimately contain hundreds. Checked before per-element validation.
 */
export const MAX_EXCLUDE_ENTRIES = 4096;

/**
 * Upper bound on the steps in a key element's `transform` pipeline; it refuses
 * an array padded to overflow Zod's call stack.
 */
export const MAX_TRANSFORM_STEPS = 256;

/**
 * Upper bound on the elements in a linkage key; it refuses an array padded to
 * overflow Zod's call stack.
 */
export const MAX_KEY_ELEMENTS = 256;

/** Upper bound on the columns in a payload `send` or `receive` list. */
export const MAX_PAYLOAD_ENTRIES = 4096;

/**
 * One free-text value, refusing {@link TEXT_CONTROL_CHAR_PATTERN} on the
 * caller's string schema. The scan runs even past a failed length check, which
 * costs one linear pass.
 */
const freeTextValue = (schema: z.ZodString) =>
  schema.refine((value) => !TEXT_CONTROL_CHAR_PATTERN.test(value), {
    message: TEXT_CONTROL_CHAR_MESSAGE,
  });

/**
 * One free-text value a record stores verbatim, refusing control characters and
 * then {@link TEXT_DIRECTION_MESSAGE}'s class, as two checks so a refusal names
 * the class.
 */
const recordedFreeTextValue = (schema: z.ZodString) =>
  freeTextValue(schema).refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
    message: TEXT_DIRECTION_MESSAGE,
  });

/** One name-class value: the caller's string schema plus {@link NAME_SHAPE_PATTERN}. */
export const nameValue = (schema: z.ZodString) =>
  schema.regex(NAME_SHAPE_PATTERN, NAME_SHAPE_MESSAGE);

/** A string or key with an unpaired surrogate, or a value nested too deep. */
type WellFormednessRefusal = {
  reason: "lone-surrogate" | "too-deep";
  path: PropertyKey[];
};

/**
 * The first string or key in `value` with an unpaired UTF-16 surrogate, or the
 * first value nested past {@link MAX_NESTING_DEPTH}, or undefined. A walk, so
 * it reaches `params` keys and arbitrary param values. Its width is bounded by
 * the camelize pre-pass on every partner-reachable path. Its depth bound is its
 * own, since `LinkageTermsSchema` is also used bare and a deep value would
 * otherwise overflow the recursion.
 */
function firstWellFormednessRefusal(
  value: unknown,
  path: PropertyKey[],
  depth: number,
): WellFormednessRefusal | undefined {
  if (typeof value === "string")
    return loneSurrogateIndex(value) >= 0
      ? { reason: "lone-surrogate", path }
      : undefined;
  if (value === null || typeof value !== "object") return undefined;
  if (depth >= MAX_NESTING_DEPTH) return { reason: "too-deep", path };
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      const found = firstWellFormednessRefusal(
        element,
        [...path, index],
        depth + 1,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (loneSurrogateIndex(key) >= 0)
      return { reason: "lone-surrogate", path: childPath };
    const found = firstWellFormednessRefusal(child, childPath, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A constraint `exclude` denylist: control-character-refused free-text values
 * (not the text-direction rule), count-bounded at {@link MAX_EXCLUDE_ENTRIES}.
 */
const ExcludeSchema = boundedArray(
  freeTextValue(z.string().check(maxCodeUnits(MAX_TEXT_LENGTH))),
  MAX_EXCLUDE_ENTRIES,
  `exclude must not exceed ${MAX_EXCLUDE_ENTRIES} entries`,
);

// --- Output ------------------------------------------------------------------

/**
 * Per-party output preferences. If exactly one party expects output it is the
 * receiver; if both do, roles are assigned by dataset size.
 */
export interface Output {
  /**
   * Whether this party expects to receive the intersection result. Requires
   * the partner's linkage terms to also have `shareWithPartner: true`.
   */
  expectsOutput: boolean;
  /**
   * Whether the other party should also receive the result. Requires the
   * partner's linkage terms to also have `expectsOutput: true`.
   */
  shareWithPartner: boolean;
}

const OutputSchema: z.ZodType<Output> = z.object({
  expectsOutput: z.boolean(),
  shareWithPartner: z.boolean(),
});

// --- Linkage fields ----------------------------------------------------------

/** Constraints on name fields. */
interface NameConstraints {
  /**
   * Regex character class; characters outside it are expected to have been
   * removed.
   */
  allowedCharacters?: string;
  /**
   * If false, honorifics (Mr., Dr.) and suffixes (Jr., III) are expected to
   * have been removed.
   */
  affixesAllowed?: boolean;
  exclude?: string[];
}

const NameConstraintsSchema: z.ZodType<NameConstraints> = z.object({
  // Must compile as a class under the engine that runs it (re2js,
  // valueConstraints.ts), a leading `^` escaped. An over-length value skips the
  // compile and is refused by the ceiling alone
  // (docs/spec/CHANNEL_SECURITY.md#name-constraint-character-class).
  allowedCharacters: z
    .string()
    .check(maxCodeUnits(MAX_NAME_LENGTH))
    .refine(
      (val) =>
        val.length > MAX_NAME_LENGTH || patternConformsToDialect(`[${val}]`),
      { message: "allowed_characters must be a valid regex character class" },
    )
    .optional(),
  affixesAllowed: z.boolean().optional(),
  exclude: ExcludeSchema.optional(),
});

/** Constraints on date-of-birth fields. */
interface DateConstraints {
  /** Dates must be able to be parsed as valid dates. */
  validOnly?: boolean;
  exclude?: string[];
}

const DateConstraintsSchema: z.ZodType<DateConstraints> = z.object({
  validOnly: z.boolean().optional(),
  exclude: ExcludeSchema.optional(),
});

/** Constraints on SSN and SSN-last-4 fields. */
interface SSNConstraints {
  /**
   * Data must conform to SSA rules (area, group, and serial numbers may not be
   * all zeros, etc.).
   */
  validOnly?: boolean;
  /**
   * Values that must not appear in the data (e.g. "123456789", "111111111").
   */
  exclude?: string[];
}

const SSNConstraintsSchema: z.ZodType<SSNConstraints> = z.object({
  validOnly: z.boolean().optional(),
  exclude: ExcludeSchema.optional(),
});

/** Constraints applicable to any semantic type. */
interface AnyConstraints {
  exclude?: string[];
}

const AnyConstraintsSchema: z.ZodType<AnyConstraints> = z.object({
  exclude: ExcludeSchema.optional(),
});

// Shared fields for all linkage field variants.
const linkageFieldBase = <C>(constraints: z.ZodType<C>) => ({
  name: nameValue(z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH))),
  constraints: constraints.optional(),
});

interface FirstNameField {
  name: string;
  type: "first_name";
  constraints?: NameConstraints;
}
interface LastNameField {
  name: string;
  type: "last_name";
  constraints?: NameConstraints;
}
interface DateOfBirthField {
  name: string;
  type: "date_of_birth";
  constraints?: DateConstraints;
}
interface SsnField {
  name: string;
  type: "ssn";
  constraints?: SSNConstraints;
}
/**
 * Last four digits of SSN. Distinct from `ssn` because some parties only
 * possess the last four digits; this is not a derived field.
 */
interface Ssn4Field {
  name: string;
  type: "ssn4";
  constraints?: SSNConstraints;
}
interface PhoneNumberField {
  name: string;
  type: "phone_number";
  constraints?: AnyConstraints;
}
interface EmailAddressField {
  name: string;
  type: "email_address";
  constraints?: AnyConstraints;
}
interface ZipCodeField {
  name: string;
  type: "zip_code";
  constraints?: AnyConstraints;
}

/**
 * A standardized PII field that participates in linkage. Linkage key elements
 * reference these fields by name; data cleaning pipelines produce them by name.
 * Constraints are standards both parties commit to meeting -- the application
 * warns if violated but does not enforce them.
 */
export type LinkageField =
  | FirstNameField
  | LastNameField
  | DateOfBirthField
  | SsnField
  | Ssn4Field
  | PhoneNumberField
  | EmailAddressField
  | ZipCodeField;

const LinkageFieldSchema: z.ZodType<LinkageField> = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("first_name"),
      ...linkageFieldBase(NameConstraintsSchema),
    }),
    z.object({
      type: z.literal("last_name"),
      ...linkageFieldBase(NameConstraintsSchema),
    }),
    z.object({
      type: z.literal("date_of_birth"),
      ...linkageFieldBase(DateConstraintsSchema),
    }),
    z.object({
      type: z.literal("ssn"),
      ...linkageFieldBase(SSNConstraintsSchema),
    }),
    z.object({
      type: z.literal("ssn4"),
      ...linkageFieldBase(SSNConstraintsSchema),
    }),
    z.object({
      type: z.literal("phone_number"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
    z.object({
      type: z.literal("email_address"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
    z.object({
      type: z.literal("zip_code"),
      ...linkageFieldBase(AnyConstraintsSchema),
    }),
  ],
);

// --- Linkage key elements ----------------------------------------------------

/**
 * The candidate-set expansion a linkage-key element may declare. Applied by
 * `expandFuzzyComparisons`, which defines what each member emits.
 */
export type GenerateFuzzyComparisons =
  "transpositions" | "edit_distances" | "adjacent_years" | "day_month_swaps";

const GenerateFuzzyComparisonsSchema: z.ZodType<GenerateFuzzyComparisons> =
  z.enum([
    "transpositions",
    "edit_distances",
    "adjacent_years",
    "day_month_swaps",
  ]);

/**
 * A single step in a linkage key element transform. Uses the same function
 * names as the data cleaning pipeline.
 */
export interface TransformStep {
  /** Name of the function to apply. */
  function: string;
  /** Function-specific parameters. */
  params?: Record<string, unknown>;
}

// One `params` value: any JSON, with a length bound on a string and a count
// bound on a list, on the value stage so they apply to every function and param
// name. Per-function type and magnitude checks are the refines below. Messages
// are fixed literals; the issue path locates the param.
const TransformParamValueSchema = z
  .unknown()
  .refine(
    (value) =>
      typeof value !== "string" || value.length <= MAX_TRANSFORM_PARAM_LENGTH,
    {
      message: `a linkage key element transform param must not exceed ${MAX_TRANSFORM_PARAM_LENGTH} characters`,
    },
  )
  .refine(
    (value) =>
      !Array.isArray(value) || value.length <= MAX_TRANSFORM_PARAM_ENTRIES,
    {
      message: `a linkage key element transform param must not hold more than ${MAX_TRANSFORM_PARAM_ENTRIES} entries`,
    },
  );

// Not annotated as ZodType<TransformStep> because the concrete ZodObject is the
// base the pad_left refine below chains onto (mirrors LinkageTermsBaseSchema).
const TransformStepBaseSchema = z.object({
  function: nameValue(z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH))),
  // Keys take the name shape; the entry count is checked by a bare key count
  // before any per-key parse
  // (docs/spec/CHANNEL_SECURITY.md#application-layer-parsed-input-bounds).
  params: z
    .unknown()
    .refine(
      (rec) =>
        rec === null ||
        typeof rec !== "object" ||
        Array.isArray(rec) ||
        !exceedsOwnKeyCount(rec, MAX_PARAMS_ENTRIES),
      {
        message: `transform params must not exceed ${MAX_PARAMS_ENTRIES} entries`,
        abort: true,
      },
    )
    .pipe(
      z.record(
        nameValue(z.string().check(maxCodeUnits(MAX_NAME_LENGTH))),
        TransformParamValueSchema,
      ),
    )
    .optional(),
});

// Per-function bounds on values whose magnitude drives per-row work, stricter
// than the uniform string bound; on this wire schema, not the editor descriptor
// (docs/spec/CHANNEL_SECURITY.md#unbounded-transform-parameter-rejection).
const TransformStepBoundsSchema = TransformStepBaseSchema
  // `pad_left` allocates a `padStart` of `length` per row. A non-integer is
  // refused by the type check below, and padLeftFactory throws on a
  // non-positive one.
  .refine(
    (step) => {
      if (step.function !== "pad_left") return true;
      const length = step.params?.length;
      return (
        typeof length !== "number" ||
        !Number.isInteger(length) ||
        length <= MAX_PAD_LEFT_LENGTH
      );
    },
    {
      message: `pad_left length must not exceed ${MAX_PAD_LEFT_LENGTH}`,
      path: ["params", "length"],
    },
  )
  // `parse_date` builds a regex from `inputFormat` and each result from
  // `outputFormat`. The format names are written as literals, pinned by tests.
  .refine(
    (step) => {
      if (step.function !== "parse_date") return true;
      const { inputFormat, outputFormat } = step.params ?? {};
      return (
        (typeof inputFormat !== "string" ||
          inputFormat.length <= MAX_DATE_FORMAT_LENGTH) &&
        (typeof outputFormat !== "string" ||
          outputFormat.length <= MAX_DATE_FORMAT_LENGTH)
      );
    },
    {
      message: `parse_date input_format and output_format must not exceed ${MAX_DATE_FORMAT_LENGTH} characters`,
      path: ["params"],
    },
  )
  // An empty `outputFormat` renders every date to "", a derived width of zero
  // (elementValueWidthBound, keyElementWidth.ts) narrower than the one
  // candidate a row emits, so a correct row would be refused at the width bound.
  .refine(
    (step) => {
      if (step.function !== "parse_date") return true;
      const { outputFormat } = step.params ?? {};
      return typeof outputFormat !== "string" || outputFormat.length > 0;
    },
    {
      message:
        "parse_date output_format must not be empty: it would render every " +
        "date to the empty string",
      path: ["params", "outputFormat"],
    },
  )
  // A source-length compile-cost bound on the four regex-tier functions
  // (docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect). Only a
  // string is measured: another type is refused by the type check, and
  // coercing it would run a partner-declared `toString`.
  .refine(
    (step) => {
      const paramKey = regexStepPatternParam(step.function);
      if (paramKey === undefined) return true;
      const value = step.params?.[paramKey];
      if (typeof value !== "string") return true;
      return value.length <= MAX_TRANSFORM_PATTERN_LENGTH;
    },
    {
      message: `transform regex pattern must not exceed ${MAX_TRANSFORM_PATTERN_LENGTH} characters`,
      path: ["params"],
    },
  );

// Every param a step function reads must have the type it is read as
// (transformParamTypes.ts), refused at decode naming the param. An absent
// param is admitted, except a regex-tier step's pattern; a `substring` bound
// left out is refused by the dead-pipeline grading instead. `options` decides
// whether a text param's refusal names the remedy.
const transformStepSchema = (
  options: TransformParamRefusalOptions,
): z.ZodType<TransformStep> =>
  TransformStepBoundsSchema.superRefine((step, ctx) => {
    for (const refusal of transformParamTypeRefusals(step, options))
      ctx.addIssue({
        code: "custom",
        message: refusal.message,
        path: refusal.path,
      });
    for (const refusal of transformParamAbsenceRefusals(step, options))
      ctx.addIssue({
        code: "custom",
        message: refusal.message,
        path: refusal.path,
      });
    // Refuse a params shape the consent summary would state differently from
    // what the run applies (transformParamDisplay.ts). The length bound is
    // passed so the key-material scan skips a value already refused.
    for (const refusal of transformParamDisplayRefusals(step, {
      refusesStringParamsPast: MAX_TRANSFORM_PARAM_LENGTH,
    }))
      ctx.addIssue({
        code: "custom",
        message: refusal.message,
        path: refusal.path,
      });
  });

/**
 * One element of a linkage key: a linkage field by name, optionally
 * transformed before concatenation.
 */
export interface LinkageKeyElement {
  /** Name of the linkage field this element is derived from. */
  field: string;
  /**
   * Optional alias for this element within the key; used when the same field
   * appears more than once, or as the target of a `swap`.
   */
  name?: string;
  /**
   * Expands a single value into multiple candidates before hashing.
   * - `transpositions`: all two-digit transpositions.
   * - `edit_distances`: all single-character deletions, matching values
   *   within one edit distance.
   * - `adjacent_years`: +/- 1 year from the date.
   * - `day_month_swaps`: the date with its day and month exchanged.
   */
  generateFuzzyComparisons?: GenerateFuzzyComparisons;
  /**
   * Transformations applied in order to the canonical field value before it
   * is concatenated into the key.
   */
  transform?: TransformStep[];
}

const linkageKeyElementSchema = (
  options: TransformParamRefusalOptions,
): z.ZodType<LinkageKeyElement> =>
  z.object({
    field: nameValue(z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH))),
    name: nameValue(z.string().check(maxCodeUnits(MAX_NAME_LENGTH))).optional(),
    generateFuzzyComparisons: GenerateFuzzyComparisonsSchema.optional(),
    transform: boundedArray(
      transformStepSchema(options),
      MAX_TRANSFORM_STEPS,
      `transform must not exceed ${MAX_TRANSFORM_STEPS} steps`,
    ).optional(),
  });

// --- Linkage keys ------------------------------------------------------------

/**
 * One linkage key: one round of matching with PSI, keys ordered most to least
 * precise. A `swap` names two elements the receiver builds in both orders,
 * catching reversed data entry (docs/notes/one-sided-fuzzy-expansion.md).
 */
export interface LinkageKey {
  name: string;
  /** Ordered list of field-derived elements combined to form the key. */
  elements: LinkageKeyElement[];
  /**
   * Two element identifiers (element `name` or `field` name) the receiver
   * swaps; sender uses un-swapped order.
   */
  swap?: [string, string];
}

const linkageKeySchema = (
  options: TransformParamRefusalOptions,
): z.ZodType<LinkageKey> =>
  z.object({
    name: nameValue(z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH))),
    elements: boundedArray(
      linkageKeyElementSchema(options),
      MAX_KEY_ELEMENTS,
      `elements must not exceed ${MAX_KEY_ELEMENTS} entries`,
      1,
    ),
    swap: z
      .tuple([
        nameValue(z.string().check(maxCodeUnits(MAX_NAME_LENGTH))),
        nameValue(z.string().check(maxCodeUnits(MAX_NAME_LENGTH))),
      ])
      .optional(),
  });

/**
 * The linkage-field names at least one key element references: the fields the
 * exchange standardizes and consumes. Disclosure-relevant: the default-terms
 * and advanced-invite derivations filter `linkageFields` by it, so it shapes
 * the terms hash; keep its membership exact. `swap` does not widen it.
 */
export function referencedLinkageFieldNames(
  linkageKeys: readonly LinkageKey[],
): Set<string> {
  return new Set(
    linkageKeys.flatMap((key) => key.elements.map((e) => e.field)),
  );
}

// --- Payload -----------------------------------------------------------------

export interface PayloadColumn {
  /** Column name in the output. */
  name: string;
  /** A data dictionary entry shared with the partner. */
  description?: string;
}

const PayloadColumnSchema: z.ZodType<PayloadColumn> = z.object({
  name: nameValue(z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH))),
  description: recordedFreeTextValue(
    z.string().check(maxCodeUnits(MAX_TEXT_LENGTH)),
  ).optional(),
});

/**
 * Columns transmitted for matched records over the encrypted channel. The
 * partner's send list is shared as a data dictionary. A repeated name is
 * collapsed at parse ({@link payloadColumnList}).
 */
export interface Payload {
  /** Columns this party will transmit for matched records. */
  send?: PayloadColumn[];
  /**
   * Columns this party expects from the partner; refused at parse unless
   * `output.expectsOutput`, since a party with no output gets no matches.
   */
  receive?: PayloadColumn[];
}

/**
 * One list of disclosed columns with each name kept once: the first entry
 * is kept and a later repeat is dropped, whatever its description. Names
 * compare by code unit, as docs/spec/CANONICAL_ENCODING.md requires.
 */
export const columnsNamedOnce = (
  columns: readonly PayloadColumn[],
): PayloadColumn[] => {
  const kept = new Set<string>();
  return columns.filter(({ name }) => {
    if (kept.has(name)) return false;
    kept.add(name);
    return true;
  });
};

/**
 * One direction of the payload data dictionary, count-bounded before repeats
 * collapse, so a padded list is refused for its authored count.
 */
const payloadColumnList = (message: string): z.ZodType<PayloadColumn[]> =>
  boundedArray(PayloadColumnSchema, MAX_PAYLOAD_ENTRIES, message).transform(
    columnsNamedOnce,
  );

const PayloadSchema: z.ZodType<Payload> = z.object({
  send: payloadColumnList(
    `send must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
  receive: payloadColumnList(
    `receive must not exceed ${MAX_PAYLOAD_ENTRIES} entries`,
  ).optional(),
});

// --- Legal agreement ---------------------------------------------------------

/**
 * The legal agreement authorizing this exchange. Both parties' fields are
 * cross-checked; a mismatch or a passed `expirationDate` fails the exchange
 * before any data is sent.
 */
interface LegalAgreement {
  /** Identifier of the legal agreement (e.g. "MOU-2025-0042"). */
  reference: string;
  /**
   * The purpose or authority for this disclosure, recorded in cleartext so the
   * exchange record serves alone as a HIPAA 164.528 / FERPA 99.32 disclosure
   * log entry. Never a protected, linkage-field or payload value.
   */
  purpose: string;
  /** Date after which the exchange will be refused (ISO 8601, YYYY-MM-DD). */
  expirationDate: string;
}

const LegalAgreementSchema: z.ZodType<LegalAgreement> = z.object({
  reference: nameValue(z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH))),
  purpose: recordedFreeTextValue(
    z.string().min(1).check(maxCodeUnits(MAX_TEXT_LENGTH)),
  ),
  expirationDate: z.iso.date(),
});

// --- Linkage strategy --------------------------------------------------------

/**
 * How the linkage keys are sequenced over the network; both give the same
 * result. `cascade` (the default) matches one key per round; `single-pass`
 * sends all keys in one round-trip (docs/spec/PROTOCOL.md).
 */
export type LinkageStrategy = "cascade" | "single-pass";

export const LinkageStrategySchema: z.ZodType<LinkageStrategy> = z.enum([
  "cascade",
  "single-pass",
]);

// --- Linkage rule set --------------------------------------------------------

/**
 * A named, versioned artifact the linkage rules were drawn from. Its `version`
 * versions the artifact's content, unrelated to `LinkageTerms.version`.
 */
export interface LinkageSetIdentity {
  /** Stable identifier of the set (e.g. `baseline-pii`). */
  name: string;
  /** Semver string versioning the set's content (e.g. `1.0.0`). */
  version: string;
}

const LinkageSetIdentitySchema: z.ZodType<LinkageSetIdentity> = z.object({
  name: nameValue(z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH))),
  version: z
    .string()
    .check(maxCodeUnits(MAX_NAME_LENGTH))
    .regex(/^\d+\.\d+\.\d+$/, "version must be a valid semver string"),
});

/**
 * Which named rule sets a document's linkage fields and keys were drawn from.
 * A citation, not a specification: the run matches on the document's own
 * `linkageFields` and `linkageKeys`. Absent for authored rules
 * (docs/EXCHANGE_REFERENCE.md#linkage_termslinkage_rule_set).
 */
export interface LinkageRuleSetReference {
  /** The set the `linkageFields` were drawn from. */
  fieldSet: LinkageSetIdentity;
  /** The set the `linkageKeys` were drawn from. */
  keySet: LinkageSetIdentity;
}

const LinkageRuleSetReferenceSchema: z.ZodType<LinkageRuleSetReference> =
  z.object({
    fieldSet: LinkageSetIdentitySchema,
    keySet: LinkageSetIdentitySchema,
  });

// --- Linkage Terms -----------------------------------------------------------

/**
 * One party's linkage terms. After authentication the parties swap copies; a
 * mismatch on a mandatory field cancels the exchange, and on `date` only warns.
 * Each field states its consistency rule
 * (docs/EXCHANGE_REFERENCE.md#linkage-terms).
 *
 * The schema also requires: `deduplicate` only with `output.expectsOutput`;
 * an empty `payload.receive` without it; unique field names, key names, and
 * element identifiers within a key; every element `field` a declared field;
 * every `swap` target an element of its key, the two with the same
 * `generateFuzzyComparisons` and `transform`. A repeated payload name collapses.
 *
 * TODO: versioning compatibility rules (migration paths between semver
 * versions).
 */
export interface LinkageTerms {
  /**
   * Semver string identifying the schema version. Compatibility is checked at
   * exchange time.
   */
  version: string;
  /**
   * Free text identifying the holding party, included verbatim in the exchange
   * record. Absent when the party supplied no name; Alcove invents none
   * (`partyIdentityDisplay.ts`). Consistency: none.
   */
  identity?: string;
  /**
   * Date these linkage terms were last modified (ISO 8601, YYYY-MM-DD).
   * Consistency: soft -- a mismatch warns rather than cancels the exchange.
   */
  date: string;
  /** `psi` reveals matched identifiers; `psi-c` reveals only the count. */
  algorithm: Algorithm;
  /**
   * See {@link LinkageStrategy}. Consistency: mandatory. Defaults to `cascade`.
   */
  linkageStrategy: LinkageStrategy;
  output: Output;
  /**
   * Whether several of this party's records may match the same partner record
   * (docs/spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching).
   * Consistency: none; the pair resolves the cardinality.
   */
  deduplicate: boolean;
  /**
   * Standardized form of each PII element that participates in linkage. Linkage
   * key elements and cleaning pipeline outputs reference these fields by name.
   * Consistency: mandatory.
   */
  linkageFields: LinkageField[];
  /**
   * Ordered list of linkage keys applied in sequence, most to least precise.
   * Consistency: mandatory.
   */
  linkageKeys: LinkageKey[];
  /**
   * The named rule set the fields and keys were drawn from, absent for authored
   * rules. Consistency: mandatory only when both parties declare one.
   */
  linkageRuleSet?: LinkageRuleSetReference;
  payload?: Payload;
  legalAgreement?: LegalAgreement;
}

// The base is not annotated as ZodType<LinkageTerms> because the concrete
// ZodObject type is needed to chain .refine().
const linkageTermsBaseSchema = (options: TransformParamRefusalOptions) =>
  z.object({
    version: z
      .string()
      .check(maxCodeUnits(MAX_NAME_LENGTH))
      .regex(/^\d+\.\d+\.\d+$/, "version must be a valid semver string"),
    // Optional, and bounded where it is present: a party that names itself is held
    // to a non-empty, length-capped label with no control or text-direction
    // character in it and no private-key material, and a party that supplies none
    // omits the field rather than sending an empty string or a placeholder.
    identity: recordedFreeTextValue(
      z.string().min(1).check(maxCodeUnits(MAX_TEXT_LENGTH)),
    )
      .refine((value) => !holdsPrivateKeyMaterial(value), {
        message: PRIVATE_KEY_IDENTITY_MESSAGE,
      })
      .optional(),
    date: z.iso.date(),
    algorithm: AlgorithmSchema,
    linkageStrategy: LinkageStrategySchema.default("cascade"),
    output: OutputSchema,
    deduplicate: z.boolean(),
    // Element COUNT bounded at MAX_LINKAGE_ENTRIES before per-element
    // validation, with the existing .min(1) floor preserved. A plain .max() is
    // insufficient here: these flat top-level arrays sit directly below the
    // root, so a pathological count does not overflow the call stack, but
    // still throws building the error string from one issue per invalid
    // entry. See boundedArray and docs/spec/CHANNEL_SECURITY.md,
    // "Application-layer parsed-input bounds".
    linkageFields: boundedArray(
      LinkageFieldSchema,
      MAX_LINKAGE_ENTRIES,
      `linkage_fields must not exceed ${MAX_LINKAGE_ENTRIES} entries`,
      1,
    ),
    linkageKeys: boundedArray(
      linkageKeySchema(options),
      MAX_LINKAGE_ENTRIES,
      `linkage_keys must not exceed ${MAX_LINKAGE_ENTRIES} entries`,
      1,
    ),
    linkageRuleSet: LinkageRuleSetReferenceSchema.optional(),
    payload: PayloadSchema.optional(),
    legalAgreement: LegalAgreementSchema.optional(),
  });

// The whole document, built for one audience: `options` reaches the declared
// type refusal on every transform step, which is the only refusal here whose
// wording turns on whether the party reading it wrote the document.
const linkageTermsSchema = (
  options: TransformParamRefusalOptions,
): z.ZodType<LinkageTerms> =>
  linkageTermsBaseSchema(options)
    .refine((a) => !a.deduplicate || a.output.expectsOutput, {
      message: "expects_output must be true when deduplicate is true",
      path: ["output", "expectsOutput"],
    })
    // A party that receives no output cannot receive payload columns: payload is
    // attached to matched records, which a non-receiving party never gets. Reject
    // expectsOutput:false alongside a non-empty payload.receive as an incoherent
    // configuration, so a one-sided exchange cannot produce a record that claims a
    // party received payload it was never entitled to.
    .refine(
      (a) => a.output.expectsOutput || (a.payload?.receive?.length ?? 0) === 0,
      {
        message:
          "payload.receive must be empty when expects_output is false, " +
          "because a party that receives no output receives no matched " +
          "records to attach payload columns to",
        path: ["payload", "receive"],
      },
    )
    .refine(
      (a) => {
        const names = a.linkageFields.map((f) => f.name);
        return names.length === new Set(names).size;
      },
      {
        message: "linkage field names must be unique",
        path: ["linkageFields"],
      },
    )
    .refine(
      (a) => {
        const names = a.linkageKeys.map((k) => k.name);
        return names.length === new Set(names).size;
      },
      { message: "linkage key names must be unique", path: ["linkageKeys"] },
    )
    .refine(
      (a) =>
        a.linkageKeys.every((key) => {
          const ids = key.elements.map((el) => el.name ?? el.field);
          return ids.length === new Set(ids).size;
        }),
      {
        message:
          "element identifiers (name if present, otherwise field) must be " +
          "unique within each linkage key",
        path: ["linkageKeys"],
      },
    )
    // Referential integrity, element field -> declared linkage field. Every
    // key element's `field` must name a member of linkageFields[].name. A
    // dangling field reference parses cleanly but resolves to no values at
    // exchange time (buildStandardizedDataset builds only declared fields),
    // producing a silent empty/missed-match result indistinguishable from a
    // legitimately empty intersection. The message names no partner value:
    // the offending element is located by its issue `path`, not by echoing
    // its raw field string.
    .refine(
      (a) => {
        const declared = new Set(a.linkageFields.map((f) => f.name));
        return a.linkageKeys.every((key) =>
          key.elements.every((el) => declared.has(el.field)),
        );
      },
      {
        message:
          "each linkage key element must reference a declared linkage field " +
          "(a name in linkage_fields)",
        path: ["linkageKeys"],
      },
    )
    // Referential integrity, swap target -> element within the same key. Each
    // `swap` entry must match an element identifier (name if present, otherwise
    // field) present in that same key, matching the within-key resolution the
    // LinkageKey doc comment describes. A dangling swap target silently no-ops
    // at exchange time. Element identity uses `el.name ?? el.field`, the same
    // expression as the element-identifier-uniqueness refine above, so the two
    // checks agree. As above, the message echoes no partner-controlled value.
    .refine(
      (a) =>
        a.linkageKeys.every((key) => {
          if (key.swap === undefined) return true;
          const ids = new Set(key.elements.map((el) => el.name ?? el.field));
          return key.swap.every((target) => ids.has(target));
        }),
      {
        message:
          "each linkage key swap target must match an element identifier " +
          "(name if present, otherwise field) within the same key",
        path: ["linkageKeys"],
      },
    )
    // A swap pair's two positions must declare the SAME fuzzy expansion. The
    // swap moves only the field references and leaves each position's own
    // `generateFuzzyComparisons` where it is, so a mismatched pair would
    // apply one expansion to a column on the party that swaps and a
    // different one on the party that does not. Binding the pair here is
    // what lets the key-read layer resolve the expansion from the position
    // it already holds (`planFuzzyExpansions`, standardization.ts).
    .refine((a) => !a.linkageKeys.some(swapPairFuzzyComparisonsDiffer), {
      message:
        "the two elements a linkage key swap names must declare the same " +
        "generate_fuzzy_comparisons; give both elements the same value",
      path: ["linkageKeys"],
    })
    // The sibling rule to the expansion refine above, on the swap pair's other
    // position-bound attribute; the rationale lives on swapPairTransformsDiffer.
    // As above, the message echoes no partner-controlled value.
    .refine((a) => !a.linkageKeys.some(swapPairTransformsDiffer), {
      message:
        "the two elements a linkage key swap names must declare the same " +
        "transform; give both elements the same transform",
      path: ["linkageKeys"],
    })
    // Placed here so every parse path refuses a partner's transform regex
    // before it runs: docs/spec/CHANNEL_SECURITY.md, "Transform-regex linear-time dialect".
    .superRefine((terms, ctx) => {
      const refusal = findTransformRegexRefusal(terms, {
        maxPatternLength: MAX_TRANSFORM_PATTERN_LENGTH,
      });
      if (refusal !== undefined) ctx.addIssue(transformRegexIssue(refusal));
    })
    // The count-only shape, one refine per rule so a document breaking one
    // is located by its own issue path and answered by its own message. The
    // rules are docs/spec/PROTOCOL.md, PSI-C; placed here so EVERY parse
    // path refuses -- parseLinkageTerms, the invitation-token decode, and
    // ExchangeSpecSchema. The verdict comes from the one shared reading
    // (countOnlyShapeViolation) rather than a second copy of the rule, so
    // schema and asserts cannot diverge.
    .refine((a) => countOnlyShapeViolation(a) !== "linkageKeys", {
      message: COUNT_ONLY_SHAPE_REFUSALS.linkageKeys,
      path: ["linkageKeys"],
    })
    .refine((a) => countOnlyShapeViolation(a) !== "linkageStrategy", {
      message: COUNT_ONLY_SHAPE_REFUSALS.linkageStrategy,
      path: ["linkageStrategy"],
    })
    .refine((a) => countOnlyShapeViolation(a) !== "deduplicate", {
      message: COUNT_ONLY_SHAPE_REFUSALS.deduplicate,
      path: ["deduplicate"],
    })
    .refine((a) => countOnlyShapeViolation(a) !== "payload", {
      message: COUNT_ONLY_SHAPE_REFUSALS.payload,
      path: ["payload"],
    })
    // A per-(record, key) candidate set under a combination that resolves
    // none, and the two declared-width bounds. Both read terms alone, so the
    // parse is the first boundary that can refuse them; the asserts in
    // `linkageSatisfiability.ts` and `exchange.ts` stay the boundary for a
    // document built without a parse. The verdicts come from the one shared
    // reading each rule has, so no boundary states a different refusal.
    .superRefine((terms, ctx) => {
      const refusal = termsCandidateSetRefusal(terms);
      if (refusal !== undefined)
        ctx.addIssue({
          code: "custom",
          message: refusal,
          path: ["linkageKeys"],
        });
    })
    .superRefine((terms, ctx) => {
      const refusal = declaredWidthRefusal(terms);
      if (refusal !== undefined)
        ctx.addIssue({
          code: "custom",
          message: refusal.message,
          path: [...refusal.path],
        });
    })
    // Refuse an ill-formed UTF-16 string anywhere in the document. The terms
    // are canonically encoded WHOLE -- by validateCompatibility and by
    // computeTermsHash, which runs after the exchange has disclosed -- and
    // RFC 8785 requires an encoder to terminate on a lone surrogate, so a
    // document admitted here ends the run with neither a receipt nor the
    // record of that disclosure. Every parse path inherits it, and a document
    // too deeply nested for the walk to finish is refused under its own
    // message. Full reasoning: docs/spec/CANONICAL_ENCODING.md, "Strings".
    .superRefine((terms, ctx) => {
      const refusal = firstWellFormednessRefusal(terms, [], 0);
      if (refusal !== undefined)
        ctx.addIssue({
          code: "custom",
          message:
            refusal.reason === "lone-surrogate"
              ? LONE_SURROGATE_MESSAGE
              : NESTING_DEPTH_MESSAGE,
          path: refusal.path,
        });
    });

// Interpolates only positions, counts, and fixed param names, never partner text.
function transformRegexIssue(refusal: TransformRegexRefusal): {
  code: "custom";
  message: string;
  path: (string | number)[];
} {
  if (refusal.reason === "nonconformant")
    return {
      code: "custom",
      message:
        "a linkage key element transform uses a regular expression outside the " +
        "linear-time dialect (RE2 syntax); rewrite it without backreferences " +
        "or lookaround",
      path: ["linkageKeys"],
    };
  const { keyIndex, elementIndex, stepIndex, paramKey, weightedSize } = refusal;
  return {
    code: "custom",
    message:
      `the regular expression in linkage_keys[${keyIndex}].elements[${elementIndex}]` +
      `.transform[${stepIndex}].params.${paramKey} ` +
      transformPatternSizeMessage(weightedSize),
    path: [
      "linkageKeys",
      keyIndex,
      "elements",
      elementIndex,
      "transform",
      stepIndex,
      "params",
      paramKey,
    ],
  };
}

/**
 * The linkage terms of a document, whose declared-type refusal states the type
 * and stops. That wording fits a reader with no document to edit -- an
 * acceptor reading a refusal of a partner's invitation token or of a partner's
 * terms off the wire -- and is what every path takes by default. A call site
 * whose reader WROTE the document reads it through
 * {@link safeParseLinkageTermsTheReaderWrote} instead.
 */
export const LinkageTermsSchema: z.ZodType<LinkageTerms> = linkageTermsSchema({
  readerCanEditTheDocument: false,
});

// The same document read by the party who wrote it, whose declared-type
// refusal for a text param names the remedy (quote the value, or omit the
// key). Built once here rather than per parse: the whole chain above is
// constructed at module load, and a second audience costs one more
// construction, not one per document read.
const LinkageTermsSchemaForItsAuthor: z.ZodType<LinkageTerms> =
  linkageTermsSchema({ readerCanEditTheDocument: true });

// --- Parse -------------------------------------------------------------------

/**
 * Keys whose object value the camelize pre-pass leaves verbatim once its key
 * count exceeds the bound, rather than rewriting every key (see
 * {@link camelizeKeys}). Only `transform.params` is partner-controlled and
 * key-count-bounded; the bound matches {@link MAX_PARAMS_ENTRIES}, so any
 * record left verbatim here is one the schema also rejects. Full reasoning:
 * docs/spec/CHANNEL_SECURITY.md, "Application-layer parsed-input bounds".
 */
const PARAMS_WIDTH_BOUND: ReadonlyMap<string, number> = new Map([
  ["params", MAX_PARAMS_ENTRIES],
]);

/**
 * Parse and validate a raw value as an {@link LinkageTerms}.
 * Snake_case keys in the input are converted to camelCase before validation,
 * so JSON/YAML from disk can be passed directly.
 *
 * @throws {ZodError} if validation fails.
 */
export function parseLinkageTerms(raw: unknown): LinkageTerms {
  return LinkageTermsSchema.parse(camelizeKeys(raw, PARAMS_WIDTH_BOUND));
}

/**
 * Non-throwing version of {@link parseLinkageTerms}.
 * Returns a Zod `SafeParseReturnType` with `success` and either `data` or
 * `error`. Honors the "safe" contract for the {@link camelizeKeys} bounds too:
 * a depth- or node-count-tripping input yields a `{ success: false }` result
 * rather than throwing (see {@link safeParseCamelized}).
 */
export function safeParseLinkageTerms(raw: unknown) {
  return safeParseCamelized(LinkageTermsSchema, raw, PARAMS_WIDTH_BOUND);
}

/**
 * {@link safeParseLinkageTerms} for a stored copy whose writer serialized a
 * parse result, so every key it holds is one the schema reads: a key the
 * schema would drop is refused ({@link droppedSettingIssues}) rather than
 * trimmed, so the terms re-hashed are the terms the file states.
 */
export function safeParseStoredLinkageTerms(raw: unknown) {
  return safeParseCamelized(
    LinkageTermsSchema,
    raw,
    PARAMS_WIDTH_BOUND,
    (camelized, parsed) => droppedSettingIssues(raw, camelized, parsed),
  );
}

/**
 * {@link safeParseLinkageTerms} for a document the reading party WROTE -- the
 * `linkage_terms` block of an operator's own configuration file. A param
 * declared as the wrong text type is refused with the remedy that fits a
 * document the reader can edit (quote the value, or omit the key), as the
 * standardization block's refusal already is, and a key this schema would drop
 * rather than read is refused instead ({@link droppedSettingIssues}), as the
 * whole-file read refuses it: the file is the reader's own, and a command that
 * writes it back out would write it short of that setting. A partner's terms
 * are read through {@link safeParseLinkageTerms}, whose refusal states the type
 * alone and whose document this reader does not write.
 */
export function safeParseLinkageTermsTheReaderWrote(raw: unknown) {
  return safeParseCamelized(
    LinkageTermsSchemaForItsAuthor,
    raw,
    PARAMS_WIDTH_BOUND,
    (camelized, parsed) => droppedSettingIssues(raw, camelized, parsed),
  );
}

// The invitation decode path needs the same camelize-before-validate pre-pass
// over its linkage-terms field, but builds it from the exported LinkageTermsSchema
// and PARAMS_WIDTH_BOUND's width bound (MAX_PARAMS_ENTRIES) at its own module
// rather than here -- a throwing z.preprocess kept off this file's wholesale
// public export, so no external caller can reach a schema whose `.safeParse()`
// would throw the camelize bounds. See the invitationLinkageTermsSchema note in
// config/invitation.ts.
