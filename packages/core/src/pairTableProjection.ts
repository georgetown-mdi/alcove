import { MAX_RECORD_COUNT } from "./connection/frameSize.js";
import { formatCount } from "./utils/formatCount.js";

import type { ResolvedMatching } from "./linkageTermsPolicy.js";

/**
 * What a run resolved to after the terms exchange and before the first round:
 * the matching cardinality, the record counts the pair table's size follows
 * from, and the two output entitlements. Every field comes from authenticated
 * session state; the partner's count is bounded by `recordCountField`
 * (protocolSetup.ts) to {@link MAX_RECORD_COUNT}. {@link runExchange} hands it
 * to `onProtocolConfirmed`, so a front end reads what the run resolved.
 *
 * The entitlements are here because the cardinality alone cannot tell a party
 * whether it receives a result. Extends {@link ResolvedMatching}, the triple
 * the run's outcome and its record also state.
 */
export interface ResolvedRunShape extends ResolvedMatching {
  /** This party's own raw dataset record count. */
  readonly localRecordCount: number;
  /**
   * This party's count as declared on the terms exchange: the raw count times
   * its own fan-out factor (`localFanOutFactor`, fanOutFunctions.ts). Neither
   * party knows the other's raw count, so {@link projectPairTable} multiplies
   * the declared pair.
   */
  readonly localDeclaredRecordCount: number;
  /** The partner's record count as declared on the terms exchange. */
  readonly partnerRecordCount: number;
  /**
   * Whether this party's agreed terms entitle it to the matched result
   * (`output.expectsOutput`). The same predicate gates `heldResult`
   * (exchange.ts). `validateCompatibility` refuses a pair where neither
   * expects output.
   */
  readonly localExpectsOutput: boolean;
  /**
   * Whether this run withholds the partner's half of the association table
   * (`withholdsSenderAssociationTable`, link.ts): the single-pass case where the
   * partner is the sender, expects no output and discloses no payload. False
   * under the cascade.
   */
  readonly partnerAssociationTableWithheld: boolean;
}

/**
 * The projected pair count above which {@link describeResolvedRunShape}
 * composes the pair-table advisory. Advisory only: nothing refuses on it
 * (docs/spec/PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps,
 * which also derives the value).
 */
export const PAIR_TABLE_ADVISORY_MAX_PAIRS = 10_000_000;

/**
 * A run's projected derived pair table: what the two counts multiply to, and
 * whether that product is above {@link PAIR_TABLE_ADVISORY_MAX_PAIRS}.
 */
export interface PairTableProjection {
  /** This party's raw count, named by the advisory when its cleaning fanned out. */
  readonly localRecordCount: number;
  /** This party's declared record count, one factor of the product. */
  readonly localDeclaredRecordCount: number;
  /** The partner's declared record count, the other factor. */
  readonly partnerRecordCount: number;
  /**
   * The exact product of the two declared counts. A `bigint`: two counts at
   * {@link MAX_RECORD_COUNT} multiply past `Number.MAX_SAFE_INTEGER`.
   */
  readonly projectedPairs: bigint;
  readonly exceedsAdvisoryBound: boolean;
}

// The bounds `recordCountField` (protocolSetup.ts) applies to a declared count.
// Fails soft: an advisory is no reason to end an exchange.
function isDeclarableRecordCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0 && count <= MAX_RECORD_COUNT;
}

/**
 * Project the derived pair table's size, or `undefined` unless the cardinality
 * is `many-to-many`, the only one bounded by a product
 * (docs/spec/PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps).
 * Declared times declared, so both parties project the same figure. A worst
 * case, not a prediction.
 */
export function projectPairTable(
  shape: ResolvedRunShape,
): PairTableProjection | undefined {
  if (shape.cardinality !== "many-to-many") return undefined;
  if (
    !isDeclarableRecordCount(shape.localRecordCount) ||
    !isDeclarableRecordCount(shape.localDeclaredRecordCount) ||
    !isDeclarableRecordCount(shape.partnerRecordCount)
  )
    return undefined;
  const projectedPairs =
    BigInt(shape.localDeclaredRecordCount) * BigInt(shape.partnerRecordCount);
  return {
    localRecordCount: shape.localRecordCount,
    localDeclaredRecordCount: shape.localDeclaredRecordCount,
    partnerRecordCount: shape.partnerRecordCount,
    projectedPairs,
    exceedsAdvisoryBound:
      projectedPairs > BigInt(PAIR_TABLE_ADVISORY_MAX_PAIRS),
  };
}

/**
 * State this party's declared `deduplicate`, the partner's, and the resulting
 * cardinality. Only possible after the terms exchange, when the pair exists.
 * The values render as fixed literals, so no partner-authored text is
 * interpolated.
 */
export function describeResolvedMatching(matching: ResolvedMatching): string {
  return (
    "Deduplication as agreed at the terms exchange: you declared deduplicate " +
    `${String(matching.localDeduplicate)}, your partner declared deduplicate ` +
    `${String(matching.partnerDeduplicate)}. This run matches ` +
    `${matching.cardinality}.`
  );
}

// Sentences about a result file follow the entitlements, not the cardinality:
// a party with no output is handed no association table (`heldResult`,
// exchange.ts).
function describeCardinality(shape: ResolvedRunShape): string | undefined {
  switch (shape.cardinality) {
    case "one-to-one":
      return undefined;
    case "many-to-one":
      return (
        "This exchange resolved to many-to-one matching: you keep your " +
        "within-dataset duplicate values, so several of your records can match " +
        "one of your partner's. " +
        (shape.partnerAssociationTableWithheld
          ? "This run withholds your partner's half of the matched-pair " +
            "table, so it learns neither which of its own records matched nor " +
            "how many of yours share a linkage-key value."
          : "For each of its records that matched, your partner learns how " +
            "many of yours share that linkage-key value.")
      );
    case "one-to-many":
      return (
        "This exchange resolved to one-to-many matching: your partner keeps " +
        "its within-dataset duplicate values, so several of its records can " +
        "match one of yours. " +
        (shape.localExpectsOutput
          ? "Your result file has one row per matched pair, so one of " +
            "your records can appear on several rows."
          : "By the agreed terms you receive no result from this run, so " +
            "those pairs land in your partner's result file, where one of " +
            "your records can appear on several rows.")
      );
    case "many-to-many":
      return (
        "This exchange resolved to many-to-many matching: both parties keep " +
        "their within-dataset duplicate values, so one matched value pairs " +
        "every one of your records holding it with every one of your " +
        "partner's. " +
        (shape.localExpectsOutput
          ? "Your result file has one row per matched pair, so it can " +
            "hold far more rows than either party has records."
          : "By the agreed terms you receive no result from this run, so " +
            "those pairs land in your partner's result file, which has " +
            "one row per pair and can hold far more rows than either party " +
            "has records.")
      );
  }
}

// Both factors are the declared counts, so both parties name the same numbers.
// Where this party's cleaning fanned out, a second sentence names its raw rows.
function describePairTableProjection(projection: PairTableProjection): string {
  return (
    `This run projects up to ${formatCount(projection.projectedPairs)} matched ` +
    `pairs: the ${formatCount(projection.localDeclaredRecordCount)} records ` +
    `you declared on the terms exchange times the ` +
    `${formatCount(projection.partnerRecordCount)} your partner declared. ` +
    (projection.localDeclaredRecordCount > projection.localRecordCount
      ? `Your declared count stands for your ` +
        `${formatCount(projection.localRecordCount)} records, each of which ` +
        "your own data cleaning fans out into several candidate values. "
      : "") +
    "That is above the advisory bound of " +
    `${formatCount(PAIR_TABLE_ADVISORY_MAX_PAIRS)} pairs. Nothing refuses on ` +
    "the projection and the exchange continues, but the result has one " +
    "row per pair, so expect a large result and a long run. To bring it down, " +
    "reduce either side's record count or agree terms that do not keep both " +
    "sides' duplicates."
  );
}

/** What a front end renders for a resolved run at the pre-round boundary. */
interface ResolvedRunShapeNotices {
  /**
   * The cardinality and what it means for this party's result and the
   * partner's view, or `undefined` under `one-to-one`.
   */
  readonly cardinalityNotice: string | undefined;
  /**
   * The projected pair count, or `undefined` within
   * {@link PAIR_TABLE_ADVISORY_MAX_PAIRS} or with no product.
   */
  readonly pairTableAdvisory: string | undefined;
}

/**
 * Compose what a front end shows for a resolved run before the first round.
 * Pure: the advisory is each front end's to render
 * (docs/spec/PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps).
 * Both strings are first-party prose over integers, with no partner-authored
 * text.
 */
export function describeResolvedRunShape(
  shape: ResolvedRunShape,
): ResolvedRunShapeNotices {
  const projection = projectPairTable(shape);
  return {
    cardinalityNotice: describeCardinality(shape),
    pairTableAdvisory:
      projection !== undefined && projection.exceedsAdvisoryBound
        ? describePairTableProjection(projection)
        : undefined,
  };
}
