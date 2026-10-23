import { z } from "zod";
import { maxCodeUnits } from "../utils/maxCodeUnits.js";

import {
  MAX_NAME_LENGTH,
  MAX_TRANSFORM_PATTERN_LENGTH,
} from "./linkageTermsSchema.js";
import { safeParseCamelized } from "./safeParseCamelized.js";
import { droppedSettingIssues } from "./unreadKeys.js";
import { transformParamDisplayRefusals } from "./transformParamDisplay.js";
import {
  transformParamAbsenceRefusals,
  transformParamTypeRefusals,
} from "./transformParamTypes.js";
import {
  emptyMatchingDelimiterMessage,
  splitDelimiterMatchesEmptyString,
} from "./transformRegexDialect.js";
import { patternConformsToDialect } from "../utils/linearRegex.js";

// --- Standardizing step ------------------------------------------------------

/**
 * A single step in a data standardization pipeline. Function names match the
 * cleaning and standardizing function library (snake_case); params keys are
 * camelCase after YAML parsing.
 */
export interface StandardizationStep {
  function: string;
  params?: Record<string, unknown>;
}

const StandardizationStepSchema: z.ZodType<StandardizationStep> = z
  .object({
    function: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  // A param the step function reads takes the type that function reads it as,
  // the same table the linkage-terms wire schema checks against
  // (transformParamTypes.ts). A cleaning step is the operator's own, so the
  // reading here is the one that catches the unquoted number or bare `null` a
  // YAML document is easy to write: it refuses at decode, naming the param and
  // the type it got, rather than running with something the operator did not
  // write. A param left out is how a step takes the function's default, except
  // for a raw pattern, which has none (transformParamAbsenceRefusals).
  .superRefine((step, ctx) => {
    // The document this refuses is the operator's own, and the operator is who
    // reads the refusal, so a text param's refusal names the remedy: quote the
    // value, or leave the key out. The terms schema's identical check says the
    // type alone, because an acceptor reading a refusal of a partner's
    // invitation has no document to edit.
    for (const refusal of transformParamTypeRefusals(step, {
      readerCanEditTheDocument: true,
    }))
      ctx.addIssue({
        code: "custom",
        message: refusal.message,
        path: refusal.path,
      });
    for (const refusal of transformParamAbsenceRefusals(step, {
      readerCanEditTheDocument: true,
    }))
      ctx.addIssue({
        code: "custom",
        message: refusal.message,
        path: refusal.path,
      });
    // The shapes a consent summary cannot state as they run are refused here
    // as on the terms schema (transformParamDisplay.ts). Both schemas admit
    // the same step, so a step moved between the two meets one answer rather
    // than two, and the `null_if` pair is a difference between document and
    // run on this side as well: the run applies the list alone whichever
    // document declares both. This schema is operator-local and bounds no
    // param length, so no value is passed over by the key-material scan.
    for (const refusal of transformParamDisplayRefusals(step, {
      refusesStringParamsPast: undefined,
    }))
      ctx.addIssue({
        code: "custom",
        message: refusal.message,
        path: refusal.path,
      });
    // The terms schema refuses this in its budgeted pattern walk; this block is
    // the operator's own, so its delimiter compiles here. One outside the
    // dialect, or over the length cap, is not compiled here either and is left
    // to the compile at the run, which names the engine's error.
    const delimiter =
      step.function === "split_on" ? step.params?.delimiter : undefined;
    if (
      typeof delimiter === "string" &&
      delimiter.length <= MAX_TRANSFORM_PATTERN_LENGTH &&
      patternConformsToDialect(delimiter) &&
      splitDelimiterMatchesEmptyString(delimiter)
    )
      ctx.addIssue({
        code: "custom",
        message: emptyMatchingDelimiterMessage({
          readerCanEditTheDocument: true,
        }),
        path: ["params", "delimiter"],
      });
  });

// --- Standardizing transformation --------------------------------------------

/**
 * A rule dropping a field's cleaned value that is one of `values` from a record
 * whose cleaned last name is one of `lastNames`
 * (docs/spec/DEFAULT_STANDARDIZATION.md, First name beside a listed last name).
 */
export interface NullIfLastName {
  /** Cleaned values of this field the rule drops. */
  values: string[];
  /** Cleaned last names beside which the rule drops them. */
  lastNames: string[];
}

const NullIfLastNameSchema: z.ZodType<NullIfLastName> = z.object({
  values: z.array(z.string()),
  lastNames: z.array(z.string()),
});

/**
 * A single data standardization transformation. Takes one input column from the
 * raw data, applies a sequence of steps, and makes the result available for use
 * as the linkage field with the given name.
 *
 * A step may produce `null` (excluding the record from any key that references
 * this field) or a `Set<string>` via `split_on` (each value produces a separate
 * PSI entry while retaining the original row identifier).
 */
export interface StandardizationTransformation {
  /**
   * Name of a linkage field in `linkage_terms.fields`. Must match exactly, and
   * is bounded to {@link MAX_NAME_LENGTH} as that field's own name is.
   */
  output: string;
  /**
   * Column name in the raw input data, bounded to {@link MAX_NAME_LENGTH} as a
   * declared column name is.
   */
  input: string;
  /**
   * Steps applied in order. If omitted the raw input value is used unchanged.
   */
  steps?: StandardizationStep[];
  /**
   * The most distinct people in this party's file who may hold one cleaned
   * value of this field. A value held by more is dropped from the whole file
   * before keys are built; omitted, no value is dropped for being shared. The
   * counting rule is in docs/spec/DEFAULT_STANDARDIZATION.md, Shared-value
   * screens.
   */
  maxPeoplePerValue?: number;
  /**
   * Drops a cleaned value of this field beside a listed last name; omitted,
   * no value is dropped for the record's last name.
   */
  nullIfLastName?: NullIfLastName;
}

const StandardizationTransformationSchema: z.ZodType<StandardizationTransformation> =
  z.object({
    // Both name a thing rather than hold data -- a linkage field this party
    // declares and a column of this party's own input -- so each takes the
    // ceiling every other name in a configuration has. Neither is sent to the
    // partner, which is why the bound stands alone here and the terms names'
    // character rule does not (docs/spec/PARSED_INPUT_BOUNDS.md).
    output: z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)),
    input: z.string().min(1).check(maxCodeUnits(MAX_NAME_LENGTH)),
    steps: z.array(StandardizationStepSchema).optional(),
    maxPeoplePerValue: z.int().min(1).optional(),
    nullIfLastName: NullIfLastNameSchema.optional(),
  });

// --- Standardization ---------------------------------------------------------

/**
 * The full set of data standardization transformations for one party's exchange
 * specification. Each entry produces one linkage field; a field may appear as
 * `output` at most once.
 */
export type Standardization = StandardizationTransformation[];

export const StandardizationSchema: z.ZodType<Standardization> = z
  .array(StandardizationTransformationSchema)
  .refine(
    (ts) => {
      const outputs = ts.map((t) => t.output);
      return outputs.length === new Set(outputs).size;
    },
    { message: "each linkage field may appear as output at most once" },
  );

/**
 * Parse and validate a raw on-disk `standardization` block, converting its
 * snake_case keys to camelCase first, as every other document read does.
 *
 * The block a document writes reaches the schema and the function library
 * through this, so a step's `input_format` is the `inputFormat` both the
 * declared-type check ({@link transformParamTypeRefusals}) and the factory that
 * reads it look up -- the same normalization `ExchangeSpecSchema` applies to
 * this block on the run path (`parseExchangeSpec`), so a config's steps behave
 * the same whichever entry point reads them.
 *
 * Returns a Zod safe-parse result. Honors the "safe" contract for the
 * `camelizeKeys` bounds too: a depth- or node-count-tripping input yields a
 * `{ success: false }` result rather than throwing.
 */
export function safeParseStandardization(raw: unknown) {
  return safeParseCamelized(StandardizationSchema, raw);
}

/**
 * {@link safeParseStandardization} for the `standardization` block of a
 * document the reading party WROTE -- an operator's own configuration file.
 * Identical in what it admits, with one addition: a key this schema would drop
 * rather than read is refused ({@link droppedSettingIssues}), as the
 * whole-file read of the same block refuses it, so a command that writes the
 * file back out cannot write it short of a setting the operator stated.
 */
export function safeParseStandardizationTheReaderWrote(raw: unknown) {
  return safeParseCamelized(
    StandardizationSchema,
    raw,
    undefined,
    (camelized, parsed) => droppedSettingIssues(raw, camelized, parsed),
  );
}
