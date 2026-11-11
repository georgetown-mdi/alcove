// The runtime rules agreed linkage terms are held to, beyond the parsed shape
// (config/linkageTermsSchema.ts). Each is stated once here: the schema refuses a
// document breaking it at parse time, and the exchange re-asserts it over the
// agreed terms.

import { UsageError } from "./errors.js";
import {
  candidateSetUnderStrategyMessage,
  QUOTED_FAN_OUT_FUNCTION_NAMES,
  termsDeclareCandidateSet,
} from "./fanOutFunctions.js";
import { canonicalString, CanonicalEncodingError } from "./utils/canonical.js";
import type {
  LinkageKey,
  LinkageKeyElement,
  LinkageStrategy,
  LinkageTerms,
  PayloadColumn,
} from "./config/linkageTermsSchema.js";
import type { LinkageCardinality } from "./psi/link.js";

/**
 * Which count-only shape rule a `psi-c` terms document breaks. The rule on
 * input metadata lives in `config/metadata.ts`
 * ({@link countOnlyTransmitsColumn}).
 */
export type CountOnlyShapeViolation = "deduplicate" | "payload";

/**
 * The refusal message per count-only shape rule, read by every enforcement
 * point so each states the same thing (docs/spec/PSI_C.md#psi-c). Fixed
 * literals only: a `psi-c` document can arrive on a partner's invitation, and
 * the parse-error path is not sanitized.
 */
export const COUNT_ONLY_SHAPE_REFUSALS: Readonly<
  Record<CountOnlyShapeViolation | "transmittedColumns", string>
> = {
  deduplicate:
    'count-only ("psi-c") linkage terms must set deduplicate to false, ' +
    "because a count-only exchange pairs no records. Set deduplicate to " +
    'false, or set algorithm to "psi".',
  payload:
    'count-only ("psi-c") linkage terms must declare no payload columns, ' +
    "because a count-only exchange reveals only the size of the " +
    "intersection. Remove the payload send and receive columns, or set " +
    'algorithm to "psi".',
  transmittedColumns:
    'a count-only ("psi-c") exchange sends no data columns, but your ' +
    "input's metadata marks one or more columns to send to your partner. " +
    "Clear the payload marking on those columns, or set algorithm to " +
    '"psi".',
};

/**
 * The refusal for a fan-out step in this party's own standardization under
 * `psi-c`, which declares no width a count-only block can be laid out by
 * (docs/spec/PSI_C.md#refusals-under-count-only). `step` names the step's
 * function, matched against the fan-out function list, and the standardization
 * output it cleans, both read off this party's own standardization; without
 * it the message names neither.
 */
export function countOnlyStandardizationFanOutMessage(step?: {
  readonly functionName: string;
  readonly output: string;
}): string {
  const located =
    step === undefined
      ? {
          where: `a ${QUOTED_FAN_OUT_FUNCTION_NAMES} step in your standardization`,
          field: "the field it cleans",
        }
      : {
          where: `the "${step.functionName}" step on standardization output "${step.output}"`,
          field: `"${step.output}"`,
        };
  return (
    `a count-only ("psi-c") exchange cannot run ${located.where}, because ` +
    "the agreed linkage terms do not state how many parts it adds to each " +
    "record. Remove that step, and to match on the parts, add it to the " +
    `transform of the linkage key elements that read ${located.field}; or ` +
    'set algorithm to "psi".'
  );
}

/**
 * The first count-only shape rule a terms document breaks, in the
 * specification's order, or `undefined` (always for a `psi` document). The one
 * reading the schema, the asserts and both front ends share
 * (docs/spec/PSI_C.md#psi-c).
 */
export function countOnlyShapeViolation(
  terms: LinkageTerms,
): CountOnlyShapeViolation | undefined {
  if (terms.algorithm !== "psi-c") return undefined;
  if (terms.deduplicate) return "deduplicate";
  if (
    (terms.payload?.send?.length ?? 0) > 0 ||
    (terms.payload?.receive?.length ?? 0) > 0
  )
    return "payload";
  return undefined;
}

/**
 * Refuse a `psi-c` terms document outside the specified shape, never narrowing
 * or downgrading it, for a document built or mutated without a parse (a parse
 * applies the schema refines). A {@link UsageError}, since on the accept side
 * the values are the partner's.
 */
export function assertCountOnlyTermsShape(terms: LinkageTerms): void {
  const violation = countOnlyShapeViolation(terms);
  if (violation === undefined) return;
  throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS[violation]);
}

/**
 * Whether one `payload` direction is declared present and empty: no column
 * moves this way. An absent direction declares nothing and is treated as
 * disclosure. The one reading the consent summary and the run's disclosure
 * resolution share (`resolveDirectionDisclosesPayload`).
 */
export function declaresNoPayloadColumn(
  direction: ReadonlyArray<PayloadColumn> | undefined,
): boolean {
  return direction !== undefined && direction.length === 0;
}

/**
 * Which linkage strategies realize a deduplicating match. A total table so a
 * new strategy fails the build until it states a verdict; typed `boolean` so
 * each reader's gate is a runtime branch.
 *
 * @internal exported for the tests that drive its readers over every
 * strategy, here and in the web editor's own Generate gate.
 */
export const DEDUPLICATE_IMPLEMENTED_BY_STRATEGY: Record<
  LinkageStrategy,
  boolean
> = {
  cascade: true,
  "single-pass": true,
};

/**
 * Whether an exchange on `strategy` honors a `deduplicate: true` term; the one
 * predicate behind {@link assertDeduplicateImplemented} and the consent
 * summary's `deduplicateApplied`.
 */
export function deduplicateIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Refuse a `deduplicate: true` the document's strategy cannot honor, before
 * matching begins. Both shipped strategies honor it; this is the boundary for
 * one that does not. Reads the whole document so a caller cannot pair one
 * party's `deduplicate` with the other's strategy. A {@link UsageError}, since
 * the refused document may be the partner's.
 */
export function assertDeduplicateImplemented(terms: LinkageTerms): void {
  if (!terms.deduplicate) return;
  if (deduplicateIsImplementedForStrategy(terms.linkageStrategy)) return;
  throw new UsageError(
    "deduplicated matching is not implemented for the linkage strategy these " +
      'terms name: a "deduplicate: true" term would be matched one-to-one ' +
      "rather than honored, so the exchange is refused before matching " +
      "begins. Set linkage_strategy to cascade or single-pass to run a " +
      "deduplicating match, or set deduplicate to false.",
  );
}

/**
 * Which linkage strategies resolve a per-(record, key) candidate set (a
 * fan-out or a fuzzy expansion). The entry also gates the cascade's
 * grouping frames (docs/spec/PROTOCOL.md#per-round-candidacy-under-cascade).
 * A total table, typed `boolean`, so a new strategy refuses a candidate set
 * until its resolution is written
 * (docs/spec/PROTOCOL.md#the-combinations-that-stay-unsupported).
 *
 * @internal exported for the tests that drive its readers over every strategy.
 */
export const CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY: Record<
  LinkageStrategy,
  boolean
> = {
  cascade: true,
  "single-pass": true,
};

/**
 * Whether an exchange on `strategy` resolves a per-(record, key) candidate
 * set, or refuses one at the boundary that would otherwise match it.
 */
export function candidateSetIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Whether an exchange on these terms runs the single-pass link. A count-only
 * (`psi-c`) run declaring `single-pass` runs the count-only rounds instead.
 */
export function runsSinglePassLink(
  terms: Pick<LinkageTerms, "algorithm" | "linkageStrategy">,
): boolean {
  return terms.linkageStrategy === "single-pass" && terms.algorithm !== "psi-c";
}

/**
 * Whether an exchange on these terms resolves the candidate sets their keys
 * declare: a count-only (`psi-c`) exchange always does, over blocks of the
 * declared width (docs/spec/PSI_C.md, Candidate sets under count-only),
 * and a `psi` exchange where its strategy does
 * ({@link candidateSetIsImplementedForStrategy}).
 */
export function termsResolveCandidateSets(
  terms: Pick<LinkageTerms, "algorithm" | "linkageStrategy">,
): boolean {
  return (
    terms.algorithm === "psi-c" ||
    candidateSetIsImplementedForStrategy(terms.linkageStrategy)
  );
}

/**
 * The refusal for a candidate set declared under a strategy that resolves
 * none, or `undefined`
 * (docs/spec/PROTOCOL.md#the-combinations-that-stay-unsupported).
 * Shared by the schema refine and `assertFanOutImplemented`; fixed literals
 * only.
 */
export function termsCandidateSetRefusal(
  terms: LinkageTerms,
): string | undefined {
  if (termsResolveCandidateSets(terms)) return undefined;
  if (!termsDeclareCandidateSet(terms)) return undefined;
  return candidateSetUnderStrategyMessage();
}

/**
 * Which linkage strategies pair the many-to-many cardinality both parties'
 * `deduplicate: true` resolves to
 * (docs/spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching).
 * A total table, typed `boolean`, like
 * {@link DEDUPLICATE_IMPLEMENTED_BY_STRATEGY}.
 *
 * @internal exported for the tests that drive its readers over every
 * strategy.
 */
export const MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY: Record<
  LinkageStrategy,
  boolean
> = {
  cascade: true,
  "single-pass": true,
};

/**
 * Whether an exchange on `strategy` pairs the many-to-many cardinality; the
 * one predicate behind {@link assertBothSidedDeduplicateImplemented} and
 * `singlePassResolves` (`link.ts`).
 */
export function manyToManyIsImplementedForStrategy(
  strategy: LinkageStrategy,
): boolean {
  return MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY[strategy];
}

/**
 * Whether both documents declare `deduplicate` under a strategy that does not
 * pair many-to-many. The one predicate behind
 * {@link assertBothSidedDeduplicateImplemented} and the consent summary's
 * `acceptorDeduplicateRefused`. Reads both documents whole, like
 * {@link assertDeduplicateImplemented}.
 */
export function bothSidedDeduplicateRefused(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): boolean {
  if (!(localTerms.deduplicate && partnerTerms.deduplicate)) return false;
  return !(
    manyToManyIsImplementedForStrategy(localTerms.linkageStrategy) &&
    manyToManyIsImplementedForStrategy(partnerTerms.linkageStrategy)
  );
}

/**
 * Refuse the agreed `(true, true)` pair where either document's strategy does
 * not pair many-to-many, before the first round; symmetric, so both parties
 * stop at the same point. Both shipped strategies pair it; this is the boundary
 * for one that does not. A {@link UsageError}, since it reads the partner's
 * document too.
 */
export function assertBothSidedDeduplicateImplemented(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): void {
  if (!bothSidedDeduplicateRefused(localTerms, partnerTerms)) return;
  const pairing = (
    Object.keys(MANY_TO_MANY_IMPLEMENTED_BY_STRATEGY) as Array<LinkageStrategy>
  )
    .filter(manyToManyIsImplementedForStrategy)
    .sort();
  const oneSidedRemedy =
    "deduplicate to false on one of the two parties to run a many-to-one " +
    "match.";
  throw new UsageError(
    "the linkage strategy these terms name does not match a many-to-many " +
      "cardinality, which is what both parties setting deduplicate to true " +
      "resolves to: each party's records may then group the other's, and the " +
      "strategy this exchange runs pairs one side's grouping only. The " +
      "exchange is refused before matching begins rather than matched to less " +
      "than the terms declare. " +
      (pairing.length > 0
        ? `Set linkage_strategy to ${pairing.join(" or ")} to run the pair, ` +
          `or set ${oneSidedRemedy}`
        : `Set ${oneSidedRemedy}`),
  );
}

/**
 * Every {@link LinkageCardinality}, as a schema's accepted value set. Closed:
 * a reader rejects a cardinality this build does not define.
 */
export const LINKAGE_CARDINALITIES = [
  "one-to-one",
  "one-to-many",
  "many-to-one",
  "many-to-many",
] as const satisfies readonly LinkageCardinality[];

// Read from the local party's side, so the two parties record mirror labels
// (docs/spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching).
function linkageCardinalityFromDeduplicate(
  localDeduplicate: boolean,
  partnerDeduplicate: boolean,
): LinkageCardinality {
  if (localDeduplicate && partnerDeduplicate) return "many-to-many";
  if (localDeduplicate) return "many-to-one";
  if (partnerDeduplicate) return "one-to-many";
  return "one-to-one";
}

/**
 * Both parties' agreed `deduplicate` values and the cardinality they give this
 * party. The values are kept beside the mirrored label, which alone does not
 * say which side declared what.
 */
export interface ResolvedMatching {
  readonly localDeduplicate: boolean;
  readonly partnerDeduplicate: boolean;
  readonly cardinality: LinkageCardinality;
}

/**
 * The {@link ResolvedMatching} for a party holding `localTerms` against a
 * partner presenting `partnerTerms`; the one derivation the run, its outcome
 * and its record read. Applies none of `resolveLinkageCardinality`'s refusals,
 * which its callers pass first.
 */
export function resolvedMatchingFromTerms(
  localTerms: LinkageTerms,
  partnerTerms: LinkageTerms,
): ResolvedMatching {
  return {
    localDeduplicate: localTerms.deduplicate,
    partnerDeduplicate: partnerTerms.deduplicate,
    cardinality: linkageCardinalityFromDeduplicate(
      localTerms.deduplicate,
      partnerTerms.deduplicate,
    ),
  };
}

// Undefined for no swap or a dangling target, which the referential-integrity
// refine reports. Identity matches the element-identifier-uniqueness refine.
function swapPairedElements(
  key: LinkageKey,
): [LinkageKeyElement, LinkageKeyElement] | undefined {
  if (key.swap === undefined) return undefined;
  const [first, second] = key.swap.map((target) =>
    key.elements.find((el) => (el.name ?? el.field) === target),
  );
  if (first === undefined || second === undefined) return undefined;
  return [first, second];
}

// Compared by canonical encoding, as the agreed terms are hashed, so `params`
// key order does not matter. A `params` value the encoding refuses (an integer
// beyond 2^53 passes the schema) counts as differing.
function swapPairDeclaresOneTransform(
  first: LinkageKeyElement,
  second: LinkageKeyElement,
): boolean {
  try {
    return (
      canonicalString(first.transform ?? []) ===
      canonicalString(second.transform ?? [])
    );
  } catch (err) {
    if (err instanceof CanonicalEncodingError) return false;
    throw err;
  }
}

/**
 * Whether the two elements this key's `swap` names declare different
 * transforms, which {@link LinkageTermsSchema} refuses: both parties sort the
 * pair's two values, which compares like with like only under one transform
 * (docs/EXCHANGE_REFERENCE.md#swapped-keys). False for no swap or a dangling
 * target. Exported so authoring can name the fault first.
 */
export function swapPairTransformsDiffer(key: LinkageKey): boolean {
  const paired = swapPairedElements(key);
  return (
    paired !== undefined && !swapPairDeclaresOneTransform(paired[0], paired[1])
  );
}

/**
 * Whether the two elements this key's `swap` names declare different
 * `generateFuzzyComparisons`, refused like {@link swapPairTransformsDiffer}.
 * False for no swap or a dangling target. Exported for `planKeyRead`, which
 * sorts the pair's values as interchangeable.
 */
export function swapPairFuzzyComparisonsDiffer(key: LinkageKey): boolean {
  const paired = swapPairedElements(key);
  return (
    paired !== undefined &&
    paired[0].generateFuzzyComparisons !== paired[1].generateFuzzyComparisons
  );
}
