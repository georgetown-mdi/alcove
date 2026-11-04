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
 * function name written before a parenthesis. */
function shortFormsOf(keyName: string): Array<string> {
  const tokens = keyName.match(/\b[A-Z][A-Z0-9]*\b/g) ?? [];
  const functions = [...keyName.matchAll(/\b([a-z]+)\(/g)].map(
    (match) => `${match[1]}(`,
  );
  return [...tokens.filter((token) => !PLAIN_WORDS.has(token)), ...functions];
}

describe("the key name explanation on Matching keys", () => {
  test("explains every short form a built-in key name uses", () => {
    const explanation = KEY_NAME_SHORTHAND_INFO.explanation;
    const unexplained = new Set<string>();
    for (const key of DEFAULT_LINKAGE_RULE_SET.linkageKeys)
      for (const form of shortFormsOf(key.name)) {
        const pattern = form.endsWith("(")
          ? new RegExp(`\\b${form.slice(0, -1)}\\(`)
          : new RegExp(`\\b${form}\\b`);
        if (!pattern.test(explanation)) unexplained.add(form);
      }
    expect([...unexplained]).toEqual([]);
  });

  test("finds the short forms the catalog names its keys with", () => {
    expect(shortFormsOf("ZIP5 + soundex(LN) + FN + DOB")).toEqual([
      "ZIP5",
      "LN",
      "FN",
      "DOB",
      "soundex(",
    ]);
    expect(shortFormsOf("LN + FN + PHONE")).toEqual(["LN", "FN"]);
  });
});
