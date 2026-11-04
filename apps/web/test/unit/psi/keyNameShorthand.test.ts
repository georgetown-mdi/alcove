import { describe, expect, test } from "vitest";

import { DEFAULT_LINKAGE_RULE_SET } from "@alcove/core";

import { KEY_NAME_SHORTHAND_INFO } from "@psi/inviterEditor";

// Short forms a reader takes as written: whole words naming the field.
const PLAIN_WORDS: ReadonlySet<string> = new Set([
  "PHONE",
  "EMAIL",
  "STATE",
  "COUNTY",
]);

/** The short forms in one built-in key name: each capitalized token, and each
 * function call as written, argument included. */
function shortFormsOf(keyName: string): Array<string> {
  const tokens = keyName.match(/\b[A-Z][A-Z0-9]*\b/g) ?? [];
  const calls = keyName.match(/\b[a-z]+\([^)]*\)/g) ?? [];
  return [...tokens.filter((token) => !PLAIN_WORDS.has(token)), ...calls];
}

describe("the key name explanation on Matching keys", () => {
  test("explains every short form a built-in key name uses", () => {
    const explanation = KEY_NAME_SHORTHAND_INFO.explanation;
    const unexplained = new Set<string>();
    for (const key of DEFAULT_LINKAGE_RULE_SET.linkageKeys)
      for (const form of shortFormsOf(key.name)) {
        const found = form.includes("(")
          ? explanation.includes(form)
          : new RegExp(`\\b${form}\\b`).test(explanation);
        if (!found) unexplained.add(form);
      }
    expect([...unexplained]).toEqual([]);
  });

  test("finds the short forms the catalog names its keys with", () => {
    expect(shortFormsOf("ZIP5 + soundex(LN) + FN + DOB")).toEqual([
      "ZIP5",
      "LN",
      "FN",
      "DOB",
      "soundex(LN)",
    ]);
    expect(shortFormsOf("LN + FN + PHONE")).toEqual(["LN", "FN"]);
  });
});
