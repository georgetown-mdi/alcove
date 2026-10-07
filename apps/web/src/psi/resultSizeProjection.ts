/**
 * How large a scheduled run's results file is projected to be, and the size above
 * which this browser keeps none of it ({@link ./parkedResults.ts}). One row per
 * matched pair under every cardinality, so a pair count converts to bytes through
 * the writer's bytes per pair (docs/spec/PROTOCOL.md, The both-sided expansion has
 * no ceiling of its own).
 */

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

/**
 * The largest results file a run with nobody present keeps in this browser; above
 * it nothing is parked or truncated, and the run records that for the next visit.
 * Derived from the intake cap: a result this app would not read back as an input
 * is not one it holds at rest.
 */
export const MAX_PARKED_RESULT_BYTES = MAX_CSV_FILE_BYTES;

/**
 * The widest measured cost of one matched pair in the results file
 * (docs/spec/PROTOCOL.md, The both-sided expansion has no ceiling of its own).
 * The widest, because the projection only warns; the refusal weighs the built file.
 */
export const RESULT_BYTES_PER_PAIR = 41;

/**
 * This party's and the partner's record counts as declared at the terms exchange,
 * so both project the same figure (`projectPairTable` in `@alcove/core`). Only a
 * `many-to-many` run has them: under any other cardinality one record count bounds
 * the table and there is no product to project.
 */
export interface PairTableFactors {
  /** This party's declared record count. */
  local: number;
  /** The partner's declared record count. */
  partner: number;
}

/**
 * The worst-case pairs a run on these terms can produce, every record sharing one
 * linkage value. A `bigint`: the declared counts' bounds admit a product past
 * `Number.MAX_SAFE_INTEGER`.
 */
export function projectedPairs(factors: PairTableFactors): bigint {
  return BigInt(factors.local) * BigInt(factors.partner);
}

/** The bytes a results file holding {@link projectedPairs} rows costs the writer
 * ({@link RESULT_BYTES_PER_PAIR}). */
export function projectedResultBytes(factors: PairTableFactors): bigint {
  return projectedPairs(factors) * BigInt(RESULT_BYTES_PER_PAIR);
}

/** Whether a run on these terms projects a results file this browser would not
 * keep ({@link MAX_PARKED_RESULT_BYTES}). */
export function projectionOverParkedBound(factors: PairTableFactors): boolean {
  return projectedResultBytes(factors) > BigInt(MAX_PARKED_RESULT_BYTES);
}

/** Whether a results file of `bytes` is one this browser keeps, weighed on the
 * built file rather than a projection. */
export function resultFitsParkedBound(bytes: number): boolean {
  return bytes <= MAX_PARKED_RESULT_BYTES;
}
