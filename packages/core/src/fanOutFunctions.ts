/**
 * The declared fan-out producers, the per-key width the agreed terms declare,
 * and the effective key count the slot arithmetic is derived from
 * (docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).
 * Kept apart from `standardization.ts`, which re-exports it, so the connection
 * and protocol layers bound a partner frame without importing the pipeline.
 */

import { MAX_LINKAGE_ENTRIES } from "./config/linkageTermsBounds.js";
import type { LinkageKey, LinkageTerms } from "./config/linkageTermsSchema.js";
import { InternalConsistencyError, UsageError } from "./errors.js";
import { fuzzyCandidateCeiling } from "./fuzzyComparisons.js";
import { elementValueWidthBound } from "./keyElementWidth.js";

/**
 * The standardization functions that expand one value into several match
 * candidates. Terms declaring one are refused under a strategy that matches a
 * single value (`assertFanOutImplemented`), and {@link declaredKeyWidth} reads
 * the list for an element's candidate factor. Hand-listed, since the registry
 * cannot tell which factory returns a multi-value `Set`; an unlisted
 * producer's candidates skip the width-bound drop and stay fail-closed
 * (docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).
 * Frozen because the list decides drop versus refusal at run time.
 */
export const FAN_OUT_FUNCTION_NAMES: readonly string[] = Object.freeze([
  "split_on",
]);

// The membership `compileStep` captures per step; separate from the frozen list
// only so a test can treat a listed producer as unlisted.
let listedFanOutFunctions: ReadonlySet<string> = new Set(
  FAN_OUT_FUNCTION_NAMES,
);

/** Whether `functionName` is one of the declared fan-out producers. */
export function isListedFanOutFunction(functionName: string): boolean {
  return listedFanOutFunctions.has(functionName);
}

/** @internal */
export function withNoListedFanOutFunctions<T>(body: () => T): T {
  const previous = listedFanOutFunctions;
  listedFanOutFunctions = new Set();
  try {
    const result = body();
    if (
      typeof (result as { then?: unknown } | null | undefined)?.then ===
      "function"
    ) {
      throw new InternalConsistencyError(
        "withNoListedFanOutFunctions supports synchronous bodies only: the listing is restored when body returns, so an async body would run with it restored",
      );
    }
    return result;
  } finally {
    listedFanOutFunctions = previous;
  }
}

/**
 * The candidates one declared fan-out step contributes to its element's width,
 * also the threshold of the wide-expansion advisory and the
 * {@link localFanOutFactor}. An arbitrary working figure with no privacy or
 * disclosure meaning: raise it on demand, within the exact-double headroom of
 * {@link MAX_EFFECTIVE_KEY_COUNT} the tests pin. A record wider than its key's
 * width is dropped from that key, not refused
 * (docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).
 */
export const FAN_OUT_CANDIDATES_PER_ELEMENT = 20;

/**
 * The ceiling on one key's declared width, equal to the count limb of
 * `MAX_KEY_STRINGS_PER_ROW` so a key no row could assemble is refused before
 * any row is read.
 */
export const MAX_KEY_CANDIDATE_WIDTH = 1024;

/**
 * The ceiling on the sum of a party's per-key widths, its effective key count.
 * Bounding the sum keeps `effectiveKeyCount * MAX_RECORD_COUNT` exact in a
 * double
 * (docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).
 */
export const MAX_EFFECTIVE_KEY_COUNT =
  MAX_LINKAGE_ENTRIES * FAN_OUT_CANDIDATES_PER_ELEMENT;

/**
 * The fan-out function names as the refusals below quote them.
 *
 * @internal shared with `fanOutReachedMatchingRefusal` in
 * `standardization.ts`, which closes on the same recovery.
 */
export const QUOTED_FAN_OUT_FUNCTION_NAMES = FAN_OUT_FUNCTION_NAMES.map(
  (name) => `"${name}"`,
).join(", ");

// The recovery the declared-step refusals share across error classes.
const CANDIDATE_SET_STRATEGY_RECOVERY =
  "Agree linkage terms whose linkage_strategy matches " +
  "several candidates per record, or " +
  `remove the ${QUOTED_FAN_OUT_FUNCTION_NAMES} step, the fuzzy comparison and ` +
  "the swapped key order from the standardization and from every linkage " +
  "key.";

/**
 * The declared-step refusal for a standardization pipeline. `functionName` is
 * matched against {@link FAN_OUT_FUNCTION_NAMES} before it reaches here, so no
 * partner free text is interpolated.
 *
 * @internal composed by `assertFanOutImplemented` in `linkageSatisfiability.ts`.
 */
export function fanOutDeclaredMessage(functionName: string): string {
  return (
    "these linkage terms name a linkage_strategy that matches one value " +
    `per record, but these transforms declare a "${functionName}" step, ` +
    `which turns one value into several. ${CANDIDATE_SET_STRATEGY_RECOVERY}`
  );
}

/**
 * The refusal for a candidate set the linkage keys declare under a strategy
 * that matches a single value. Fixed literals only: the accept path reaches it
 * from a partner's invitation.
 *
 * @internal composed by `termsCandidateSetRefusal` in
 * `linkageTermsPolicy.ts`.
 */
export function candidateSetUnderStrategyMessage(): string {
  return (
    "these linkage terms name a linkage_strategy that matches one value " +
    "per record, but one of their linkage keys turns one value into " +
    `several. ${CANDIDATE_SET_STRATEGY_RECOVERY}`
  );
}

/**
 * The factor a key declaring `swap` multiplies into its width: the receiver
 * assembles the authored order and the swapped one
 * (docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).
 */
export const SWAP_VARIANT_WIDTH_FACTOR = 2;

/**
 * The first declared fan-out producer among `steps`, or `undefined`. Reads the
 * frozen {@link FAN_OUT_FUNCTION_NAMES}, so {@link withNoListedFanOutFunctions}
 * does not affect it.
 */
export function declaredFanOutFunction(
  steps: ReadonlyArray<{ function: string }> | undefined,
): string | undefined {
  return steps?.find((step) => FAN_OUT_FUNCTION_NAMES.includes(step.function))
    ?.function;
}

// Locates a key by position, never by its partner-authored name.
function keySite(keyIndex: number | undefined): string {
  return keyIndex === undefined
    ? "a linkage key"
    : `the linkage key at linkage_keys[${keyIndex}]`;
}

/**
 * The width one linkage key declares, from the agreed terms alone and whatever
 * role this party resolves to: the product of its elements' candidate factors
 * (fan-out, and {@link fuzzyCandidateCeiling} at the
 * {@link elementValueWidthBound}), times {@link SWAP_VARIANT_WIDTH_FACTOR}
 * for a swapped key
 * (docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).
 *
 * @throws {UsageError} if the width exceeds {@link MAX_KEY_CANDIDATE_WIDTH}.
 */
export function declaredKeyWidth(key: LinkageKey, keyIndex?: number): number {
  const verdict = keyWidthOrRefusal(key, keyIndex);
  if ("refusal" in verdict) throw new UsageError(verdict.refusal);
  return verdict.width;
}

// The one derivation behind the parse issue and the raised error.
function keyWidthOrRefusal(
  key: LinkageKey,
  keyIndex?: number,
): { readonly width: number } | { readonly refusal: string } {
  let width = key.swap !== undefined ? SWAP_VARIANT_WIDTH_FACTOR : 1;
  for (const element of key.elements) {
    if (declaredFanOutFunction(element.transform) !== undefined)
      width *= FAN_OUT_CANDIDATES_PER_ELEMENT;
    if (element.generateFuzzyComparisons !== undefined)
      width *= fuzzyCandidateCeiling(
        element.generateFuzzyComparisons,
        elementValueWidthBound(element.transform),
      );
    if (width > MAX_KEY_CANDIDATE_WIDTH)
      return {
        refusal:
          `${keySite(keyIndex)} gives one record more than the ` +
          `${MAX_KEY_CANDIDATE_WIDTH} candidate values one key may hold, ` +
          "because the candidates of its expanding elements multiply. " +
          "Declare the expansion on fewer of the key's elements, or split " +
          "the key into keys of fewer elements.",
      };
  }
  return { width };
}

/**
 * Whether a linkage key declares a candidate set (a fan-out, a fuzzy
 * expansion or a `swap`): {@link declaredKeyWidth} above 1 over the same
 * producers, answered even for terms whose width is refused.
 */
export function keyDeclaresCandidateSet(key: LinkageKey): boolean {
  if (key.swap !== undefined) return true;
  return key.elements.some(
    (element) =>
      declaredFanOutFunction(element.transform) !== undefined ||
      element.generateFuzzyComparisons !== undefined,
  );
}

/**
 * Whether any of a terms document's linkage keys declares a candidate set
 * ({@link keyDeclaresCandidateSet}).
 */
export function termsDeclareCandidateSet(terms: LinkageTerms): boolean {
  return terms.linkageKeys.some(keyDeclaresCandidateSet);
}

/**
 * A party's effective key count: the sum of {@link declaredKeyWidth} over the
 * agreed keys, the same on both parties. Times a declared record count it gives
 * that party's value slots. Local standardization is not read
 * ({@link localFanOutFactor})
 * (docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).
 *
 * @throws {UsageError} if the sum exceeds {@link MAX_EFFECTIVE_KEY_COUNT}.
 */
export function declaredEffectiveKeyCount(terms: LinkageTerms): number {
  const verdict = effectiveKeyCountOrRefusal(terms);
  if ("refusal" in verdict) throw new UsageError(verdict.refusal.message);
  return verdict.effectiveKeyCount;
}

/**
 * A width bound's refusal: the message, and the issue path locating the key by
 * position.
 */
export interface DeclaredWidthRefusal {
  readonly message: string;
  readonly path: ReadonlyArray<string | number>;
}

// A key above MAX_KEY_CANDIDATE_WIDTH is refused before the sum is checked.
function effectiveKeyCountOrRefusal(
  terms: LinkageTerms,
):
  | { readonly effectiveKeyCount: number }
  | { readonly refusal: DeclaredWidthRefusal } {
  let effectiveKeyCount = 0;
  for (const [keyIndex, key] of terms.linkageKeys.entries()) {
    const verdict = keyWidthOrRefusal(key, keyIndex);
    if ("refusal" in verdict)
      return {
        refusal: { message: verdict.refusal, path: ["linkageKeys", keyIndex] },
      };
    effectiveKeyCount += verdict.width;
  }
  if (effectiveKeyCount > MAX_EFFECTIVE_KEY_COUNT)
    return {
      refusal: {
        message:
          `these linkage terms declare ${effectiveKeyCount} candidate value slots ` +
          `per record, more than the ${MAX_EFFECTIVE_KEY_COUNT} an exchange ` +
          "allows. Declare fewer linkage keys, or declare the expanding steps " +
          "on fewer of their elements.",
        path: ["linkageKeys"],
      },
    };
  return { effectiveKeyCount };
}

/**
 * The width refusal for a terms document, or `undefined`: the non-throwing
 * form of {@link declaredEffectiveKeyCount}, for the schema refine.
 */
export function declaredWidthRefusal(
  terms: LinkageTerms,
): DeclaredWidthRefusal | undefined {
  const verdict = effectiveKeyCountOrRefusal(terms);
  return "refusal" in verdict ? verdict.refusal : undefined;
}

/**
 * The factor a party's own standardization multiplies its declared record
 * count by: a local fan-out is declared as extra records, not extra width
 * (docs/spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).
 * `declaresLocalFanOut` covers only the fields a linkage key reads
 * (`StandardizedDataset.declaresFanOut`).
 */
export function localFanOutFactor(declaresLocalFanOut: boolean): number {
  return declaresLocalFanOut ? FAN_OUT_CANDIDATES_PER_ELEMENT : 1;
}
