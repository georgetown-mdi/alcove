/**
 * The console's one reading of core's linkage-terms verdict: whether a pre-launch
 * screen may proceed, and which refusal it states when it may not. Every
 * pre-launch gate grades through core's `decideLinkageTermsVerdict`, the rule
 * `prepareForExchange` enforces, so no gate can admit a file the run refuses. A
 * screen blocks exactly when {@link linkageRefusalFor} returns a refusal.
 */

import type { LinkageField, LinkageTermsVerdict } from "@alcove/core";

/** Part of every refusal: a file read by the wrong delimiter parses as one column,
 * which satisfies no key. */
interface SingleColumnReading {
  /** Whether the graded read yielded exactly one column, so the copy adds the
   * delimiter remedy ({@link ../components/csvDelimiterChoice.ts}). */
  singleColumn: boolean;
}

/**
 * Why a screen refuses to launch:
 *
 * - `"no-linkable-key"` -- the terms declare no linkage key, reached where they
 *   are derived from the operator's columns and narrowed to none; the remedy is a
 *   file holding the field types the built-in keys need.
 * - `"shortfall"` -- the input cannot satisfy a declared key (missing fields, or
 *   cleaning drops every record); the remedy is a conforming input or terms fixed
 *   with the partner.
 */
export type LinkageRefusal = SingleColumnReading &
  (
    | {
        kind: "no-linkable-key";
        /** The linkage fields to name as missing. */
        missingFields: ReadonlyArray<LinkageField>;
      }
    | {
        kind: "shortfall";
        /** The verdict the shortfall is phrased from, so stated counts come
         * from core. */
        verdict: LinkageTermsVerdict;
      }
  );

/**
 * The refusal a verdict holds, or `undefined` when it permits the run.
 * `missingFields` comes from the caller: a screen whose terms were narrowed to its
 * columns passes the unnarrowed rule set's fields, since its verdict reports none.
 * `columns` are those the verdict was graded over.
 */
export function linkageRefusalFor(
  verdict: LinkageTermsVerdict,
  missingFields: ReadonlyArray<LinkageField>,
  columns: ReadonlyArray<string>,
): LinkageRefusal | undefined {
  if (verdict.fullySatisfied) return undefined;
  const singleColumn = columns.length === 1;
  return verdict.keys.length === 0
    ? { kind: "no-linkable-key", missingFields, singleColumn }
    : { kind: "shortfall", verdict, singleColumn };
}
