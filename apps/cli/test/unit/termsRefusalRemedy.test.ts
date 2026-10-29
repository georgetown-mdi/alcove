import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms, inferMetadata } from "@alcove/core";
import { createMessagePipe, exchangeTerms } from "@alcove/core/testing";
import type { LinkageTerms, Metadata } from "@alcove/core";

import { buildErrorEvent } from "../../src/eventStream";
import {
  markQuickExchangeContactColumns,
  quickExchangeContactColumnsLine,
  markTermsRefusalRun,
} from "../../src/termsRefusalRemedy";
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
  "Agree on the linkage terms with your partner: to take on theirs, ask them " +
  "for an update made with alcove update and apply it with alcove apply, or " +
  "change your configuration to match theirs, then run the same command again.";
const CONFIGURED_PARTNER =
  "Agree on the linkage terms with your partner: to have them take on yours, " +
  "send them an update made with alcove update for them to apply with alcove " +
  "apply, or change your configuration to match theirs, then run the " +
  "same command again.";
const ONLINE_INVITATION =
  "Agree on the linkage terms with your partner, then set the exchange up " +
  "again from a fresh invitation with alcove invite or alcove accept.";
const QUICK =
  "Agree with your partner on the columns your input files share and the " +
  "--linkage-strategy you both pass, then run again. A phone, email, street " +
  "number, ZIP, state, or county column in only one of the two files makes " +
  "the terms differ: the party whose file has it removes that column, or " +
  "you agree on the terms through an invitation (alcove invite, then alcove " +
  "accept).";

describe("the next step beneath a terms refusal", () => {
  test.each([
    { run: "configured", side: "refused", step: CONFIGURED_REFUSED },
    { run: "configured", side: "partner", step: CONFIGURED_PARTNER },
    { run: "online-invitation", side: "refused", step: ONLINE_INVITATION },
    { run: "online-invitation", side: "partner", step: ONLINE_INVITATION },
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

  test("a partner that did not accept this party's changed terms takes the partner's step", async () => {
    const agreement = {
      reference: "DUA-1",
      purpose: "research",
      expirationDate: "2099-01-01",
    };
    const declined = new Error("declined");
    const [initiatorConn, responderConn] = createMessagePipe();
    const [initiator, responder] = await Promise.allSettled([
      exchangeTerms(
        initiatorConn,
        "initiator",
        { ...terms, legalAgreement: { ...agreement, reference: "DUA-2" } },
        1,
      ),
      exchangeTerms(
        responderConn,
        "responder",
        { ...terms, legalAgreement: agreement },
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        { onTermsChange: () => Promise.reject(declined) },
      ),
    ]);
    if (initiator.status !== "rejected" || responder.status !== "rejected")
      throw new Error("expected both parties to stop");
    expect(responder.reason).toBe(declined);
    const rendered = renderFailureForOperator(initiator.reason);
    expect(exitCodeForError(initiator.reason)).toBe(76);
    expect(rendered.endsWith(`\n${CONFIGURED_PARTNER}`)).toBe(true);
    expect(rendered).not.toContain(PARTNER_REFUSED_NEXT_STEP);
  });

  type QuickExchangeSide = {
    err: Error;
    metadata: Metadata;
    terms: LinkageTerms;
  };

  const quickExchangeTerms = (
    columns: string[],
  ): { metadata: Metadata; terms: LinkageTerms } => {
    const metadata = inferMetadata(columns, []);
    return { metadata, terms: getDefaultLinkageTerms(undefined, metadata) };
  };

  /** Each party's refusal of a quick exchange between the two headers. */
  async function quickExchangeRefusals(
    initiatorColumns: string[],
    responderColumns: string[],
    responderStrategy?: LinkageTerms["linkageStrategy"],
  ): Promise<[QuickExchangeSide, QuickExchangeSide]> {
    const initiatorSide = quickExchangeTerms(initiatorColumns);
    const responderSide = quickExchangeTerms(responderColumns);
    if (responderStrategy !== undefined)
      responderSide.terms = {
        ...responderSide.terms,
        linkageStrategy: responderStrategy,
      };
    const [initiatorConn, responderConn] = createMessagePipe();
    const [initiator, responder] = await Promise.allSettled([
      exchangeTerms(initiatorConn, "initiator", initiatorSide.terms, 1),
      exchangeTerms(responderConn, "responder", responderSide.terms, 1),
    ]);
    if (initiator.status !== "rejected" || responder.status !== "rejected")
      throw new Error("expected both parties to refuse");
    return [
      { err: initiator.reason as Error, ...initiatorSide },
      { err: responder.reason as Error, ...responderSide },
    ];
  }

  const marked = (side: QuickExchangeSide): string =>
    renderFailureForOperator(
      markQuickExchangeContactColumns(
        markTermsRefusalRun(side.err, "quick-exchange"),
        side.metadata,
        side.terms,
      ),
    );

  test("a ZIP key only one party's terms hold names that party's ZIP column", async () => {
    const shared = ["ssn", "first_name", "last_name", "dob", "phone"];
    for (const zipOnInitiator of [true, false]) {
      const withZip = [...shared, "ZIP Code"];
      const [initiator, responder] = await quickExchangeRefusals(
        zipOnInitiator ? withZip : shared,
        zipOnInitiator ? shared : withZip,
      );
      const [hasZip, lacksZip] = zipOnInitiator
        ? [initiator, responder]
        : [responder, initiator];
      expect(marked(hasZip).split("\n").slice(-2)).toEqual([
        QUICK,
        `Your file's column "ZIP Code" (ZIP code) is matched on. Where your ` +
          "partner's file has no such column, remove it from your file and " +
          "run again, or agree on the terms through an invitation (alcove " +
          "invite, then alcove accept).",
      ]);
      expect(marked(lacksZip).endsWith(`\n${QUICK}`)).toBe(true);
    }
  });

  test("a state or county key only one party's terms hold names that party's columns", async () => {
    const shared = ["ssn", "first_name", "last_name", "dob"];
    const [hasGeography, lacksGeography] = await quickExchangeRefusals(
      [...shared, "State", "County Name"],
      shared,
    );
    expect(marked(hasGeography).split("\n").at(-1)).toBe(
      `Your file's columns "State" (state) and "County Name" (county) are ` +
        "matched on. Where your partner's file has no such column, remove " +
        "that column from your file and run again, or agree on the terms " +
        "through an invitation (alcove invite, then alcove accept).",
    );
    expect(marked(lacksGeography).endsWith(`\n${QUICK}`)).toBe(true);
  });

  test("a street number key only one party's terms hold names only that party's street number column", async () => {
    const shared = ["ssn", "first_name", "last_name", "dob", "zip"];
    const [hasStreetNumber, lacksStreetNumber] = await quickExchangeRefusals(
      [...shared, "House Number"],
      shared,
    );
    expect(marked(hasStreetNumber).split("\n").at(-1)).toBe(
      `Your file's column "House Number" (street number) is matched on. ` +
        "Where your partner's file has no such column, remove it from your " +
        "file and run again, or agree on the terms through an invitation " +
        "(alcove invite, then alcove accept).",
    );
    expect(marked(lacksStreetNumber).endsWith(`\n${QUICK}`)).toBe(true);
  });

  test("a quick exchange refused on its linkage strategy adds no column line", async () => {
    const columns = [
      "ssn",
      "first_name",
      "last_name",
      "dob",
      "ZIP Code",
      "phone",
    ];
    for (const side of await quickExchangeRefusals(
      columns,
      columns,
      "single-pass",
    ))
      expect(marked(side).endsWith(`\n${QUICK}`)).toBe(true);
  });

  test("names only the column a contact key is bound to, not a second one", () => {
    const metadata: Metadata = [
      ...inferMetadata(["first_name", "last_name", "dob", "phone"], []),
      {
        name: "mobile",
        type: "phone_number",
        role: "linkage",
        isPayload: false,
      },
    ];
    const quickTerms = getDefaultLinkageTerms(undefined, metadata);
    const line = quickExchangeContactColumnsLine(
      metadata,
      quickTerms,
      quickTerms.linkageKeys.map((key) => key.name),
    );
    expect(line).toContain(`column "phone" (phone number) is matched on`);
    expect(line).not.toContain("mobile");
  });

  test("a quick exchange over no contact column adds no line", async () => {
    const metadata = inferMetadata(["ssn", "first_name", "last_name"], []);
    const { refused } = await bothRefusals();
    const marked = markQuickExchangeContactColumns(
      markTermsRefusalRun(refused, "quick-exchange"),
      metadata,
      getDefaultLinkageTerms(undefined, metadata),
    );
    expect(renderFailureForOperator(marked).endsWith(`\n${QUICK}`)).toBe(true);
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
