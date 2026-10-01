import { expect, test } from "vitest";

import {
  DistinctValues,
  SCAN_UP_TO_VALUES,
  valueHash,
} from "../../src/utils/distinctValues";

// Two distinct strings sharing a 30-bit hash, found by search so the collided
// path is exercised without a hash of the test's own choosing.
function collidingPair(): [string, string] {
  const seen = new Map<number, string>();
  for (let i = 0; ; i++) {
    const value = String(100_000_000 + i);
    const hash = valueHash(value);
    const held = seen.get(hash);
    if (held !== undefined) return [held, value];
    seen.set(hash, value);
  }
}

const layouts = [
  { name: "indexed", options: {} },
  { name: "scanned first", options: { scanUpTo: SCAN_UP_TO_VALUES } },
  { name: "sharded", options: { shardEntries: 2 } },
] as const;

test.for(layouts)(
  "$name: positions follow first sight and digit strings stay distinct",
  ({ options }) => {
    const distinct = new DistinctValues(options);
    const values = ["012", "12", "0012", "", "12.0", "1e1", "10", "012"];
    expect(values.map((value) => distinct.add(value))).toStrictEqual([
      0, 1, 2, 3, 4, 5, 6, 0,
    ]);
    expect(distinct.size).toBe(7);
    expect(distinct.values).toStrictEqual([
      "012",
      "12",
      "0012",
      "",
      "12.0",
      "1e1",
      "10",
    ]);
    expect(distinct.indexOf("0012")).toBe(2);
    expect(distinct.indexOf("00012")).toBe(-1);
  },
);

test.for(layouts)(
  "$name: equates values exactly where === does",
  ({ options }) => {
    const distinct = new DistinctValues(options);
    const composed = "\u00e9";
    const decomposed = "e\u0301";
    expect(distinct.add(composed)).toBe(0);
    expect(distinct.add(decomposed)).toBe(1);
    expect(distinct.add("x".concat(composed).slice(1))).toBe(0);
  },
);

test.for(layouts)(
  "$name: two values sharing a hash are kept apart",
  ({ options }) => {
    const [first, second] = collidingPair();
    expect(first).not.toBe(second);
    expect(valueHash(first)).toBe(valueHash(second));
    const distinct = new DistinctValues(options);
    for (let i = 0; i < SCAN_UP_TO_VALUES; i++) distinct.add(`pad${i}`);
    const firstAt = distinct.add(first);
    expect(distinct.indexOf(second)).toBe(-1);
    const secondAt = distinct.add(second);
    expect(secondAt).toBe(firstAt + 1);
    expect(distinct.add(first)).toBe(firstAt);
    expect(distinct.add(second)).toBe(secondAt);
    expect(distinct.indexOf(second)).toBe(secondAt);
    expect(distinct.size).toBe(SCAN_UP_TO_VALUES + 2);
  },
);

test("a pair sharing a hash before the scanned values are indexed stays apart once they are", () => {
  const [first, second] = collidingPair();
  const distinct = new DistinctValues({ scanUpTo: SCAN_UP_TO_VALUES });
  distinct.add(first);
  distinct.add(second);
  for (let i = 0; distinct.size < SCAN_UP_TO_VALUES + 1; i++)
    distinct.add(`pad${i}`);
  expect(distinct.indexOf(first)).toBe(0);
  expect(distinct.indexOf(second)).toBe(1);
  expect(distinct.add(second)).toBe(1);
});

test.for(layouts)(
  "$name: agrees with a Map over many digit strings and their padded forms",
  ({ options }) => {
    const distinct = new DistinctValues(options);
    const reference = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) {
      const digits = String((i * 7919) % 6_000);
      for (const value of [digits, digits.padStart(9, "0")]) {
        const expected = reference.get(value) ?? reference.size;
        reference.set(value, expected);
        expect(distinct.add(value)).toBe(expected);
      }
    }
    expect(distinct.size).toBe(reference.size);
    expect(distinct.values).toStrictEqual([...reference.keys()]);
  },
);
