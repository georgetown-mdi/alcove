import { describe, expect, it } from "vitest";

import { EVENT_TYPES, isEventType } from "../src/events.js";

describe("isEventType", () => {
  it("accepts every listed type", () => {
    expect(EVENT_TYPES.filter((type) => !isEventType(type))).toEqual([]);
  });

  it("refuses a type off the list, a non-string and an inherited name", () => {
    for (const value of ["invented", "", 1, null, undefined, {}, "toString"])
      expect(isEventType(value)).toBe(false);
  });
});
