import { describe, expect, it } from "vitest";

import {
  expectedResultCount,
  expectedResultPairs,
  nulledPopulationRows,
  populationSsn,
} from "../stress/completionPopulation";

describe("the completion run's expected result", () => {
  it("finds the population rows whose SSN the built-in standardization nulls", () => {
    const rows = nulledPopulationRows(2 ** 24 + 2 ** 23);
    expect(rows).toEqual([11_111_111, 23_456_789]);
    expect(rows.map(populationSsn)).toEqual(["111-11-1111", "123-45-6789"]);
  });

  it("leaves a nulled shared row out of each party's result", () => {
    // Ten rows a side, five shared: population rows 5 to 9 are shared, row 7
    // is nulled, and row 12 is nulled in the joiner's own half only.
    const nulledRows = [7, 12];
    expect(expectedResultCount(10, 5, nulledRows)).toBe(4);
    expect([...expectedResultPairs(10, 5, "starter", nulledRows)]).toEqual([
      [6, 0],
      [7, 1],
      [9, 3],
      [10, 4],
    ]);
    expect([...expectedResultPairs(10, 5, "joiner", nulledRows)]).toEqual([
      [1, 5],
      [2, 6],
      [4, 8],
      [5, 9],
    ]);
  });

  it("counts the whole shared half when no shared row is nulled", () => {
    expect(expectedResultCount(4_000, 2_000, nulledPopulationRows(6_000))).toBe(
      2_000,
    );
  });
});
