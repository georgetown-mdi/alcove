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

  const REFUSED =
    "Your partner's linkage terms differ from yours, so this exchange " +
    "stopped before any linkage key or data was sent.";
  const PARTNER_REFUSED =
    "Your partner stopped this exchange because your linkage terms differ " +
    "from theirs, before any linkage key or data was sent.";
  const INVITER_STEP =
    "Agree the terms with your partner, then choose Start over with a fresh " +
    "invitation and send your partner the new invitation.";
  const ACCEPTOR_STEP =
    "Ask your partner for a new invitation with the terms you agree on, " +
    "then choose Start over with a fresh invitation to accept it.";

  test.each([
    {
      seat: "inviter",
      side: "responder",
      message: `${REFUSED} ${INVITER_STEP}`,
    },
    {
      seat: "inviter",
      side: "initiator",
      message: `${PARTNER_REFUSED} ${INVITER_STEP}`,
    },
    {
      seat: "acceptor",
      side: "responder",
      message: `${REFUSED} ${ACCEPTOR_STEP}`,
    },
    {
      seat: "acceptor",
      side: "initiator",
      message: `${PARTNER_REFUSED} ${ACCEPTOR_STEP}`,
    },
  ] as const)(
    "the $seat seat's alert ends with its next step ($side)",
    async ({ seat, side, message }) => {
      const failure = failureFor(
        "exchange",
        (await bothFailures())[side],
        undefined,
        "browser",
        seat,
      );
      expect(failure).toMatchObject({
        category: "config",
        title: "Your linkage terms differ from your partner's",
        message,
        settingsCannotResolve: true,
        retry: "withheld",
      });
      expect(failure.message).not.toContain("psi-c");
    },
  );
});
