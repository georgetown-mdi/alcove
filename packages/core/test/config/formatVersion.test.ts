import { describe, expect, test } from "vitest";

import {
  declaredFormatVersion,
  formatVersionNeeded,
  newerFormatMemberMessage,
  withoutOldDefaults,
} from "../../src/config/formatVersion";
import type { FormatVersionPolicy } from "../../src/config/formatVersion";

const POLICY: FormatVersionPolicy = {
  current: 3,
  features: [
    { path: ["a"], name: "a", version: 2, oldDefault: false },
    { path: ["nested", "b"], name: "nested.b", version: 3, oldDefault: [] },
    { path: ["c"], name: "c", version: 2 },
  ],
};

describe("formatVersionNeeded", () => {
  test("is 1 for a document using no listed field", () => {
    expect(formatVersionNeeded({ other: true }, POLICY)).toEqual({
      version: 1,
    });
  });

  test("is the highest version among the fields present, naming that field", () => {
    const needed = formatVersionNeeded({ a: true, nested: { b: [1] } }, POLICY);
    expect(needed.version).toBe(3);
    expect(needed.feature?.name).toBe("nested.b");
  });

  test("counts a field present at its old default", () => {
    expect(formatVersionNeeded({ a: false }, POLICY).version).toBe(2);
  });
});

describe("withoutOldDefaults", () => {
  test("leaves out each field holding its old default, nested ones included", () => {
    const document = { a: false, nested: { b: [], kept: 1 }, c: "x" };
    expect(withoutOldDefaults(document, POLICY)).toEqual({
      nested: { kept: 1 },
      c: "x",
    });
    expect(document.a).toBe(false);
  });

  test("keeps a field holding any other value, and one with no old default", () => {
    const document = { a: true, nested: { b: [1] }, c: false };
    expect(withoutOldDefaults(document, POLICY)).toEqual(document);
  });
});

describe("declaredFormatVersion", () => {
  test.each([
    [1, 1],
    ["2", 2],
    ["10", 10],
  ])("reads %j as %j", (value, expected) => {
    expect(declaredFormatVersion(value)).toBe(expected);
  });

  test.each([0, -1, 1.5, "0", "01", "2a", "", null, undefined, {}])(
    "reads %j as no version",
    (value) => {
      expect(declaredFormatVersion(value)).toBeUndefined();
    },
  );
});

describe("newerFormatMemberMessage", () => {
  test("names one field or several, fitted, with the remedy", () => {
    expect(newerFormatMemberMessage("The file", ["x"], "Update.")).toBe(
      'The file has the field "x", which this version of Alcove does not ' +
        "read: it was made by a newer version of Alcove. Update.",
    );
    expect(newerFormatMemberMessage("The file", ["x", "y"], "Update.")).toBe(
      'The file has the fields "x", "y", which this version of Alcove does ' +
        "not read: it was made by a newer version of Alcove. Update.",
    );
    expect(
      newerFormatMemberMessage("The file", ["z".repeat(5000)], "").length,
    ).toBeLessThan(1000);
  });
});
