import { describe, expect, test } from "vitest";

import { termsDeltaSections } from "../src/termsDeltaDisplay";
import type { TermsDelta } from "../src/linkageTermsNegotiation";

const NO_CHANGE: TermsDelta = {
  received: undefined,
  sent: undefined,
  partnerDeduplicate: undefined,
  otherTerms: [],
};

describe("termsDeltaSections", () => {
  test("a delta that differs in nothing has no section", () => {
    expect(termsDeltaSections(NO_CHANGE)).toEqual([]);
  });

  test("shows each part that differs, received columns first and other terms last", () => {
    const sections = termsDeltaSections({
      received: { added: ["county"], removed: ["notes"] },
      sent: { added: [], removed: ["zip"] },
      partnerDeduplicate: { expected: false, presented: true },
      otherTerms: ["algorithm mismatch: local psi, partner psi-c"],
    });
    expect(sections).toEqual([
      {
        kind: "columns",
        label: "columns your partner now sends you",
        columns: ["county"],
      },
      {
        kind: "columns",
        label: "columns your partner no longer sends you",
        columns: ["notes"],
      },
      {
        kind: "columns",
        label:
          "columns you no longer send your partner (your partner decides on this)",
        columns: ["zip"],
      },
      {
        kind: "partnerDeduplicate",
        label: "your partner's deduplicate",
        expected: false,
        presented: true,
      },
      {
        kind: "otherTerms",
        label: "other terms that differ",
        differences: ["algorithm mismatch: local psi, partner psi-c"],
      },
    ]);
  });

  test("keeps the partner's names raw, for the display sink to escape", () => {
    const [section] = termsDeltaSections({
      ...NO_CHANGE,
      received: { added: ["a\u202eb"], removed: [] },
    });
    expect(section).toMatchObject({ columns: ["a\u202eb"] });
  });
});
