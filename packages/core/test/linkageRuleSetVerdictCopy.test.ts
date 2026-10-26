import { describe, expect, test } from "vitest";

import { RECORDED_LINKAGE_RULE_SET_CAVEAT } from "../src/consent/consentFacts";

import type { LinkageRuleSetCitationVerdict } from "../src/defaults/builtInLinkageTerms";

/** What the surfaces reading a filed record say beside its rule-set citation. */

const ALL_VERDICTS: ReadonlyArray<LinkageRuleSetCitationVerdict> = [
  "consistent",
  "contradicted",
  "unchecked",
];

describe("RECORDED_LINKAGE_RULE_SET_CAVEAT", () => {
  test("points a record's reader at the verdict instead of denying or restating one", () => {
    // A record's citation is always paired with the writing party's verdict, so
    // the one sentence that serves all three verdicts must neither claim nothing
    // was checked nor count as verification -- and must not put the verdict's own
    // vocabulary on a surface that does not hold the value.
    expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).toContain("exchange record");
    expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).toContain("matching basis");
    expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).not.toContain("has not checked");
    for (const verdict of ALL_VERDICTS)
      expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).not.toContain(verdict);
  });
});
