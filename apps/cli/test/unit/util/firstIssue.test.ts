import { describe, expect, test } from "vitest";

import { firstIssue } from "../../../src/util/firstIssue";

describe("firstIssue", () => {
  test("coerces a symbol path segment instead of throwing", () => {
    const err = {
      issues: [{ path: ["a", Symbol("b"), "c"], message: "invalid" }],
    };
    expect(() => firstIssue(err)).not.toThrow();
    expect(firstIssue(err)).toBe("a.Symbol(b).c: invalid");
  });
});
