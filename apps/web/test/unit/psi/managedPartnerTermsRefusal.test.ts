import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import { createMessagePipe, exchangeTerms } from "@alcove/core/testing";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
  lastRunSchema,
  parseManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import {
  PARTNER_REFUSED_TERMS_REMEDY,
  TERMS_DIFFERENCE_PROBLEM,
  TERMS_DIFFERENCE_TITLE,
} from "@psi/managed/managedFailureCopy";
import {
  benignRerunOutcome,
  rerunFailureLastRun,
} from "@psi/managed/managedRun";
import {
  classifyManagedRunFailure,
  managedRunFailureFromRecord,
  managedRunRetryable,
} from "@recurring/managedRunLaunchModel";
import {
  lastRunMayHaveSentPayload,
  runHistoryEntries,
} from "@recurring/managedDetailModel";
import { betweenVisitNotice } from "@psi/managed/betweenVisitNotice";
import { deriveManagedFailureTier } from "@psi/managed/managedFailureTiers";
import { failureFor } from "@exchange/useInviterExchange";
import { savedExchangeRow } from "@recurring/savedExchangesModel";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { LinkageTerms } from "@alcove/core";

// A managed exchange whose partner refused its linkage terms at the terms
// exchange: the run records a kind of its own, and the live launch, the next
// visit, the notification, the list row, and the run history state the terms
// refusal and its next step rather than a connection problem.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";

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

/** The responder refuses on the algorithm; the initiator's run is the one its
 * abort ends. */
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

/** The responder declines the initiator's changed legal agreement; the
 * initiator's run is the one its abort ends. */
async function changeNotAccepted(): Promise<Error> {
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
  if (
    initiator.status !== "rejected" ||
    responder.status !== "rejected" ||
    responder.reason !== declined
  )
    throw new Error("expected the responder to decline the change");
  return initiator.reason as Error;
}

function record(
  overrides: Partial<ManagedExchangeRecord> = {},
): ManagedExchangeRecord {
  return {
    schemaVersion: MANAGED_EXCHANGE_SCHEMA_VERSION,
    id: "abc",
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    standingCondition: NO_STANDING_CONDITION,
    ...overrides,
  };
}

const stamped: ManagedExchangeLastRun = {
  at: RUN_AT,
  outcome: "failed",
  failureKind: "partner-refused-terms",
};

const MESSAGE = `${TERMS_DIFFERENCE_PROBLEM.partner} ${PARTNER_REFUSED_TERMS_REMEDY}`;

describe("a managed exchange whose partner refused its linkage terms", () => {
  test("records the partner's refusal as its own kind, whatever the phase", async () => {
    const { partner } = await bothRefusals();
    for (const dataExchangeStarted of [false, true]) {
      const lastRun = rerunFailureLastRun(
        partner,
        Date.parse(RUN_AT),
        false,
        dataExchangeStarted,
      );
      expect(lastRun).toEqual(stamped);
      expect(lastRunSchema.safeParse(lastRun).success).toBe(true);
      expect(benignRerunOutcome(partner, dataExchangeStarted)).toBe(
        "partner-refused-terms",
      );
    }
  });

  test("records a partner that did not accept this party's changed terms as the partner's refusal", async () => {
    const notAccepted = await changeNotAccepted();
    expect(
      rerunFailureLastRun(notAccepted, Date.parse(RUN_AT), false, false),
    ).toEqual(stamped);
    expect(benignRerunOutcome(notAccepted, false)).toBe(
      "partner-refused-terms",
    );
    expect(failureFor("exchange", notAccepted).title).toBe(
      TERMS_DIFFERENCE_TITLE,
    );
  });

  test("this party's own refusal keeps the terms-change kind", async () => {
    const { refused } = await bothRefusals();
    expect(
      rerunFailureLastRun(refused, Date.parse(RUN_AT), false, true),
    ).toEqual({ at: RUN_AT, outcome: "failed", failureKind: "terms-change" });
    expect(benignRerunOutcome(refused, true)).toBeUndefined();
  });

  test("a live launch and the next visit state the refusal and its step, with no retry", async () => {
    const { partner } = await bothRefusals();
    const live = classifyManagedRunFailure(
      partner,
      { atLaunch: record(), afterRun: record() },
      undefined,
      NOW,
      true,
    );
    const recorded = managedRunFailureFromRecord(
      record({ lastRun: stamped }),
      undefined,
      NOW,
    );
    for (const failure of [live, recorded]) {
      if (failure === undefined || failure.kind === "handed-off")
        throw new Error("expected the partner-refused-terms alert");
      expect(failure.kind).toBe("partner-refused-terms");
      expect(failure.title).toBe(TERMS_DIFFERENCE_TITLE);
      expect(failure.message).toBe(MESSAGE);
      expect(managedRunRetryable(failure)).toBe(false);
    }
    // The terms that differ, under the label, as the one-shot alert shows them.
    expect(live.kind !== "handed-off" && live.reportedCause).toBe(
      "Your partner stopped the exchange because the linkage terms differ: " +
        `algorithm mismatch: yours is "psi", your partner's is "psi-c"`,
    );
    expect(
      recorded !== undefined &&
        recorded.kind !== "handed-off" &&
        recorded.reportedCause,
    ).toBeUndefined();
  });

  test("states the refusal in the one-shot alert's own words", async () => {
    const { partner } = await bothRefusals();
    const oneShot = failureFor("exchange", partner);
    expect(oneShot.title).toBe(TERMS_DIFFERENCE_TITLE);
    expect(oneShot.message.startsWith(TERMS_DIFFERENCE_PROBLEM.partner)).toBe(
      true,
    );
  });

  test("names controls the exchange's page offers, not the one-shot seat's", () => {
    expect(PARTNER_REFUSED_TERMS_REMEDY).toContain("Make a terms update");
    expect(PARTNER_REFUSED_TERMS_REMEDY).toContain("Change terms");
    expect(PARTNER_REFUSED_TERMS_REMEDY).not.toContain("Start over");
  });

  test("an unattended run's notification, list row, and history name the state", () => {
    const stored = record({ lastRun: stamped });
    expect(deriveManagedFailureTier(stored, undefined, NOW)).toBe(
      "partner-refused-terms",
    );
    const notice = betweenVisitNotice({
      record: stored,
      local: undefined,
      caughtUpMisses: 0,
      disposition: "failed",
      now: NOW,
    });
    expect(notice?.kind).toBe("partner-refused-terms");
    expect(notice?.title).toBe(TERMS_DIFFERENCE_TITLE);
    expect(notice?.body).toContain("every later window stops the same way");
    expect(notice?.body.endsWith(PARTNER_REFUSED_TERMS_REMEDY)).toBe(true);
    expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
      /^Last run stopped: your partner's run refused your linkage terms \(.*\); agree the terms through a terms update$/,
    );
    const [entry] = runHistoryEntries({ lastRun: stamped });
    expect(entry.failure).toBe("your partner's run refused your linkage terms");
    expect(entry.disclosure).toMatch(/^Nothing was disclosed/);
    expect(lastRunMayHaveSentPayload({ lastRun: stamped })).toBe(false);
  });

  test("a record an earlier build stamped for the same refusal still loads", () => {
    // The shape an earlier build wrote: the refusal recorded as a connection
    // failure, with no kind of its own. It reads unchanged and keeps the
    // connection state it showed before.
    const earlier = JSON.parse(
      JSON.stringify(
        record({
          schemaVersion: "alcove-managed-exchange/v4",
          lastRun: { at: RUN_AT, outcome: "failed", failureKind: "transport" },
        }),
      ),
    ) as unknown;
    const loaded = parseManagedExchangeRecord(earlier);
    expect(loaded.lastRun).toEqual({
      at: RUN_AT,
      outcome: "failed",
      failureKind: "transport",
    });
    expect(managedRunFailureFromRecord(loaded, undefined, NOW)?.kind).toBe(
      "transport",
    );
  });
});
