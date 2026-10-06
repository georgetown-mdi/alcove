import { describe, expect, test } from "vitest";

import { rotatedKeyExpires } from "../../src/config/keyFile";
import { MS_PER_DAY } from "../../src/utils/msPerDay";

const ROTATED_AT = Date.parse("2026-03-01T12:00:00.000Z");

describe("rotatedKeyExpires", () => {
  test("stamps the rotation moment plus the policy's days", () => {
    expect(rotatedKeyExpires(30, ROTATED_AT)).toBe("2026-03-31T12:00:00.000Z");
    expect(Date.parse(rotatedKeyExpires(1, ROTATED_AT)) - ROTATED_AT).toBe(
      MS_PER_DAY,
    );
  });

  test.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a policy age of %s, which is not a positive integer",
    (days) => {
      expect(() => rotatedKeyExpires(days, ROTATED_AT)).toThrow(RangeError);
      expect(() => rotatedKeyExpires(days, ROTATED_AT)).toThrow(
        /must be a positive integer/,
      );
    },
  );

  test("refuses an age whose expiry leaves the four-digit-year range", () => {
    // 5,000,000 days is a valid Date but past year 9999; 100,000,000 days
    // leaves the Date range altogether.
    for (const days of [5_000_000, 100_000_000])
      expect(() => rotatedKeyExpires(days, ROTATED_AT)).toThrow(
        /outside the supported date range/,
      );
  });
});
