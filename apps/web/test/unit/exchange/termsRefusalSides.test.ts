import { describe, expect, test } from "vitest";

import { createMessagePipe, exchangeTerms } from "@alcove/core/testing";

import { failureFor } from "@exchange/useInviterExchange";

import type { LinkageTerms } from "@alcove/core";

// A browser exchange the linkage terms stop: each party's alert states the
// difference from its own side. The responder refuses on the algorithm, and the
// initiator meets that refusal through the responder's abort.

const terms: LinkageTerms = {
  version: "1.0.0",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

async function bothFailures(): Promise<{
  initiator: unknown;
  responder: unknown;
}> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const [initiator, responder] = await Promise.allSettled([
    exchangeTerms(initiatorConn, "initiator", terms, 1),
    exchangeTerms(
      responderConn,
      "responder",
      { ...terms, algorithm: "psi-c" },
      1,
    ),
  ]);
  if (initiator.status !== "rejected" || responder.status !== "rejected")
    throw new Error("expected both parties to refuse");
  return { initiator: initiator.reason, responder: responder.reason };
}

describe("a terms refusal at each seat", () => {
  test("names this party's value as its own and the partner's as the partner's", async () => {
    const { initiator, responder } = await bothFailures();
    expect(failureFor("exchange", initiator).reportedCause).toBe(
      "Your partner stopped the exchange because the linkage terms differ: " +
        `algorithm mismatch: yours is "psi", your partner's is "psi-c"`,
    );
    expect(failureFor("exchange", responder).reportedCause).toBe(
      "linkage terms are incompatible: " +
        `algorithm mismatch: yours is "psi-c", your partner's is "psi"`,
    );
  });
});
