import { prepareForExchange } from "@alcove/core";
import { StandardizedKeyIterable } from "@alcove/core/testing";
import { describe, expect, it } from "vitest";

import {
  expectedResultCount,
  expectedResultPairs,
  nulledPopulationRows,
  populationRow,
  populationSsn,
} from "../stress/completionPopulation";

// The largest population a completion run writes: 2^24 rows a side, the
// joiner's starting half-way into the starter's.
const LARGEST_POPULATION = 2 ** 24 + 2 ** 23;

/**
 * Population rows `k` standardized as a party's input and keyed under the
 * built-in linkage keys a quick exchange infers for its columns: for each key,
 * the value each row builds, or undefined where it builds none.
 */
function builtInKeyValues(rows: readonly number[]): {
  keyNames: string[];
  values: Array<Array<string | undefined>>;
} {
  const columns = ["Person_ID", "SSN", "LastName", "DOB"];
  const records = rows.map((k, i) => {
    const [ssn, lastName, dob] = populationRow(k).split(",");
    return { Person_ID: String(i + 1), SSN: ssn, LastName: lastName, DOB: dob };
  });
  const prepared = prepareForExchange(
    {},
    "population",
    records,
    columns,
    [],
    "direct",
  );
  const keys = prepared.linkageTerms.linkageKeys;
  return {
    keyNames: keys.map((key) => key.name ?? ""),
    values: keys.map((key, keyIndex) => {
      const round = new StandardizedKeyIterable(
        key,
        prepared.dataset,
        rows.length,
        false,
        keyIndex,
        false,
      );
      return rows.map((_, i) => {
        const value = round[i];
        if (value !== undefined && typeof value !== "string")
          throw new Error(`row ${rows[i]} builds several values for a key`);
        return value;
      });
    }),
  };
}

describe("the completion run's expected result", () => {
  it("finds the population rows whose SSN the built-in standardization nulls", () => {
    const rows = nulledPopulationRows(LARGEST_POPULATION);
    expect(rows).toEqual([9_775_565, 10_990_011, 11_102_222, 23_214_467]);
    expect(rows.map(populationSsn)).toEqual([
      "109-87-6543",
      "111-11-1111",
      "111-22-3333",
      "123-45-6789",
    ]);
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

  // The cascade then matches each shared row to itself on the first key and
  // nothing else on any key, which is the result expectedResultCount counts.
  it("gives every row but a nulled one the first built-in key, and no two rows one value on any key", () => {
    const sampled = new Set<number>();
    for (let k = 0; k < 30_000; k++) sampled.add(k);
    for (let k = 30_000; k < LARGEST_POPULATION; k += 1_999) sampled.add(k);
    for (const k of nulledPopulationRows(LARGEST_POPULATION)) sampled.add(k);
    const rows = [...sampled];

    const { keyNames, values } = builtInKeyValues(rows);

    expect(keyNames.length).toBeGreaterThan(1);
    keyNames.forEach((name, keyIndex) => {
      const built = values[keyIndex].filter((value) => value !== undefined);
      expect.soft(new Set(built).size, name).toBe(built.length);
    });
    const withoutFirstKey = rows.filter((_, i) => values[0][i] === undefined);
    expect(withoutFirstKey.sort((a, b) => a - b)).toEqual(
      nulledPopulationRows(LARGEST_POPULATION),
    );
  });
});
