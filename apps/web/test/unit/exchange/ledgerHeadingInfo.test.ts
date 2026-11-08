import { describe, expect, test } from "vitest";

import { LEDGER_HEADING_INFO } from "@exchange/ledgerHeadingInfo";

describe("the ledger's heading explanations", () => {
  test("the send rows say the columns go only with the records both parties hold", () => {
    expect(LEDGER_HEADING_INFO["You will send"]).toBe(
      "Your partner gets these columns only for the records you both hold.",
    );
    expect(LEDGER_HEADING_INFO["You sent"]).toBe(
      "Your partner got these columns only for the records you both hold.",
    );
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
