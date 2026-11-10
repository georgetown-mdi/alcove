import { describe, expect, it } from "vitest";

import { EVENT_TYPES, isEventType, isProgressPercent } from "../src/events.js";

describe("isProgressPercent", () => {
  it("accepts an integer from 0 to 100", () => {
    for (const value of [0, 1, 42, 99, 100])
      expect(isProgressPercent(value)).toBe(true);
  });

  it("refuses any other value", () => {
    for (const value of [
      -1,
      101,
      4.5,
      Number.NaN,
      Infinity,
      "42",
      null,
      true,
      undefined,
      {},
    ])
      expect(isProgressPercent(value)).toBe(false);
  });
});

describe("isEventType", () => {
  it("accepts every listed type", () => {
    expect(EVENT_TYPES.filter((type) => !isEventType(type))).toEqual([]);
  });

  it("refuses a type off the list, a non-string and an inherited name", () => {
    for (const value of ["invented", "", 1, null, undefined, {}, "toString"])
      expect(isEventType(value)).toBe(false);
  });
});
