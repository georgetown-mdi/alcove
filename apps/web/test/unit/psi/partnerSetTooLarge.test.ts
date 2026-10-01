import {
  RoundCapacityError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
  lastRunSchema,
} from "@psi/managed/managedExchangeRecord";
import {
  benignRerunOutcome,
  remapLapsedRunFailure,
  rerunFailureLastRun,
} from "@psi/managed/managedRun";
import {
  classifyManagedRunFailure,
  managedRunFailureFromRecord,
  managedRunRetryable,
} from "@recurring/managedRunLaunchModel";
import { PARTNER_SET_TOO_LARGE_TITLE } from "@psi/managed/managedFailureCopy";
import { betweenVisitNotice } from "@psi/managed/betweenVisitNotice";
import { deriveManagedFailureTier } from "@psi/managed/managedFailureTiers";
import { failureFor } from "@exchange/useInviterExchange";
import { lastRunMayHaveSentPayload } from "@recurring/managedDetailModel";
import { savedExchangeRow } from "@recurring/savedExchangesModel";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

// A browser party's refusal, at the terms exchange, of a partner whose set for
// a linkage key can hold more values than this browser can match: its own
// title and copy on the one-shot seats, and a non-retryable state of its own
// on a managed exchange's record, next visit, notification, and list row.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";

const refusal = new RoundCapacityError(
  "Too large for this browser: your partner's set for one linkage key can " +
    "hold up to 9000000 values, over the 7643790 a browser exchange can " +
    "match, so the exchange stopped before any linkage key was sent and " +
    "told your partner.",
);

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
  failureKind: "partner-set-too-large",
};

describe("a one-shot exchange", () => {
  test("shows the refusal under its own title, with no retry", () => {
    const failure = failureFor("exchange", refusal);
    expect(failure.category).toBe("config");
    expect(failure.title).toBe(
      "Your partner's set is too large for this browser",
    );
    expect(failure.message).toBe(refusal.message);
    expect(failure.reportedCause).toBeUndefined();
    expect(failure.retry).toBe("withheld");
  });
});

describe("a managed exchange", () => {
  test("records the refusal as its own kind, on either side of the boundary", () => {
    for (const dataExchangeStarted of [false, true]) {
      const lastRun = rerunFailureLastRun(
        refusal,
        Date.parse(RUN_AT),
        false,
        dataExchangeStarted,
      );
      expect(lastRun).toEqual(stamped);
      expect(lastRunSchema.safeParse(lastRun).success).toBe(true);
      expect(
        deriveManagedFailureTier(record({ lastRun }), undefined, NOW),
      ).toBe("partner-set-too-large");
      expect(benignRerunOutcome(refusal, dataExchangeStarted)).toBe(
        "partner-set-too-large",
      );
    }
  });

  test("a lapsed bound does not turn the refusal into an expiry", () => {
    expect(
      remapLapsedRunFailure(
        refusal,
        { expires: "2026-07-01T00:00:00.000Z" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("a live launch shows the refusal's own message and offers no retry", () => {
    const failure = classifyManagedRunFailure(
      refusal,
      { atLaunch: record(), afterRun: record({ lastRun: stamped }) },
      undefined,
      NOW,
      true,
    );
    if (failure.kind === "handed-off")
      throw new Error("expected the partner-set-too-large alert");
    expect(failure.kind).toBe("partner-set-too-large");
    expect(failure.title).toBe(PARTNER_SET_TOO_LARGE_TITLE);
    expect(failure.message).toBe(refusal.message);
    expect(failure.reportedCause).toBeUndefined();
    expect(failure.recovery).toBe("split");
    expect(managedRunRetryable(failure)).toBe(false);
  });

  test("the next visit states the cause and both remedies, and offers no retry", () => {
    const failure = managedRunFailureFromRecord(
      record({ lastRun: stamped }),
      undefined,
      NOW,
    );
    if (failure === undefined || failure.kind === "handed-off")
      throw new Error("expected the partner-set-too-large alert");
    expect(failure.kind).toBe("partner-set-too-large");
    expect(failure.title).toBe(PARTNER_SET_TOO_LARGE_TITLE);
    expect(failure.message).toBe(
      "The last run stopped because your partner's set of values for a " +
        "linkage key is larger than this browser can match. Running it " +
        "again stops the same way until your partner's input is smaller. " +
        "Run this exchange with the command-line application, or ask your " +
        "partner to split their input into smaller files and set up one " +
        "exchange for each.",
    );
    expect(managedRunRetryable(failure)).toBe(false);
  });

  test("an unattended run's notification holds the same title and remedy", () => {
    const notice = betweenVisitNotice({
      record: record({ lastRun: stamped }),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "failed",
      now: NOW,
    });
    expect(notice?.kind).toBe("partner-set-too-large");
    expect(notice?.title).toBe(PARTNER_SET_TOO_LARGE_TITLE);
    expect(notice?.body).toContain(
      "larger than this browser can match, and every later window stops the " +
        "same way",
    );
    expect(notice?.body).toContain("with the command-line application");
  });

  test("the list row names the state and the command-line remedy", () => {
    const row = savedExchangeRow(record({ lastRun: stamped }), undefined, NOW);
    expect(row.status).toMatch(
      /^Last run stopped: your partner's set is too large for this browser \(.*\); use the command-line application$/,
    );
  });

  test("the run history rules out a payload sent", () => {
    expect(lastRunMayHaveSentPayload({ lastRun: stamped })).toBe(false);
  });
});
