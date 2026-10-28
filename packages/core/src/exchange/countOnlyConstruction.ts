// The construction a count-only (`psi-c`) run builds: `single-key`, the
// shipped one-key round under the library's cardinality mode, or
// `every-key`, every agreed key's round under the sender's permutation
// (docs/spec/PROTOCOL.md, PSI-C). Both parties must run the same one, since
// their frames differ. No operator reaches `every-key`: the option key below
// is exported from no package entry point, which
// packages/core/test/exchange/countOnlyConstructionReach.test.ts holds.

/** A count-only construction. */
export type CountOnlyConstruction = "single-key" | "every-key";

/**
 * The key of the run option selecting the count-only construction.
 *
 * @internal
 */
export const COUNT_ONLY_CONSTRUCTION: unique symbol = Symbol(
  "countOnlyConstruction",
);
