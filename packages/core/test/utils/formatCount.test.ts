import { expect, test } from "vitest";

import { formatCount } from "../../src/utils/formatCount";

test("formatCount groups digits in threes with ASCII commas", () => {
  expect(formatCount(0)).toBe("0");
  expect(formatCount(999)).toBe("999");
  expect(formatCount(1_234_567)).toBe("1,234,567");
  expect(formatCount(-1_234)).toBe("-1,234");
  expect(formatCount(12_345_678_901n)).toBe("12,345,678,901");
});

test("formatCount keeps a fraction to three places rather than truncating", () => {
  expect(formatCount(0.15)).toBe("0.15");
  expect(formatCount(1_234.5678)).toBe("1,234.568");
});

test("formatCount writes a non-finite number in ASCII", () => {
  expect(formatCount(Number.POSITIVE_INFINITY)).toBe("Infinity");
  expect(formatCount(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
  expect(formatCount(Number.NaN)).toBe("NaN");
});
