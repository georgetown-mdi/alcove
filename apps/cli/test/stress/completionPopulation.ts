import {
  getDefaultLinkageTerms,
  getDefaultStandardization,
} from "@alcove/core";

// The completion run's synthetic population and the result a run with no size
// limit returns over it, apart from the run so a unit test can hold them.

/** The SSN of population row `k`, one distinct value a row. */
export function populationSsn(k: number): string {
  const digits = String(100_000_000 + k);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/**
 * The SSNs the built-in standardization nulls, read off its `null_if` steps
 * for the `ssn` field, so the population rows holding one match on no key.
 */
export function builtInNulledSsns(): string[] {
  const terms = getDefaultLinkageTerms(undefined);
  const standardization = getDefaultStandardization(
    [{ name: "SSN", type: "ssn", role: "linkage", isPayload: false }],
    terms,
  );
  const nulled: string[] = [];
  for (const transformation of standardization) {
    if (transformation.output !== "ssn") continue;
    for (const step of transformation.steps ?? []) {
      if (step.function !== "null_if") continue;
      const { value, values } = step.params ?? {};
      if (typeof value === "string") nulled.push(value);
      if (Array.isArray(values))
        for (const v of values) if (typeof v === "string") nulled.push(v);
    }
  }
  return nulled;
}

/**
 * The population rows below `populationSize` whose SSN the built-in
 * standardization nulls.
 */
export function nulledPopulationRows(populationSize: number): number[] {
  return builtInNulledSsns()
    .filter((ssn) => /^\d{9}$/.test(ssn))
    .map((ssn) => Number(ssn) - 100_000_000)
    .filter((k) => k >= 0 && k < populationSize)
    .sort((a, b) => a - b);
}

/**
 * How many rows a party's result holds when `rows` records a side are
 * exchanged: the starter's input is population rows 0 to rows - 1 and the
 * joiner's starts at `shared`, so the shared rows are population rows
 * `shared` to rows - 1, less any in `nulledRows`.
 */
export function expectedResultCount(
  rows: number,
  shared: number,
  nulledRows: readonly number[],
): number {
  return (
    rows - shared - nulledRows.filter((k) => k >= shared && k < rows).length
  );
}

/**
 * The rows of a party's result, in the order of its own 1-based Person_ID,
 * over the shared rows {@link expectedResultCount} counts. A result row is the
 * party's own Person_ID, then the partner's 0-based row index.
 */
export function* expectedResultPairs(
  rows: number,
  shared: number,
  party: "starter" | "joiner",
  nulledRows: readonly number[],
): Generator<[number, number]> {
  for (let j = 0; j < rows - shared; j++) {
    if (nulledRows.includes(shared + j)) continue;
    yield party === "starter" ? [shared + j + 1, j] : [j + 1, shared + j];
  }
}
