import type { LinkageTerms } from "./linkageTermsSchema.js";
import {
  frozenLookupTable,
  frozenLookupTableEntry,
} from "../utils/frozenLookupTable.js";
import {
  patternConformsToDialect,
  patternWeightedSize,
} from "../utils/linearRegex.js";

// Refuses a partner-supplied transform pattern outside the linear-time
// engine's dialect or over its weighted-size cap at terms validation, before
// either party commits. See
// docs/spec/PROTOCOL.md#transform-regular-expression-dialect and
// docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect.

/**
 * The `params` key for the raw pattern of each standardization function
 * whose descriptor has `tier: "regex"`, a set a parity test keeps equal.
 */
export const REGEX_STEP_PATTERN_PARAM = frozenLookupTable({
  replace_regex: "pattern",
  extract_regex: "pattern",
  filter_regex: "pattern",
  split_on: "delimiter",
});

/**
 * The `params` key for the raw pattern of a step naming the
 * partner-authored `functionName`, or `undefined`, including for a name such
 * as `constructor` that only `Object.prototype` has.
 */
export function regexStepPatternParam(
  functionName: string,
): string | undefined {
  return frozenLookupTableEntry(REGEX_STEP_PATTERN_PARAM, functionName);
}

/**
 * Monotonic-clock budget, in milliseconds, for the conformance walk over one
 * terms set, since keys x elements x steps can make compilation itself a
 * denial of service; patterns left when it runs out are refused. A legitimate
 * terms set finishes in well under a millisecond.
 */
const REGEX_DIALECT_TOTAL_BUDGET_MS = 2000;

/**
 * Upper bound on one pattern's {@link patternWeightedSize}, a count, so the
 * verdict is the same on every machine. See
 * docs/spec/CHANNEL_SECURITY.md#transform-regex-linear-time-dialect.
 */
export const MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE = 1000;

/**
 * The weighted size of in-dialect `pattern` when it exceeds
 * {@link MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE}, or `undefined` when it fits;
 * the one size check the terms gate and the step editor share. Throws on a
 * pattern outside the dialect.
 */
export function transformPatternOverSizeCap(
  pattern: string,
): number | undefined {
  const weightedSize = patternWeightedSize(pattern);
  return weightedSize > MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE
    ? weightedSize
    : undefined;
}

/**
 * The size refusal both the terms gate and the step editor show for a pattern
 * of `weightedSize` over {@link MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE}.
 */
export function transformPatternSizeMessage(weightedSize: number): string {
  return (
    `is too large: its size is ${weightedSize} (compiled instructions times ` +
    "one plus the number of capture groups), over the limit of " +
    `${MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE}. A pattern with fewer or smaller ` +
    "counted repeats, or fewer capture groups, fits"
  );
}

/** Optional overrides for the conformance walk. */
interface RegexDialectBudget {
  /** Overrides {@link REGEX_DIALECT_TOTAL_BUDGET_MS}. */
  totalBudgetMs?: number;
  /**
   * Longest pattern compiled; a longer one is refused on length alone, since
   * compile time is super-linear in length (a ~150 KB pattern takes seconds)
   * and the budget cannot interrupt a compile. The schema passes
   * MAX_TRANSFORM_PATTERN_LENGTH; omitted (unit tests only), none is refused.
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
 * The first reason to refuse a transform pattern in `terms`, or `undefined`:
 * outside the dialect, longer than `budget.maxPatternLength`, over
 * {@link MAX_TRANSFORM_PATTERN_WEIGHTED_SIZE}, or left when the time budget
 * runs out. A pattern that is omitted or not a string is left to the step
 * schema's own checks; `parse_date` is not screened. A refusal contains
 * positions and counts, never a partner-controlled value.
 */
export function findTransformRegexRefusal(
  terms: Pick<LinkageTerms, "linkageKeys">,
  budget: RegexDialectBudget = {},
): TransformRegexRefusal | undefined {
  const totalBudgetMs = budget.totalBudgetMs ?? REGEX_DIALECT_TOTAL_BUDGET_MS;
  const maxPatternLength = budget.maxPatternLength ?? Infinity;
  // Monotonic, so a backward system-clock step cannot leave the walk unbounded.
  const startedAt = performance.now();

  for (const [keyIndex, key] of terms.linkageKeys.entries()) {
    for (const [elementIndex, element] of key.elements.entries()) {
      for (const [stepIndex, step] of (element.transform ?? []).entries()) {
        const paramKey = regexStepPatternParam(step.function);
        if (paramKey === undefined) continue;
        const source = step.params?.[paramKey];
        // Left to transformParamTypes.ts: stringifying here would run a
        // partner-declared `toString`.
        if (typeof source !== "string") continue;

        if (performance.now() - startedAt >= totalBudgetMs)
          return NONCONFORMANT;
        if (source.length > maxPatternLength) return NONCONFORMANT;
        if (!patternConformsToDialect(source)) return NONCONFORMANT;
        const weightedSize = transformPatternOverSizeCap(source);
        if (weightedSize !== undefined)
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
