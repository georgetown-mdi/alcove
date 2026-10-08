import { describe, expect, test } from "vitest";

import { createMessagePipe, exchangeTerms } from "@alcove/core/testing";
import type { LinkageTerms } from "@alcove/core";

import { buildErrorEvent } from "../../src/eventStream";
import { markTermsRefusalRun } from "../../src/termsRefusalRemedy";
import {
  PARTNER_REFUSED_NEXT_STEP,
  exitCodeForError,
  renderFailureForOperator,
} from "../../src/util/exit";

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

/** The responder refuses on the algorithm; the initiator reads its abort. */
async function bothRefusals(): Promise<{ refused: Error; partner: Error }> {
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
  return {
    refused: responder.reason as Error,
    partner: initiator.reason as Error,
  };
}

const CONFIGURED_REFUSED =
  "Agree the linkage terms with your partner: to take on theirs, ask them " +
  "for an update made with alcove update and apply it with alcove apply, or " +
  "change your configuration to match theirs, then run the same command again.";
const CONFIGURED_PARTNER =
  "Agree the linkage terms with your partner: to have them take on yours, " +
  "send them an update made with alcove update for them to apply with alcove " +
  "apply, or change your configuration to match theirs, then run the " +
  "same command again.";
const CONFIGURATION_UNWRITTEN =
  "This run saved its key file but wrote no configuration. Agree the linkage " +
  "terms with your partner, move or remove that key file, then set the " +
  "exchange up again from a fresh invitation with alcove invite or alcove " +
  "accept.";
const QUICK =
  "Agree with your partner on the columns your input files share and the " +
  "--linkage-strategy you both pass, then run again.";

describe("the next step beneath a terms refusal", () => {
  test.each([
    { run: "configured", side: "refused", step: CONFIGURED_REFUSED },
    { run: "configured", side: "partner", step: CONFIGURED_PARTNER },
    {
      run: "configuration-unwritten",
      side: "refused",
      step: CONFIGURATION_UNWRITTEN,
    },
    {
      run: "configuration-unwritten",
      side: "partner",
      step: CONFIGURATION_UNWRITTEN,
    },
    { run: "quick-exchange", side: "refused", step: QUICK },
    { run: "quick-exchange", side: "partner", step: QUICK },
  ] as const)(
    "a $run run where the $side side refused",
    async ({ run, side, step }) => {
      const refusals = await bothRefusals();
      const err = markTermsRefusalRun(refusals[side], run);
      const rendered = renderFailureForOperator(err);
      expect(exitCodeForError(err)).toBe(76);
      expect(rendered.endsWith(`\n${step}`)).toBe(true);
      expect(rendered).not.toContain(PARTNER_REFUSED_NEXT_STEP);
      const event = buildErrorEvent(err, "run");
      expect(event.message).toBe(rendered);
      expect(event.recoveryHint).toBe(true);
    },
  );

  test("a refusal no run recorded itself on takes the configured step", async () => {
    const { partner } = await bothRefusals();
    expect(renderFailureForOperator(partner).endsWith(CONFIGURED_PARTNER)).toBe(
      true,
    );
  });

  test("a step names no dash and no partner value", async () => {
    const { refused, partner } = await bothRefusals();
    for (const err of [refused, partner]) {
      const step = renderFailureForOperator(err).split("\n").at(-1) ?? "";
      expect(step).not.toMatch(/[–—]| - /);
      expect(step).not.toContain("psi-c");
    }
  });
});
