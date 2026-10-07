import { StandardizedField } from "@alcove/core";

import { isStepValid } from "../standardizationAuthoring";

import type { CSVRow, Standardization } from "@alcove/core";

/**
 * Whole-CSV per-field value coverage. Satisfiability checks a field's shape,
 * never its value, so a pipeline that collapses a field to all-null passes it
 * yet yields no keys, indistinguishable from a real empty intersection; this
 * runs each field's pipeline over every row so the operator sees the collapse
 * before launch. A constant key is not flagged: core drops a key value
 * duplicated within a dataset before the PSI round.
 */

/**
 * Row count beyond which the sweep moves off the main thread; set empirically
 * where a synchronous sweep starts to drop a frame.
 */
export const NON_EMPTY_WORKER_ROW_THRESHOLD = 5000;

/**
 * Total cell-text budget (characters) beyond which the sweep moves off the main
 * thread regardless of row count, since a few very large cells can block it
 * below {@link NON_EMPTY_WORKER_ROW_THRESHOLD}.
 */
export const NON_EMPTY_WORKER_CHAR_THRESHOLD = 2_000_000;

/**
 * Whether a CSV's coverage sweep runs off the main thread. Field count is not
 * known here, so terms with very many linkage fields over one narrow column
 * could still sweep inline.
 */
export function shouldComputeOffThread(
  rawRows: ReadonlyArray<CSVRow>,
): boolean {
  if (rawRows.length > NON_EMPTY_WORKER_ROW_THRESHOLD) return true;
  let chars = 0;
  for (const row of rawRows)
    for (const value of Object.values(row)) {
      chars += value?.length ?? 0;
      if (chars > NON_EMPTY_WORKER_CHAR_THRESHOLD) return true;
    }
  return false;
}

/**
 * The value-coverage result for one linkage field, over the whole CSV.
 * `output` is partner-controlled and must never be rendered raw.
 */
export interface FieldValueCoverage {
  /** The linkage field (transformation `output`) this coverage is for. */
  output: string;
  /** The operator's input column the field's pipeline reads. */
  input: string;
  /** Rows examined -- the full parsed row count. */
  total: number;
  /**
   * Rows whose pipeline yields at least one matchable key. An empty string is a
   * key, distinct from a dropped `null` or empty `Set`; a fan-out `Set` counts
   * once, so the tally never exceeds {@link total}.
   */
  produced: number;
  /** {@link produced} / {@link total} in [0, 1]; 0 when {@link total} is 0. */
  rate: number;
  /**
   * True when the field's coverage is not computed: a step left mid-edit or an
   * over-length regex ({@link isStepValid}), or a pipeline that throws on some
   * row. Must not be read as a 0% collapse.
   */
  unavailable: boolean;
}

/**
 * A per-field coverage tally fed one row at a time, so the batch entry point
 * ({@link computeFieldCoverage}) and the server's streaming pass over a mounted
 * file count identically. Each pipeline compiles once; a field with an invalid
 * step is never compiled, so an over-length regex never reaches the compiler.
 */
interface FieldCoverageAccumulator {
  /**
   * Fold one row into every available field's tally. A field whose pipeline
   * throws on a row becomes `unavailable`, so one bad row never aborts the sweep
   * (nor, server-side, fails the whole request).
   */
  add: (row: CSVRow) => void;
  /** The per-field coverage after every fed row, in the standardization's order. */
  result: () => Array<FieldValueCoverage>;
}

/** Build a {@link FieldCoverageAccumulator} for `standardization`. */
export function createFieldCoverageAccumulator(
  standardization: Standardization,
): FieldCoverageAccumulator {
  // Compiled over an empty backing array: rows come through add(), never by
  // index.
  const fields = standardization.map((transformation) => {
    const steps = transformation.steps ?? [];
    const base = { output: transformation.output, input: transformation.input };
    let field: StandardizedField | null = null;
    if (steps.every(isStepValid)) {
      try {
        field = new StandardizedField(
          transformation.output,
          transformation.input,
          steps,
          [],
        );
      } catch {
        field = null;
      }
    }
    return { ...base, field, produced: 0 };
  });

  let total = 0;
  return {
    add(row: CSVRow): void {
      total++;
      for (const entry of fields) {
        if (entry.field === null) continue;
        try {
          if (entry.field.evaluateRow(row).length > 0) entry.produced++;
        } catch {
          entry.field = null;
          entry.produced = 0;
        }
      }
    },
    result(): Array<FieldValueCoverage> {
      return fields.map((entry) => ({
        output: entry.output,
        input: entry.input,
        total,
        produced: entry.produced,
        rate: total > 0 ? entry.produced / total : 0,
        unavailable: entry.field === null,
      }));
    },
  };
}

/**
 * Compute per-field value coverage over every row. A per-field proxy: it
 * measures the field's own pipeline, not a linkage key's element transforms or
 * composite-key collapse. A blank input still runs the pipeline, so a
 * `coalesce` default raises coverage.
 */
export function computeFieldCoverage(
  rawRows: ReadonlyArray<CSVRow>,
  standardization: Standardization,
): Array<FieldValueCoverage> {
  const accumulator = createFieldCoverageAccumulator(standardization);
  for (const row of rawRows) accumulator.add(row);
  return accumulator.result();
}

/**
 * Whether a computable field over a non-empty CSV produced a key for zero rows.
 */
export function isSilentEmpty(coverage: FieldValueCoverage): boolean {
  return !coverage.unavailable && coverage.total > 0 && coverage.produced === 0;
}
