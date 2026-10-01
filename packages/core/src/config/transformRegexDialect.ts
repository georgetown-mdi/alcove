import type { LinkageTerms } from "./linkageTermsSchema.js";
import {
  frozenLookupTable,
  frozenLookupTableEntry,
} from "../utils/frozenLookupTable.js";
import {
  patternConformsToDialect,
  patternWeightedSize,
} from "../utils/linearRegex.js";

// --- Transform-regex dialect conformance -------------------------------------
//
// A linkage-key transform step (replace_regex, extract_regex, filter_regex,
// split_on) compiles a partner-supplied pattern and runs it per row (see
// standardization.ts). The pattern arrives in the invitation token, which
// carries a transcription checksum only, not an authenticity guarantee.
//
// Patterns run on the linear-time engine (utils/linearRegex.ts), which
// closes catastrophic backtracking. What remains is dialect conformance and
// size: a pattern outside the engine's dialect, or over the weighted-size cap
// that bounds its per-row cost, is rejected at terms validation, before
// either party commits to terms. Fail closed. Normative dialect:
// docs/spec/PROTOCOL.md ("Transform regular-expression dialect").
//
// parse_date is not screened: its regex is library-generated and always
// in-dialect, and its format-length cap bounds its size.

/**
 * Which `params` key carries the raw partner-controlled pattern for each
 * raw-pattern standardization function. These are exactly the functions whose
 * descriptor in {@link STANDARDIZATION_FUNCTION_DESCRIPTORS} carries
 * `tier: "regex"`; a parity test pins the two together so neither can gain or
 * lose a member without the other.
 */
export const REGEX_STEP_PATTERN_PARAM = frozenLookupTable({
  replace_regex: "pattern",
  extract_regex: "pattern",
  filter_regex: "pattern",
  split_on: "delimiter",
});

/**
 * The `params` key holding the raw pattern of a step naming `functionName`, or
 * `undefined` where the function has none. The read path for a name that is not
 * a literal: the function name is partner-authored free text, and this answers
 * a name reaching only `Object.prototype` (`constructor`, `toString`) with
 * `undefined`.
 */
export function regexStepPatternParam(
  functionName: string,
): string | undefined {
  return frozenLookupTableEntry(REGEX_STEP_PATTERN_PARAM, functionName);
}

/**
 * Total time budget, in milliseconds, measured on the monotonic clock,
 * for checking dialect conformance across all transform patterns in
 * one linkage-terms validation. Each collection caps at 256 entries,
 * but their product (keys x elements x steps) is large enough that
 * a hostile counterparty could make compilation itself a denial of
 * service. Once exhausted, remaining patterns are rejected closed (see
 * {@link findTransformRegexRefusal}). A legitimate terms
 * set finishes in well under a millisecond.
 */
const REGEX_DIALECT_TOTAL_BUDGET_MS = 2000;

/**
 * Upper bound on one transform pattern's weighted size
 * ({@link patternWeightedSize}): instruction count times one plus the
 * capture-group count. A count, so the verdict is the same on every machine.
 * Calibrated against measured per-row cost: docs/spec/CHANNEL_SECURITY.md,
 * "Transform-regex linear-time dialect".
 */
export const MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE = 1000;

/** Optional overrides for the conformance walk; both defaulted. Exposed so tests
 * can drive the budget-exhaustion path deterministically, and so the schema can
 * pass the source-length bound the gate rejects at. */
interface RegexDialectBudget {
  /** Total time budget across all patterns, measured on the monotonic
   * clock; see {@link REGEX_DIALECT_TOTAL_BUDGET_MS}. */
  totalBudgetMs?: number;
  /**
   * Upper bound on the length of any one declared pattern; a longer source is
   * rejected on length alone, without compiling, since an in-dialect source
   * can compile in time super-linear in its length (a ~150 KB pattern takes
   * seconds) and the time budget above cannot interrupt mid-compile.
   * The schema passes its own MAX_TRANSFORM_PATTERN_LENGTH here so both
   * reject at the same threshold; omitted (unit tests only), every source is
   * compiled.
   */
  maxPatternLength?: number;
}

/** Why {@link findTransformRegexRefusal} refused a terms set. */
export type TransformRegexRefusal =
  /** Outside the dialect, over the source-length bound, or left unchecked
   * when the time budget ran out. */
  | { reason: "nonconformant" }
  /** In the dialect but over {@link MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE}. */
  | {
      reason: "size";
      keyIndex: number;
      elementIndex: number;
      stepIndex: number;
      /** The step param holding the pattern: a {@link REGEX_STEP_PATTERN_PARAM} value. */
      paramKey: string;
      weightedSize: number;
    };

const NONCONFORMANT: TransformRegexRefusal = Object.freeze({
  reason: "nonconformant",
});

/**
 * The first reason to refuse a linkage-key transform pattern in `terms`, or
 * `undefined` to admit them all. Refuses a pattern outside the linear-time
 * dialect, one longer than `budget.maxPatternLength` (on length alone, before
 * compiling), one whose weighted size exceeds
 * {@link MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE}, and -- fail closed -- every
 * pattern left when the time budget runs out. Checks the pattern the factory
 * would compile -- the text a step declares, which is what a factory's text
 * accessor admits -- so the verdict matches what executes. A pattern that is
 * omitted, or declared as any other type, is skipped here and refused by the
 * step schema's own checks ({@link transformParamAbsenceRefusals} and
 * {@link transformParamTypeRefusals}); `parse_date` is not screened.
 *
 * A refusal holds positions and counts, never a partner-controlled value, so
 * the caller's message locates the offending pattern rather than echoing it.
 */
export function findTransformRegexRefusal(
  terms: Pick<LinkageTerms, "linkageKeys">,
  budget: RegexDialectBudget = {},
): TransformRegexRefusal | undefined {
  const totalBudgetMs = budget.totalBudgetMs ?? REGEX_DIALECT_TOTAL_BUDGET_MS;
  const maxPatternLength = budget.maxPatternLength ?? Infinity;
  // performance.now() rather than the wall clock: a backward system-clock step
  // during the walk (an NTP correction, a container resuming) makes the
  // difference negative and leaves the remaining patterns unbounded, which is
  // the fail-open direction for a bound on compile cost.
  const startedAt = performance.now();

  for (const [keyIndex, key] of terms.linkageKeys.entries()) {
    for (const [elementIndex, element] of key.elements.entries()) {
      for (const [stepIndex, step] of (element.transform ?? []).entries()) {
        const paramKey = regexStepPatternParam(step.function);
        if (paramKey === undefined) continue;
        const source = step.params?.[paramKey];
        // A pattern this walk cannot read is left to the step schema's own
        // checks, which raise their own issue whatever this walk returns: an
        // omitted one to the required-param check and one of another type to
        // the declared-type check (both in transformParamTypes.ts). Rendering
        // one to a string here would run a `toString` the partner declared,
        // which throws out of a safe parse when it is not callable.
        if (typeof source !== "string") continue;

        if (performance.now() - startedAt >= totalBudgetMs)
          return NONCONFORMANT;
        // Reject an oversized source on length alone, before compiling: an
        // in-dialect source compiles in time super-linear in its length, and
        // the time budget above cannot interrupt one in-flight compile.
        // The per-step length refine reports the same rejection with a
        // precise over-length message (MAX_TRANSFORM_PATTERN_LENGTH).
        if (source.length > maxPatternLength) return NONCONFORMANT;
        if (!patternConformsToDialect(source)) return NONCONFORMANT;
        const weightedSize = patternWeightedSize(source);
        if (weightedSize > MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE)
          return {
            reason: "size",
            keyIndex,
            elementIndex,
            stepIndex,
            paramKey,
            weightedSize,
          };
      }
    }
  }
  return undefined;
}
