// Whether declared linkage terms can ever produce a value: the static, data-free
// half of standardization, run inside an exchange and by the apps ahead of one.
// The execution half is standardization.ts; the value-level companion is
// valueConstraints.ts.

import {
  chainDetailCauses,
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  StandardizationTermsError,
  UsageError,
} from "./errors.js";
import { singleColumnDelimiterClause } from "./csvDelimiter.js";
import { annotate, annotationKey, annotationOf } from "./failureAnnotation.js";
import type { Standardization } from "./config/standardizationSchema.js";
import type {
  LinkageField,
  LinkageKey,
  LinkageTerms,
  TransformStep,
} from "./config/linkageTermsSchema.js";
import { inferMetadata } from "./config/metadata.js";
import type { ColumnMetadata } from "./config/metadata.js";
import { DEFAULT_DATE_OUTPUT_FORMAT } from "./keyElementWidth.js";
import { declaredFanOutFunction } from "./fanOutFunctions.js";
import {
  candidateSetIsImplementedForStrategy,
  COUNT_ONLY_SHAPE_REFUSALS,
  termsCandidateSetRefusal,
} from "./linkageTermsPolicy.js";
import { frozenLookupTable } from "./utils/frozenLookupTable.js";
import { redactPrivateKeyMaterial } from "./utils/sanitizeErrorForDisplay.js";
import {
  applyStep,
  commitCompiledTransforms,
  compileSteps,
  fanOutDeclaredMessage,
  isTransformFunctionLabel,
  openTransformWorkMeter,
  parseDateFormat,
  renderDateOutput,
  resolveFieldColumns,
  STANDARDIZATION_FUNCTION_NAMES,
  stepCompileBudgetRefusalMessage,
  stepCompileRefusalMessage,
  stepCountRefusalMessage,
  uncompilableStepLabel,
  valueOverCeiling,
  YEAR_FORMAT_TOKENS,
} from "./standardization.js";
import type {
  CompiledStep,
  FieldValue,
  Params,
  PendingCompiledTransforms,
  TransformWorkMeter,
} from "./standardization.js";

/**
 * Validate that every standardization output names a linkage field in `terms`
 * and every step function is known. Returns the error messages, empty when
 * consistent. Names are interpolated raw: the in-repo caller composes them into
 * a {@link StandardizationTermsError}, escaped once at the display sink.
 */
export function validateStandardizationAgainstTerms(
  standardization: Standardization,
  terms: LinkageTerms,
): string[] {
  const errors: string[] = [];
  const fieldNames = new Set(terms.linkageFields.map((f) => f.name));

  for (const t of standardization) {
    if (!fieldNames.has(t.output)) {
      errors.push(
        `standardization output "${t.output}" does not match any linkage ` +
          "field name",
      );
    }
    for (const step of t.steps ?? []) {
      if (!STANDARDIZATION_FUNCTION_NAMES.includes(step.function)) {
        errors.push(
          `unknown standardization function ` +
            `"${step.function}" in transformation for ` +
            `"${t.output}"`,
        );
      }
    }
  }

  return errors;
}

/**
 * Throw when an authored standardization contradicts its linkage terms, the
 * check {@link validateStandardizationAgainstTerms} reports, at the mint
 * boundary and in {@link prepareForExchange}. Callers skip it for an absent
 * standardization, which is derived from the terms.
 *
 * @throws {StandardizationTermsError} a {@link UsageError}; its message names
 * only the authoring party's own outputs and functions.
 */
export function assertStandardizationMatchesTerms(
  standardization: Standardization,
  terms: LinkageTerms,
): void {
  const inconsistencies = validateStandardizationAgainstTerms(
    standardization,
    terms,
  );
  if (inconsistencies.length > 0)
    throw new StandardizationTermsError(
      "this configuration's standardization is inconsistent with its linkage " +
        `terms: ${inconsistencies.join("; ")}. Correct the standardization or ` +
        "the linkage terms so every transform output names a declared linkage " +
        "field and every step function is known.",
    );
}

/**
 * Refuse a per-(record, key) candidate set (a fan-out, a fuzzy expansion or a
 * `swap`) under `psi-c` or a strategy that resolves none, before matching
 * (docs/spec/PROTOCOL.md#the-combinations-that-stay-unsupported). Runs where
 * terms are authored or minted, at prepare, and at the run boundary; a parse
 * already refuses the terms half ({@link termsCandidateSetRefusal}).
 *
 * The local standardization half is refused here because a partner cannot
 * derive it. It throws {@link OperatorConfigError}, since no invitation contains a
 * standardization; the terms half throws {@link UsageError}, since the accept
 * path adopts the partner's keys. Neither message contains partner free text.
 * `standardization` is omitted where the caller no longer has one.
 */
export function assertFanOutImplemented(
  terms: LinkageTerms,
  standardization?: Standardization,
): void {
  const countOnly = terms.algorithm === "psi-c";
  if (!countOnly && candidateSetIsImplementedForStrategy(terms.linkageStrategy))
    return;
  for (const transformation of standardization ?? []) {
    const declared = declaredFanOutFunction(transformation.steps);
    if (declared !== undefined)
      throw new OperatorConfigError(
        countOnly
          ? COUNT_ONLY_SHAPE_REFUSALS.candidateSet
          : fanOutDeclaredMessage(declared),
      );
  }
  const termsRefusal = termsCandidateSetRefusal(terms);
  if (termsRefusal !== undefined) throw new UsageError(termsRefusal);
}

/**
 * The most transform steps one document may declare across its standardization
 * and every linkage-key element, checked before anything compiles so the
 * verdict is the same on every machine
 * (docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect).
 */
const TRANSFORM_COMPILE_MAX_STEPS = 512;

/**
 * Wall-clock budget, in milliseconds, for compiling one document's steps under
 * {@link TRANSFORM_COMPILE_MAX_STEPS}; steps past it are refused unchecked
 * (docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect).
 */
const TRANSFORM_COMPILE_TOTAL_BUDGET_MS = 2000;

/** Overrides for the compile walk's bounds, so tests can drive both refusals. */
interface TransformCompileBudget {
  /** See {@link TRANSFORM_COMPILE_TOTAL_BUDGET_MS}. */
  totalBudgetMs?: number;
  /** See {@link TRANSFORM_COMPILE_MAX_STEPS}. */
  maxSteps?: number;
}

/**
 * Which of {@link assertTransformsCompile}'s document-shaped refusals a failure
 * is, with values a front end can render: `stepLabel` comes from
 * {@link uncompilableStepLabel} and both counts are integers, so none contains
 * authored text. The wall-clock refusal is absent: it names no fault in the
 * document.
 */
export type TransformRefusal =
  | { readonly reason: "uncompilable-step"; readonly stepLabel: string }
  | {
      readonly reason: "too-many-steps";
      readonly declaredSteps: number;
      readonly maxSteps: number;
    };

const TRANSFORM_REFUSAL = annotationKey<TransformRefusal>("transform refusal");

// An annotation rather than a subclass: the class already states whose content
// the fault is, which the CLI exit code and the web config alert read.
function markTransformRefusal<E extends object>(
  error: E,
  refusal: TransformRefusal,
): E {
  return annotate(error, TRANSFORM_REFUSAL, refusal);
}

function isStepCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Each renderable field is checked against the values the marking sites
// produce; anything else is no refusal, and the caller uses its own message.
function asTransformRefusal(value: unknown): TransformRefusal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<Record<string, unknown>>;
  if (
    candidate.reason === "uncompilable-step" &&
    typeof candidate.stepLabel === "string" &&
    isTransformFunctionLabel(candidate.stepLabel)
  )
    return { reason: "uncompilable-step", stepLabel: candidate.stepLabel };
  if (
    candidate.reason === "too-many-steps" &&
    isStepCount(candidate.declaredSteps) &&
    isStepCount(candidate.maxSteps)
  )
    return {
      reason: "too-many-steps",
      declaredSteps: candidate.declaredSteps,
      maxSteps: candidate.maxSteps,
    };
  return undefined;
}

/**
 * The {@link TransformRefusal} on `error` or its `cause` chain, or `undefined`.
 * How a caller tells the refusals apart and composes its own copy; the values
 * hold no text from the document.
 */
export function transformRefusalIn(
  error: unknown,
): TransformRefusal | undefined {
  return asTransformRefusal(annotationOf(error, TRANSFORM_REFUSAL));
}

/**
 * The refusal for a document declaring more than `maxSteps` steps in total, or
 * `undefined`. The class follows the surface whose steps cross the bound in
 * walk order; the message states the whole document's count.
 */
function stepCountRefusal(
  terms: LinkageTerms,
  standardization: Standardization | undefined,
  maxSteps: number,
): Error | undefined {
  const standardizationSteps = (standardization ?? []).reduce(
    (total, transformation) => total + (transformation.steps ?? []).length,
    0,
  );
  const elementSteps = terms.linkageKeys.reduce(
    (total, key) =>
      total +
      key.elements.reduce(
        (keyTotal, element) => keyTotal + (element.transform ?? []).length,
        0,
      ),
    0,
  );
  const declaredSteps = standardizationSteps + elementSteps;
  if (declaredSteps <= maxSteps) return undefined;
  return markTransformRefusal(
    standardizationSteps > maxSteps
      ? new OperatorConfigError(
          stepCountRefusalMessage(declaredSteps, maxSteps),
        )
      : new UsageError(stepCountRefusalMessage(declaredSteps, maxSteps)),
    { reason: "too-many-steps", declaredSteps, maxSteps },
  );
}

/**
 * Refuse a declared pipeline whose compile throws where the terms are
 * authored, minted or accepted, before the partner spends its setup effort; the
 * accept boundary walks the invitation's element transforms alone. The run
 * compiles again at key realization for terms that skipped both.
 *
 * The class split follows {@link assertFanOutImplemented}: a standardization
 * step throws {@link OperatorConfigError}, an element transform
 * {@link UsageError}; the message names only a recognized function label.
 * The walk is bounded by {@link TRANSFORM_COMPILE_MAX_STEPS} and
 * {@link TRANSFORM_COMPILE_TOTAL_BUDGET_MS}; the grading path's compiles are
 * bounded separately
 * (docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect).
 */
export function assertTransformsCompile(
  terms: LinkageTerms,
  standardization?: Standardization,
  budget: TransformCompileBudget = {},
): void {
  const totalBudgetMs =
    budget.totalBudgetMs ?? TRANSFORM_COMPILE_TOTAL_BUDGET_MS;
  const overCount = stepCountRefusal(
    terms,
    standardization,
    budget.maxSteps ?? TRANSFORM_COMPILE_MAX_STEPS,
  );
  if (overCount !== undefined) throw overCount;
  // Compiled steps are committed only where the whole walk finished, so a later
  // walk cannot resume past a refused one. The engine's pattern cache still
  // outlives a refusal, so only the count bound repeats.
  const pending: PendingCompiledTransforms = new Map();
  // Monotonic: a backward wall-clock step would leave the rest unbounded.
  const startedAt = performance.now();
  for (const transformation of standardization ?? []) {
    if (performance.now() - startedAt >= totalBudgetMs)
      throw new OperatorConfigError(
        stepCompileBudgetRefusalMessage(totalBudgetMs),
      );
    const label = uncompilableStepLabel(transformation.steps, pending);
    if (label !== undefined)
      throw markTransformRefusal(
        new OperatorConfigError(stepCompileRefusalMessage(label)),
        { reason: "uncompilable-step", stepLabel: label },
      );
  }
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      if (performance.now() - startedAt >= totalBudgetMs)
        throw new UsageError(stepCompileBudgetRefusalMessage(totalBudgetMs));
      const label = uncompilableStepLabel(element.transform, pending);
      if (label !== undefined)
        throw markTransformRefusal(
          new UsageError(stepCompileRefusalMessage(label)),
          { reason: "uncompilable-step", stepLabel: label },
        );
    }
  }
  commitCompiledTransforms(pending);
}

/**
 * The linkage fields in `terms` the input `columns` cannot produce. Read off
 * the same {@link resolveFieldColumns} binding {@link buildStandardizedDataset}
 * uses, so this verdict cannot pass a field the builder cannot produce. Pass
 * `metadata` to match an exchange run from an explicit metadata block; omit it
 * for name-based inference, the accept-path default.
 */
export function unsatisfiedLinkageFields(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageField[] {
  return unsatisfiedFieldColumns(columns, terms, standardization, metadata).map(
    ({ field }) => field,
  );
}

/**
 * A linkage field the input cannot produce, beside the column the resolution
 * bound it to and the input lacks, or `undefined` where no column of the
 * field's type is roled for linkage.
 */
export interface UnsatisfiedFieldColumn {
  /** The field the input cannot produce. */
  field: LinkageField;
  /** The column the field is read from, absent from the input. */
  column: string | undefined;
}

/**
 * {@link unsatisfiedLinkageFields}, each field beside the column it expects
 * ({@link UnsatisfiedFieldColumn}).
 */
export function unsatisfiedFieldColumns(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): UnsatisfiedFieldColumn[] {
  const present = new Set(columns);
  const resolution = resolveFieldColumns(
    terms,
    standardization,
    // A column list this is handed, not a read of its own (see resolveExchangeInputs).
    metadata ?? inferMetadata(columns, []),
  );
  return terms.linkageFields.flatMap((field) => {
    const column = resolution.get(field.name)?.column;
    return column === undefined || !present.has(column)
      ? [{ field, column }]
      : [];
  });
}

/**
 * Whether a `parse_date` step's input format lacks a year (`YYYY` or `YY`),
 * `MM` or `DD` token, so {@link parseDateFactory} drops every value. Reads
 * core's own tokenizer ({@link parseDateFormat}) so the verdict cannot drift
 * from the factory. An absent format drops nothing; a non-string one is
 * reported dead without being tokenized.
 */
export function parseDateInputDropsEveryRecord(
  params: Params | undefined,
): boolean {
  const raw = params?.inputFormat;
  if (raw === null || raw === undefined) return false;
  if (typeof raw !== "string") return true;
  const present = new Set(parseDateFormat(raw).order);
  const hasYear = YEAR_FORMAT_TOKENS.some((token) => present.has(token));
  return !hasYear || !present.has("MM") || !present.has("DD");
}

/**
 * The functions whose step never returns null nor empties a candidate set, so
 * only another function can reach a later `coalesce`'s substituting branch. An
 * allowlist, so a new or unrecognized function counts as able to empty a value:
 * overstating a `coalesce`'s reach on a consent screen is the safe direction.
 * Name-only, held to the real functions by a drift test over a value corpus.
 */
const VALUE_PRESERVING_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "remove_non_ascii",
  "replace_separators_with_spaces",
  "squash_spaces",
  "remove_punctuation",
  "remove_dashes",
  "trim_whitespace",
  "to_upper_case",
  "to_lower_case",
  "remove_accents",
  "remove_affixes",
  "pad_left",
  "replace_regex",
  "split_on",
  "coalesce",
]);

/**
 * Whether `step` can leave a realized value empty: the position half of
 * {@link coalesceSubstitutesConstant}.
 *
 * @internal exported for the drift test that checks the classification
 * against the real functions.
 */
export function stepCanEmptyRealizedValue(step: TransformStep): boolean {
  return !VALUE_PRESERVING_FUNCTION_NAMES.has(step.function);
}

/**
 * Whether a `coalesce` at this position substitutes its fallback: its `default`
 * is a string and some step in `precedingSteps` can empty the value
 * ({@link stepCanEmptyRealizedValue}). A pipeline starts from a non-null string
 * and an absent field never runs its pipeline, so the records a substituting
 * coalesce puts on one constant are those an earlier rule emptied. The one
 * predicate {@link pipelineAlwaysDrops} and the consent header both read.
 */
export function coalesceSubstitutesConstant(
  step: TransformStep,
  precedingSteps: ReadonlyArray<TransformStep>,
): boolean {
  return (
    step.function === "coalesce" &&
    typeof step.params?.default === "string" &&
    precedingSteps.some(stepCanEmptyRealizedValue)
  );
}

/**
 * Whether a `substring` step's declared bounds read nothing from a value of any
 * length: `start` is 0 or not an integer, `length` is not an integer or 0, or
 * `length` is negative and the end cannot pass the start for any value. Other
 * negative lengths read a window once the value is long enough, which the data
 * decides. A second reading of {@link substringWindow}, held to it by a
 * differential sweep in `linkageSatisfiability.test.ts`.
 *
 * @internal exported for that sweep and the rescue-equivalence sweep.
 */
export function substringWindowDropsEveryValue(
  params: Params | undefined,
): boolean {
  const start = params?.start;
  const length = params?.length;
  if (typeof start !== "number" || !Number.isInteger(start) || start === 0)
    return true;
  if (typeof length !== "number" || !Number.isInteger(length)) return true;
  if (length > 0) return false;
  return length === 0 || start === -1 || start + length >= 1;
}

/**
 * The dates {@link substringCollapsesParsedDateToConstant} measures a pipeline
 * over. The first two differ in every digit of every component, so a window
 * reading any character the date supplied differs between them; every date is
 * a real calendar date inside the `YY` pivot window. The dates are public, so a
 * declared step that drops one leaves the verdict to the others.
 *
 * @internal exported so a test can name a real probe's rendered value.
 */
export const DATE_COLLAPSE_PROBES: ReadonlyArray<{
  year: string;
  month: string;
  day: string;
}> = [
  { year: "1971", month: "01", day: "02" },
  { year: "2068", month: "12", day: "31" },
  { year: "1990", month: "05", day: "13" },
  { year: "2007", month: "11", day: "24" },
];

// What a compiled run leaves one starting value on. `unread` covers a value over
// {@link MAX_TRANSFORMED_VALUE_LENGTH}, an empty set and an empty string; the
// caller resolves it to the broader breadth word, so an inviter cannot inflate
// one probe to buy a milder marker. A fan-out inside a measured run is also a
// can't-measure.
type MeasuredRunOutcome =
  | { kind: "value"; value: string }
  | { kind: "dropped" }
  | { kind: "candidates" }
  | { kind: "unread" };

// Charges the per-value ceiling and the work budget as the runtime does, but
// not the per-row assembled charge, which one probe cannot reach. A work-budget
// crossing throws, leaving the probe unread
// (docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect).
function runCompiledSteps(
  input: string,
  compiled: ReadonlyArray<CompiledStep>,
  work: TransformWorkMeter,
): MeasuredRunOutcome {
  let current: FieldValue = input;
  for (const step of compiled) {
    current = applyStep(current, step, undefined, undefined, work);
    if (valueOverCeiling(current) !== undefined) return { kind: "unread" };
  }
  return measuredValueOutcome(current);
}

function measuredValueOutcome(current: FieldValue): MeasuredRunOutcome {
  if (current === null) return { kind: "dropped" };
  if (current instanceof Set)
    return current.size > 0 ? { kind: "candidates" } : { kind: "unread" };
  return current === ""
    ? { kind: "unread" }
    : { kind: "value", value: current };
}

/**
 * The functions that read no content: applied to two dates rendered under one
 * output format, they leave values that share a length and are null together.
 * A run built only from these drops every date or none, so an all-probes drop
 * through it is dead rather than data-dependent. A function left out makes the
 * run report a value-dependent drop, the safe side.
 *
 * @internal exported for the drift test, which drives one params shape per
 * function over dates under several output formats; membership stays a review
 * call.
 */
export const LAYOUT_DETERMINED_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "remove_non_ascii",
  "replace_separators_with_spaces",
  "squash_spaces",
  "remove_punctuation",
  "remove_dashes",
  "trim_whitespace",
  "to_upper_case",
  "to_lower_case",
  "remove_accents",
  "substring",
  "pad_left",
  "coalesce",
]);

// What a substring run's measurement over {@link DATE_COLLAPSE_PROBES}
// establishes. `undetermined` (no measurement, or distinct survivors) resolves
// to the milder marker; `cannotMeasure` (a ceiling crossing, a candidate set, a
// throw) resolves up to the collapse word, since understating breadth is the
// harmful direction on a consent screen.
type ParsedDateRunReading =
  | { kind: "collapsed"; value: string }
  | { kind: "valueDependentDrop" }
  | { kind: "layoutDeterminedDrop" }
  | { kind: "undetermined" }
  | { kind: "cannotMeasure" };

const UNDETERMINED: ParsedDateRunReading = { kind: "undetermined" };
const CANNOT_MEASURE: ParsedDateRunReading = { kind: "cannotMeasure" };

/**
 * One element's steps compiled at most once each; a compile failure is held and
 * rethrown on every later ask. Per-step compiles match the whole-array compile,
 * since each factory reads only its own parameters.
 */
function stepCompilerFor(
  steps: ReadonlyArray<TransformStep>,
): (index: number) => CompiledStep {
  const compiled = new Map<
    number,
    { step: CompiledStep } | { failure: unknown }
  >();
  return (index: number): CompiledStep => {
    let held = compiled.get(index);
    if (held === undefined) {
      try {
        held = { step: compileSteps([steps[index]])[0] };
      } catch (failure) {
        held = { failure };
      }
      compiled.set(index, held);
    }
    if ("failure" in held) throw held.failure;
    return held.step;
  };
}

/**
 * The probe values from a `parse_date` up to the run end being read. A
 * probe is `undefined` once a step took it past the per-value ceiling or threw,
 * and stays so for the rest of the span.
 */
interface ParsedDateSpan {
  probes: Array<FieldValue | undefined>;
  /** Whether every step measured so far is in
   * {@link LAYOUT_DETERMINED_FUNCTION_NAMES}. */
  everyStepLayoutDetermined: boolean;
}

/** Whether `index` ends a maximal run of consecutive `substring` steps, whose
 * last link decides the value the run leaves. */
function endsSubstringRun(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): boolean {
  return (
    steps[index].function === "substring" &&
    steps[index + 1]?.function !== "substring"
  );
}

/** The probe values a live `parse_date` lays out; a date the output format
 * cannot render leaves that probe unreadable. */
function openParsedDateSpan(parseDateStep: TransformStep): ParsedDateSpan {
  const rawOutputFormat = parseDateStep.params?.outputFormat;
  const outputFormat =
    typeof rawOutputFormat === "string"
      ? rawOutputFormat
      : DEFAULT_DATE_OUTPUT_FORMAT;
  return {
    probes: DATE_COLLAPSE_PROBES.map((probe) => {
      try {
        return renderDateOutput(
          outputFormat,
          probe.year,
          probe.month,
          probe.day,
        );
      } catch {
        return undefined;
      }
    }),
    everyStepLayoutDetermined: true,
  };
}

/** Apply one measured step to every probe still readable. A refused compile
 * blanks every probe for the rest of the span. */
function advanceParsedDateSpan(
  span: ParsedDateSpan,
  step: TransformStep,
  index: number,
  compiledStep: (index: number) => CompiledStep,
  work: TransformWorkMeter,
): void {
  if (!LAYOUT_DETERMINED_FUNCTION_NAMES.has(step.function))
    span.everyStepLayoutDetermined = false;
  let compiled: CompiledStep;
  try {
    compiled = compiledStep(index);
  } catch {
    span.probes = span.probes.map(() => undefined);
    return;
  }
  span.probes = span.probes.map((value) => {
    if (value === undefined) return undefined;
    try {
      const next = applyStep(value, compiled, undefined, undefined, work);
      return valueOverCeiling(next) === undefined ? next : undefined;
    } catch {
      return undefined;
    }
  });
}

/**
 * What the span's probes leave the window holding at a run end. Dropped probes
 * do not defeat the reading, since the probe dates are public: the survivors
 * decide, and with none the run is a layout-determined or value-dependent drop.
 * An unreadable probe gives `cannotMeasure`, unless two earlier probes already
 * hold distinct values.
 */
function parsedDateSpanReading(span: ParsedDateSpan): ParsedDateRunReading {
  const survivors = new Set<string>();
  for (const value of span.probes) {
    if (value === undefined) return CANNOT_MEASURE;
    const outcome = measuredValueOutcome(value);
    if (outcome.kind === "unread" || outcome.kind === "candidates")
      return CANNOT_MEASURE;
    if (outcome.kind === "value") survivors.add(outcome.value);
    if (survivors.size > 1) return UNDETERMINED;
  }
  const [collapsed] = survivors;
  if (collapsed !== undefined) return { kind: "collapsed", value: collapsed };
  return span.everyStepLayoutDetermined
    ? { kind: "layoutDeterminedDrop" }
    : { kind: "valueDependentDrop" };
}

/**
 * The reading of every substring run of one element, by the index that ends
 * it; an absent index is `undetermined`. A run is measured only where it ends a
 * maximal `substring` run with a `parse_date` ahead whose input format can
 * parse a date; the nearest such `parse_date` laid out the value. One forward
 * pass per span keeps the walk linear in the declared steps
 * (docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect).
 */
function parsedDateRunReadings(
  steps: ReadonlyArray<TransformStep>,
  compiledStep: (index: number) => CompiledStep,
  work: TransformWorkMeter,
): ParsedDateRunReading[] {
  const readings = steps.map(() => UNDETERMINED);
  for (const [parseDateIndex, parseDateStep] of steps.entries()) {
    if (parseDateStep.function !== "parse_date") continue;
    if (parseDateInputDropsEveryRecord(parseDateStep.params)) continue;
    let spanEnd = parseDateIndex + 1;
    while (spanEnd < steps.length && steps[spanEnd].function !== "parse_date")
      spanEnd += 1;
    let lastRunEnd = -1;
    for (let index = parseDateIndex + 1; index < spanEnd; index += 1)
      if (endsSubstringRun(steps, index)) lastRunEnd = index;
    if (lastRunEnd < 0) continue;
    const span = openParsedDateSpan(parseDateStep);
    for (let index = parseDateIndex + 1; index <= lastRunEnd; index += 1) {
      advanceParsedDateSpan(span, steps[index], index, compiledStep, work);
      if (endsSubstringRun(steps, index))
        readings[index] = parsedDateSpanReading(span);
    }
  }
  return readings;
}

/**
 * Whether the `substring` run ending at `index` leaves every record that
 * survives an earlier `parse_date` on one constant, such as a window inside an
 * output format's literal region (`ACME-YYYYMMDD` read as `ACME`). Measured by
 * running the shipped steps over {@link DATE_COLLAPSE_PROBES}, since whether a
 * step preserves what a window reads depends on the window too.
 *
 * True where every surviving probe has one identical non-empty value and the
 * rest of the pipeline keeps it, where no probe survives a run that is not
 * layout-determined, and where the run cannot be measured: understating breadth
 * is the harmful direction on a consent screen. The limit runs toward
 * overstating: a content step that drops real records but passes the probes, or
 * runs before the `parse_date`, is not measured. The consent header's collapse
 * marker in `invitationSummary.ts` reads this.
 */
export function substringCollapsesParsedDateToConstant(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): boolean {
  const compiledStep = stepCompilerFor(steps);
  const work = openTransformWorkMeter();
  const readings = parsedDateRunReadings(steps, compiledStep, work);
  return collapsesAtRunEnd(steps, index, readings[index], compiledStep, work);
}

/**
 * Whether any substring run of `steps` collapses every parsed date onto one
 * constant ({@link substringCollapsesParsedDateToConstant}), over one walk. A
 * caller also asking {@link pipelineAlwaysDrops} uses
 * {@link gradeElementPipeline} to compile each step once for both.
 */
export function pipelineCollapsesParsedDateToConstant(
  steps: ReadonlyArray<TransformStep>,
): boolean {
  return gradeElementPipeline(steps).collapsesParsedDateToConstant();
}

/**
 * Whether the run ending at `index` collapses, resolving its reading against
 * the rest of the pipeline. An unmeasurable run and a value-dependent drop
 * resolve up to the collapse word.
 */
function collapsesAtRunEnd(
  steps: ReadonlyArray<TransformStep>,
  index: number,
  reading: ParsedDateRunReading | undefined,
  compiledStep: (index: number) => CompiledStep,
  work: TransformWorkMeter,
): boolean {
  if (reading === undefined) return false;
  if (reading.kind === "cannotMeasure" || reading.kind === "valueDependentDrop")
    return true;
  if (reading.kind !== "collapsed") return false;
  try {
    const tail = runCompiledSteps(
      reading.value,
      steps
        .slice(index + 1)
        .map((_step, offset) => compiledStep(index + 1 + offset)),
      work,
    );
    // The tail runs on the one collapsed value; only a measured drop
    // withdraws the collapse, and an unmeasurable tail keeps it.
    return tail.kind !== "dropped";
  } catch {
    return true;
  }
}

/**
 * Whether the `substring` run ending at `index` drops every date an earlier
 * `parse_date` can render, such as a window sliced back out of range. Claimed
 * only for a layout-determined run, so the probes represent every date.
 *
 * @internal exported for the rescue-equivalence sweep.
 */
export function substringRunDropsEveryParsedDate(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): boolean {
  return (
    parsedDateRunReadings(
      steps,
      stepCompilerFor(steps),
      openTransformWorkMeter(),
    )[index]?.kind === "layoutDeterminedDrop"
  );
}

/**
 * The transform params a consent verdict reads, by function name: the ones that
 * could push the breadth marker toward a milder word. A consent screen shows
 * them ahead of a step's other params, so a partner cannot push their rows past
 * the display cap. Content steps between the `parse_date` and the run are
 * absent: they can only widen the word. A test requires each listed param to
 * move its verdict; a new param that could soften the marker is a review call.
 */
export const CONSENT_VERDICT_PARAM_NAMES = frozenLookupTable({
  parse_date: ["inputFormat", "outputFormat"] as const,
  substring: ["start", "length"] as const,
  coalesce: ["default"] as const,
} satisfies Record<string, ReadonlyArray<string>>);

/**
 * Whether a pipeline produces no value for any input, from the terms alone. The
 * value-independent drops: a `parse_date` input format missing a component
 * ({@link parseDateInputDropsEveryRecord}), `substring` bounds that open no
 * window ({@link substringWindowDropsEveryValue}), and a layout-determined
 * substring run past every rendered date
 * ({@link substringRunDropsEveryParsedDate}). A later `coalesce` with a string
 * default rescues the drop to a constant key. Value-dependent drops are left to
 * the runtime coverage sweep, so this never calls a producible pipeline dead.
 */
export function pipelineAlwaysDrops(
  steps: ReadonlyArray<TransformStep> | undefined,
): boolean {
  if (steps === undefined) return false;
  return gradeElementPipeline(steps).alwaysDrops();
}

/** The always-drops verdict over readings the caller already has. */
function alwaysDropsGivenRunReadings(
  steps: ReadonlyArray<TransformStep>,
  readings: ReadonlyArray<ParsedDateRunReading>,
): boolean {
  let dropped = false;
  for (const [index, step] of steps.entries()) {
    if (step.function === "coalesce") {
      // The rescue-equivalence sweep in linkageSatisfiability.test.ts checks
      // that the predicate's position half withholds no rescue here.
      if (dropped && coalesceSubstitutesConstant(step, steps.slice(0, index)))
        dropped = false;
      continue;
    }
    if (dropped) continue;
    if (
      (step.function === "parse_date" &&
        parseDateInputDropsEveryRecord(step.params)) ||
      (step.function === "substring" &&
        substringWindowDropsEveryValue(step.params)) ||
      readings[index].kind === "layoutDeterminedDrop"
    )
      dropped = true;
  }
  return dropped;
}

/** One element's two grading verdicts, each measured on first ask. */
export interface ElementPipelineGrading {
  /** See {@link pipelineAlwaysDrops}. */
  alwaysDrops(): boolean;
  /** See {@link pipelineCollapsesParsedDateToConstant}. */
  collapsesParsedDateToConstant(): boolean;
}

/**
 * Both element-level gradings over one compiled-step memo and one forward pass,
 * so the consent header compiles each measured step once for the pair
 * (docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect).
 * Neither verdict is measured unasked.
 */
export function gradeElementPipeline(
  steps: ReadonlyArray<TransformStep>,
): ElementPipelineGrading {
  const compiledStep = stepCompilerFor(steps);
  // One work meter for the element's whole grading pass.
  const work = openTransformWorkMeter();
  let readings: ParsedDateRunReading[] | undefined;
  const runReadings = (): ParsedDateRunReading[] =>
    (readings ??= parsedDateRunReadings(steps, compiledStep, work));
  return {
    alwaysDrops: () => alwaysDropsGivenRunReadings(steps, runReadings()),
    collapsesParsedDateToConstant: () =>
      runReadings().some((reading, index) =>
        collapsesAtRunEnd(steps, index, reading, compiledStep, work),
      ),
  };
}

/** Per-key coverage of an input's columns against linkage terms, for a surface
 * that reports it. Whether a run may proceed is
 * {@link LinkageTermsVerdict.fullySatisfied}. */
interface LinkageSatisfiability {
  /** The linkage fields the columns cannot produce. */
  unsatisfied: LinkageField[];
  /** Keys whose element fields are all satisfiable: the column-shape count,
   * which does not subtract {@link deadKeys}. */
  satisfiableKeyCount: number;
  /**
   * Keys whose columns are present but an element's declared cleaning drops
   * every record ({@link pipelineAlwaysDrops}), so the remedy is the terms, not
   * the CSV. The caller sanitizes the partner-controlled key names.
   */
  deadKeys: LinkageKey[];
}

/**
 * Per-key coverage of `columns` against `terms`, projected from
 * {@link decideLinkageTermsVerdict}. A key is satisfiable only when every
 * element field is declared and producible. Column shape only: a column whose
 * every row standardizes to empty still counts, which can over-claim but never
 * wrongly block. Callers own wording and display sanitization.
 */
export function assessLinkageSatisfiability(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageSatisfiability {
  const verdict = decideLinkageTermsVerdict(
    columns,
    terms,
    standardization,
    metadata,
  );
  return {
    unsatisfied: verdict.unsatisfiedFieldColumns.map(({ field }) => field),
    satisfiableKeyCount: verdict.keys.length - verdict.unsatisfiableKeys.length,
    deadKeys: verdict.deadKeys,
  };
}

/**
 * How one declared linkage key fares against an input's columns:
 * `unsatisfiable` when an element field cannot be produced, `dead` when the
 * fields resolve but an element's cleaning drops every record
 * ({@link pipelineAlwaysDrops}; fixed in the terms, not the input), else
 * `satisfiable`.
 */
export type LinkageKeyFitness = "satisfiable" | "unsatisfiable" | "dead";

/** One declared linkage key and its {@link LinkageKeyFitness}. */
interface GradedLinkageKey {
  key: LinkageKey;
  fitness: LinkageKeyFitness;
}

/**
 * Whether an input may be run under agreed linkage terms, and what a surface
 * needs to say why not: at least one key declared and every key `satisfiable`.
 * No key at all is refused because `linkageTermsFromRuleSet` can narrow to none.
 */
export interface LinkageTermsVerdict {
  /** Whether the input may be run under these terms. */
  fullySatisfied: boolean;
  /** Every declared key with its grade, in declaration order. */
  keys: GradedLinkageKey[];
  /** The declared keys graded `unsatisfiable`, in declaration order. */
  unsatisfiableKeys: LinkageKey[];
  /** The declared keys graded `dead`, in declaration order. */
  deadKeys: LinkageKey[];
  /** The linkage fields the columns cannot produce, each beside the column it
   * expects. Can be empty while keys are unsatisfiable, when an element names an
   * undeclared field. */
  unsatisfiedFieldColumns: UnsatisfiedFieldColumn[];
}

/**
 * Grade `columns` against agreed `terms` and decide whether the run may
 * proceed: the gate in {@link prepareForExchange} and every earlier notice
 * read this. Pass the authored `standardization` and `metadata` (`undefined`
 * where none), so the notice and the gate grade identical inputs.
 */
export function decideLinkageTermsVerdict(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageTermsVerdict {
  const missing = unsatisfiedFieldColumns(
    columns,
    terms,
    standardization,
    metadata,
  );
  const unsatisfiedNames = new Set(missing.map(({ field }) => field.name));
  // Declared and producible. The schema refuses an element naming an undeclared
  // field; this still grades one unsatisfiable for terms built without a parse.
  const producibleNames = new Set(
    terms.linkageFields
      .map((f) => f.name)
      .filter((name) => !unsatisfiedNames.has(name)),
  );
  // Compiles each measured step once (pinned in linkageProbeCost.test.ts).
  const keys: GradedLinkageKey[] = terms.linkageKeys.map((key) => ({
    key,
    fitness: !key.elements.every((e) => producibleNames.has(e.field))
      ? "unsatisfiable"
      : key.elements.some((e) => pipelineAlwaysDrops(e.transform))
        ? "dead"
        : "satisfiable",
  }));
  const withFitness = (fitness: LinkageKeyFitness): LinkageKey[] =>
    keys.filter((graded) => graded.fitness === fitness).map((g) => g.key);
  const unsatisfiableKeys = withFitness("unsatisfiable");
  const deadKeys = withFitness("dead");
  return {
    fullySatisfied:
      keys.length > 0 &&
      unsatisfiableKeys.length === 0 &&
      deadKeys.length === 0,
    keys,
    unsatisfiableKeys,
    deadKeys,
    unsatisfiedFieldColumns: missing,
  };
}

/**
 * Who is held to the terms a shortfall is stated against: `"agreed"` when both
 * parties are, `"draft"` for the operator's own terms before an invitation.
 */
export type LinkageTermsStanding = "agreed" | "draft";

/**
 * One sentence fragment stating which declared keys the input cannot produce
 * and which drop every record, shared by every surface refusing on
 * {@link decideLinkageTermsVerdict}. Fixed copy and counts only, since names are
 * partner content. `standing` is required so each caller states it. Yields
 * nothing for terms declaring no key.
 */
export function summarizeLinkageShortfall(
  verdict: LinkageTermsVerdict,
  standing: LinkageTermsStanding,
): string {
  const total = verdict.keys.length;
  const qualifier = standing === "agreed" ? "agreed " : "";
  const keysPhrase = (count: number): string =>
    total === 1
      ? `the one ${qualifier}linkage key`
      : count === total
        ? `all ${total} ${qualifier}linkage keys`
        : `${count} of the ${total} ${qualifier}linkage keys`;
  const shortfalls: string[] = [];
  if (verdict.unsatisfiableKeys.length > 0)
    shortfalls.push(
      `${keysPhrase(verdict.unsatisfiableKeys.length)} cannot be produced ` +
        "from this input's columns",
    );
  if (verdict.deadKeys.length > 0)
    shortfalls.push(
      `the cleaning declared for ${keysPhrase(verdict.deadKeys.length)} ` +
        "drops every record",
    );
  return shortfalls.join(", and ");
}

/**
 * Fail closed in {@link prepareForExchange}, before anything is sent, on an
 * input that does not fully satisfy the agreed terms
 * ({@link decideLinkageTermsVerdict}), including terms with no key. The remedy
 * is new terms or a conforming input, never a retry. A one-column header adds
 * {@link singleColumnDelimiterClause}.
 *
 * The message contains only fixed copy and counts. Field and key names are partner
 * content, so each category goes raw on a cause link of its own, which the
 * display boundary caps and escapes, and each name is redacted
 * ({@link redactPrivateKeyMaterial}) so a planted marker cannot take the names
 * after it.
 */
export function assertLinkageTermsSatisfiable(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): void {
  const verdict = decideLinkageTermsVerdict(
    columns,
    terms,
    standardization,
    metadata,
  );
  if (verdict.fullySatisfied) return;

  if (verdict.keys.length === 0)
    throw new LinkageTermsUnsatisfiableError(
      "the agreed linkage terms declare no linkage key, so this exchange has " +
        "nothing to match on. Nothing was sent. " +
        singleColumnDelimiterClause(columns.length) +
        "Run it with an input whose columns can supply at " +
        "least one linkage key, or agree terms declaring one with your " +
        "partner and run the exchange under those.",
    );

  const details: string[] = [];
  if (verdict.unsatisfiedFieldColumns.length > 0)
    details.push(
      `unsatisfied linkage fields (${verdict.unsatisfiedFieldColumns.length}): ` +
        verdict.unsatisfiedFieldColumns
          .map(
            ({ field }) =>
              `${redactPrivateKeyMaterial(field.name)} (${field.type})`,
          )
          .join(", "),
    );
  if (verdict.deadKeys.length > 0)
    details.push(
      `linkage keys whose cleaning drops every record ` +
        `(${verdict.deadKeys.length}): ` +
        verdict.deadKeys
          .map((key) => redactPrivateKeyMaterial(key.name))
          .join(", "),
    );
  if (verdict.unsatisfiableKeys.length > 0)
    details.push(
      `linkage keys this input cannot produce ` +
        `(${verdict.unsatisfiableKeys.length}): ` +
        verdict.unsatisfiableKeys
          .map((key) => redactPrivateKeyMaterial(key.name))
          .join(", "),
    );

  throw new LinkageTermsUnsatisfiableError(
    `this input cannot satisfy every linkage key the agreed terms declare: ` +
      `${summarizeLinkageShortfall(verdict, "agreed")}. ` +
      singleColumnDelimiterClause(columns.length) +
      "Nothing was sent. Agree new terms with your partner over the keys " +
      "and fields both files can supply, or run with an input file that " +
      "satisfies the current terms.",
    details.length > 0
      ? { cause: chainDetailCauses(details as [string, ...string[]]) }
      : undefined,
  );
}
