import {
  ConnectionError,
  NEXT_SECRET_STORE_FAILED_ABORT_REASON,
  PSI_SET_REFUSED_ABORT_REASON,
  PeerAbortError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  applyManagedExchangeLastRun,
  applyManagedExchangeReinviteRotation,
  composeManagedExchangeFile,
  lastRunSchema,
  raisedStandingCondition,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  PARTNER_SECRET_NOT_SAVED_KEPT_REMEDY,
  PARTNER_SECRET_NOT_SAVED_TITLE,
} from "@psi/managed/managedFailureCopy";
import {
  PartnerSecretNotSavedError,
  withPartnerSecretNotSaved,
} from "@psi/partnerSecretNotSaved";
import {
  benignRerunOutcome,
  rerunFailureLastRun,
} from "@psi/managed/managedRun";
import {
  classifyManagedRunFailure,
  managedRunFailureFromRecord,
  managedRunReinvites,
  managedRunRetryable,
} from "@recurring/managedRunLaunchModel";
import {
  deriveManagedFailureTier,
  readManagedFailure,
} from "@psi/managed/managedFailureTiers";
import {
  lastRunMayHaveSentPayload,
  runHistoryEntries,
} from "@recurring/managedDetailModel";
import { PartnerNoShowError } from "@psi/transport/waitForConnection";
import { betweenVisitNotice } from "@psi/managed/betweenVisitNotice";
import { composeConfirmationMessage } from "@psi/managed/managedFailureConfirmation";
import { dateTimeLabel } from "@psi/formatting";
import { failureFor } from "@exchange/useInviterExchange";
import { managedStandingConditionView } from "@recurring/managedStandingConditionModel";
import { savedExchangeRow } from "@recurring/savedExchangesModel";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedRunFailure } from "@recurring/managedRunLaunchModel";

const TEST_RETIRED = { verifier: "A".repeat(43), at: 0 };

// A browser initiator whose partner could not save the next shared secret: a
// managed run, which kept it, holds a different secret from the partner's and
// says so; a one-shot run, which kept none, says nothing changed. Both name a
// new invitation and offer no retry; every other abort reads as before.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";

const storeFailure = () =>
  new PeerAbortError(undefined, NEXT_SECRET_STORE_FAILED_ABORT_REASON);
const notSaved = (keptNextSecret = true) =>
  new PartnerSecretNotSavedError({ cause: storeFailure(), keptNextSecret });

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
    side: "acceptor",
    sharedSecret: generateSharedSecret(),
    standingCondition: NO_STANDING_CONDITION,
    ...overrides,
  };
}

const stamped: ManagedExchangeLastRun = {
  at: RUN_AT,
  outcome: "failed",
  failureKind: "partner-storage",
};

describe("withPartnerSecretNotSaved", () => {
  test.each([true, false])(
    "names the partner's store-failure abort on an initiator that stored, recording kept %s",
    (kept) => {
      const abort = storeFailure();
      const named = withPartnerSecretNotSaved(abort, "initiator", true, kept);
      if (!(named instanceof PartnerSecretNotSavedError))
        throw new Error("expected the partner's failed save");
      expect(named.cause).toBe(abort);
      expect(named.keptNextSecret).toBe(kept);
    },
  );

  test.each([
    ["on a responder", storeFailure(), "responder", true],
    ["on an initiator that stored nothing", storeFailure(), "initiator", false],
    [
      "for another abort reason",
      new PeerAbortError(undefined, PSI_SET_REFUSED_ABORT_REASON),
      "initiator",
      true,
    ],
    [
      "for an abort with no kept reason",
      new PeerAbortError(),
      "initiator",
      true,
    ],
  ] as const)(
    "leaves the failure as it is %s",
    (_case, error, role, stored) => {
      expect(withPartnerSecretNotSaved(error, role, stored, stored)).toBe(
        error,
      );
    },
  );
});

describe("a one-shot exchange", () => {
  test("where this side kept none, says the partner could not save it, that nothing changed here, and to ask for a new invitation, with no retry", () => {
    const failure = failureFor(
      "exchange",
      notSaved(false),
      undefined,
      undefined,
      "acceptor",
    );
    expect(failure.category).toBe("config");
    expect(failure.title).toBe(PARTNER_SECRET_NOT_SAVED_TITLE);
    expect(failure.message).toBe(
      "Your partner could not save the new secret, so the exchange stopped. " +
        "Nothing changed on this side. Ask your partner for a new " +
        "invitation, then choose Start over with a fresh invitation to " +
        "accept it.",
    );
    expect(failure.reportedCause).toBeUndefined();
    expect(failure.retry).toBe("withheld");
    expect(failure.settingsCannotResolve).toBe(true);
  });

  test("where this side kept the new secret, keeps the different-secrets copy", () => {
    const failure = failureFor(
      "exchange",
      notSaved(true),
      undefined,
      undefined,
      "acceptor",
    );
    expect(failure.category).toBe("config");
    expect(failure.title).toBe(PARTNER_SECRET_NOT_SAVED_TITLE);
    expect(failure.message).toBe(
      "The exchange stopped because your partner could not save the " +
        "exchange's new shared secret, and this side had already taken it, " +
        "so you and your partner now hold different secrets. Running it " +
        "again on this invitation cannot reconnect you. Ask your partner " +
        "for a new invitation, then choose Start over with a fresh " +
        "invitation to accept it.",
    );
    expect(failure.reportedCause).toBeUndefined();
    expect(failure.retry).toBe("withheld");
    expect(failure.settingsCannotResolve).toBe(true);
  });

  test("keeps the generic copy for the bare abort and for another partner abort", () => {
    const generic = failureFor("exchange", new PeerAbortError());
    expect(generic.title).toBe("Exchange failed");
    expect(generic.retry).toBe("offered");
    expect(failureFor("exchange", storeFailure())).toEqual(generic);
  });
});

describe("a managed exchange", () => {
  test("records the partner's failed save as its own kind, with the payload left open", () => {
    const lastRun = rerunFailureLastRun(
      notSaved(),
      Date.parse(RUN_AT),
      false,
      true,
    );
    expect(lastRun).toEqual(stamped);
    expect(lastRunSchema.safeParse(lastRun).success).toBe(true);
    expect(benignRerunOutcome(notSaved(), true)).toBe("partner-storage");
    expect(lastRunMayHaveSentPayload({ lastRun: stamped })).toBe(true);
  });

  test("another partner abort keeps the connection-problem record", () => {
    for (const abort of [storeFailure(), new PeerAbortError()]) {
      expect(
        rerunFailureLastRun(abort, Date.parse(RUN_AT), false, true),
      ).toEqual({ at: RUN_AT, outcome: "failed", failureKind: "transport" });
      expect(benignRerunOutcome(abort, true)).toBeUndefined();
    }
  });

  test("a live launch and the next visit say the kept secret reaches the partner, and offer the re-invite", () => {
    const live = classifyManagedRunFailure(
      notSaved(),
      { atLaunch: record(), afterRun: record({ lastRun: stamped }) },
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
      if (failure === undefined)
        throw new Error("expected the partner-storage alert");
      expect(failure.kind).toBe("partner-storage");
      expect(failure.title).toBe(PARTNER_SECRET_NOT_SAVED_TITLE);
      expect(failure.message).toMatch(
        /^A run stopped because your partner could not save the exchange's new shared secret, and this side had already taken it, so you and your partner now hold different secrets\. This device kept the secret your partner still holds, so the next run can still reach them, and both sides save a new secret\. If runs keep missing your partner or stopping, re-invite them\.$/,
      );
      expect(failure.reportedCause).toBeUndefined();
      expect(managedRunRetryable(failure)).toBe(false);
      expect(managedRunReinvites(failure)).toBe(true);
    }
  });

  test("a no-show after it keeps the re-invite on the live launch", () => {
    const live = classifyManagedRunFailure(
      new PartnerNoShowError("nobody arrived"),
      {
        atLaunch: record({ lastRun: stamped }),
        afterRun: record({ lastRun: { at: RUN_AT, outcome: "missed" } }),
      },
      undefined,
      NOW,
      false,
    );
    expect(live.kind).toBe("partner-storage");
    expect(managedRunReinvites(live)).toBe(true);
  });

  test("an unattended run's notification, list row, and run history name the state", () => {
    const stored = record({ lastRun: stamped });
    expect(deriveManagedFailureTier(stored, undefined, NOW)).toBe(
      "partner-storage",
    );
    const notice = betweenVisitNotice({
      record: stored,
      local: undefined,
      caughtUpMisses: 0,
      disposition: "failed",
      now: NOW,
    });
    expect(notice?.kind).toBe("partner-storage");
    expect(notice?.title).toBe(PARTNER_SECRET_NOT_SAVED_TITLE);
    expect(notice?.body).toContain(PARTNER_SECRET_NOT_SAVED_KEPT_REMEDY);
    expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
      /^Last run stopped: your partner could not save the new secret \(.*\); the next run can still reach them$/,
    );
    expect(runHistoryEntries(stored).map((entry) => entry.failure)).toEqual([
      "your partner could not save the new secret",
    ]);
  });
});

describe("the windows after the partner's failed save, until a re-invite", () => {
  const LATER = "2026-07-21T09:00:00.000Z";
  const LATER_MS = Date.parse(LATER);
  const LATER_2 = "2026-07-28T09:00:00.000Z";
  const LATER_2_MS = Date.parse(LATER_2);

  /** The record as the store holds it once the partner-storage stop landed. */
  function afterStop(): ManagedExchangeRecord {
    return applyManagedExchangeLastRun(
      record(),
      stamped,
      Date.parse(RUN_AT),
      Date.parse(RUN_AT),
    );
  }

  /** `afterStop` with a later window's own stamp recorded over it. */
  function afterLaterWindow(
    lastRun: ManagedExchangeLastRun,
  ): ManagedExchangeRecord {
    return applyManagedExchangeLastRun(
      afterStop(),
      lastRun,
      LATER_MS,
      LATER_MS,
    );
  }

  const failedHandshake: ManagedExchangeLastRun = {
    at: LATER,
    outcome: "failed",
    failureKind: "auth",
  };
  const noShow: ManagedExchangeLastRun = { at: LATER, outcome: "missed" };

  function expectReinvite(failure: ManagedRunFailure | undefined): void {
    if (failure === undefined)
      throw new Error("expected the partner-storage alert");
    expect(failure.kind).toBe("partner-storage");
    expect(managedRunReinvites(failure)).toBe(true);
    expect(managedRunRetryable(failure)).toBe(false);
  }

  test("the stop raises a standing condition the record keeps", () => {
    expect(raisedStandingCondition(afterStop())).toEqual({
      since: RUN_AT,
      kind: "partner-storage",
    });
  });

  test("a no-show after it keeps the re-invite, never the unexplained checklist", () => {
    const later = afterLaterWindow(noShow);
    expect(later.lastRun).toEqual(noShow);
    expect(raisedStandingCondition(later)?.kind).toBe("partner-storage");
    expect(readManagedFailure(later, undefined, NOW + 1)).toEqual({
      tier: "partner-storage",
      standing: true,
    });
    expectReinvite(managedRunFailureFromRecord(later, undefined, NOW + 1));
    expect(savedExchangeRow(later, undefined, NOW + 1).status).toMatch(
      /^Your partner could not save the new secret \(.*\); the next run can still reach them$/,
    );
    const view = managedStandingConditionView(later, undefined);
    expect(view?.tier).toBe("partner-storage");
    expect(view?.title).toBe(PARTNER_SECRET_NOT_SAVED_TITLE);
    expect(view?.clearance).toBe("acknowledge");
    const notice = betweenVisitNotice({
      record: later,
      local: undefined,
      caughtUpMisses: 0,
      disposition: "missed",
      now: NOW + 1,
    });
    expect(notice?.kind).toBe("partner-storage");
    expect(notice?.tag).toBe(
      betweenVisitNotice({
        record: afterStop(),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "failed",
        now: NOW,
      })?.tag,
    );
  });

  // The partner's report is the other side's claim, which anyone holding the
  // current secret can send, so it does not excuse a later failed handshake
  // from the out-of-band confirmation.
  describe("a handshake that failed closed after it", () => {
    const later = () => afterLaterWindow(failedHandshake);

    test("reads as the unexplained failure the confirmation answers", () => {
      expect(later().lastRun).toEqual(failedHandshake);
      expect(readManagedFailure(later(), undefined, NOW + 1)).toEqual({
        tier: "unexplained",
        standing: false,
      });
      const failure = managedRunFailureFromRecord(later(), undefined, NOW + 1);
      expect(failure?.kind).toBe("unexplained");
      expect(failure?.recovery).toBe("confirm");
      expect(failure && managedRunRetryable(failure)).toBe(false);
      expect(failure && managedRunReinvites(failure)).toBe(false);
      expect(savedExchangeRow(later(), undefined, NOW + 1).status).not.toMatch(
        /partner could not save/i,
      );
    });

    test("is notified as the unexplained failure, not the partner's failed save", () => {
      const notice = betweenVisitNotice({
        record: later(),
        local: undefined,
        caughtUpMisses: 0,
        disposition: "failed",
        now: NOW + 1,
      });
      expect(notice?.kind).toBe("unexplained");
    });

    test("replaces the partner's report as the standing condition", () => {
      expect(raisedStandingCondition(later())).toEqual({
        since: LATER,
        kind: "auth",
      });
      const view = managedStandingConditionView(later(), undefined);
      expect(view?.tier).toBe("unexplained");
      expect(view?.clearance).toBe("confirmation");
    });

    test("keeps the confirmation across a no-show window after it", () => {
      const afterNoShow = applyManagedExchangeLastRun(
        later(),
        { at: LATER_2, outcome: "missed" },
        LATER_2_MS,
        LATER_2_MS,
      );
      expect(readManagedFailure(afterNoShow, undefined, NOW + 1)).toEqual({
        tier: "unexplained",
        standing: true,
      });
      const failure = managedRunFailureFromRecord(
        afterNoShow,
        undefined,
        NOW + 1,
      );
      expect(failure?.kind).toBe("unexplained");
      expect(failure && managedRunReinvites(failure)).toBe(false);
      const view = managedStandingConditionView(afterNoShow, undefined);
      expect(view?.tier).toBe("unexplained");
      expect(view?.clearance).toBe("confirmation");
    });

    test("reads as unexplained on a live run, with no retry", () => {
      const failure = classifyManagedRunFailure(
        new ConnectionError("could not verify the partner", "security"),
        { atLaunch: afterStop(), afterRun: later() },
        undefined,
        NOW + 1,
        false,
      );
      expect(failure.kind).toBe("unexplained");
      expect(managedRunRetryable(failure)).toBe(false);
      expect(managedRunReinvites(failure)).toBe(false);
    });

    test("dates the confirmation message by the first failed handshake", () => {
      const twice = applyManagedExchangeLastRun(
        later(),
        { ...failedHandshake, at: LATER_2 },
        LATER_2_MS,
        LATER_2_MS,
      );
      const message = composeConfirmationMessage(twice);
      expect(message).toContain(
        `on ${dateTimeLabel(new Date(LATER))}, and again on ${dateTimeLabel(new Date(LATER_2))}.`,
      );
      expect(message).not.toContain(dateTimeLabel(new Date(RUN_AT)));
    });
  });

  test("windows that are only no-shows keep the partner's failed save and its re-invite", () => {
    const twice = applyManagedExchangeLastRun(
      afterLaterWindow(noShow),
      { at: LATER_2, outcome: "missed" },
      LATER_2_MS,
      LATER_2_MS,
    );
    expect(raisedStandingCondition(twice)?.kind).toBe("partner-storage");
    expectReinvite(managedRunFailureFromRecord(twice, undefined, NOW + 1));
  });

  test.each(["auth", "storage"] as const)(
    "the partner's report never replaces a standing %s condition",
    (kind) => {
      const held = record({
        standingCondition: { since: "2026-07-10T09:00:00.000Z", kind },
      });
      const reported = applyManagedExchangeLastRun(
        held,
        stamped,
        Date.parse(RUN_AT),
        Date.parse(RUN_AT),
      );
      expect(raisedStandingCondition(reported)).toEqual({
        since: "2026-07-10T09:00:00.000Z",
        kind,
      });
    },
  );

  test("a failed handshake never replaces a partner's report the operator has answered", () => {
    const response = {
      kind: "compromise" as const,
      at: "2026-07-20T09:00:00.000Z",
    };
    const answered = record({
      standingCondition: { since: RUN_AT, kind: "partner-storage", response },
    });
    const later = applyManagedExchangeLastRun(
      answered,
      failedHandshake,
      LATER_MS,
      LATER_MS,
    );
    expect(raisedStandingCondition(later)).toEqual({
      since: RUN_AT,
      kind: "partner-storage",
      response,
    });
  });

  test("the re-invite that replaces the secret clears it", () => {
    const later = runnableManagedExchangeOrRefuse(
      afterLaterWindow(failedHandshake),
    );
    const reinvited = applyManagedExchangeReinviteRotation(
      later,
      {
        sharedSecret: generateSharedSecret(),
        expires: null,
        signalingServer: { host: "signaling.example.org" },
      },
      TEST_RETIRED,
    );
    expect(reinvited.standingCondition).toEqual(NO_STANDING_CONDITION);
    expect(deriveManagedFailureTier(reinvited, undefined, NOW + 1)).toBe(
      "none",
    );
    expect(managedStandingConditionView(reinvited, undefined)).toBeUndefined();
  });
});
