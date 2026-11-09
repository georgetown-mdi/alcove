import { describe, expect, test } from "vitest";

import { LEDGER_HEADING_INFO } from "@exchange/ledgerHeadingInfo";

describe("the ledger's heading explanations", () => {
  test("the send rows have no explanation, so they render without an info icon", () => {
    expect(LEDGER_HEADING_INFO["You will send"]).toBeUndefined();
    expect(LEDGER_HEADING_INFO["You sent"]).toBeUndefined();
  });

  test("the receive rows name the columns the partner sends", () => {
    expect(LEDGER_HEADING_INFO["You will receive"]).toBe(
      "What you get when the exchange finishes, if anything: the records " +
        "you both hold and any columns your partner sends, or only how many " +
        "records you have in common.",
    );
    expect(LEDGER_HEADING_INFO["You received"]).toBe(
      "What arrived when the exchange finished: the records you both hold " +
        "and any columns your partner sent.",
    );
  });
});
