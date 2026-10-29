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
import { PARTNER_SECRET_NOT_SAVED_TITLE } from "@psi/managed/managedFailureCopy";
import { PartnerNoShowError } from "@psi/transport/waitForConnection";
import { betweenVisitNotice } from "@psi/managed/betweenVisitNotice";
import { failureFor } from "@exchange/useInviterExchange";
import { managedStandingConditionView } from "@recurring/managedStandingConditionModel";
import { savedExchangeRow } from "@recurring/savedExchangesModel";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedRunFailure } from "@recurring/managedRunLaunchModel";

// A browser initiator whose partner could not save the next shared secret this
// side stored: the two hold different secrets, so every surface says so, names
// a fresh invitation, and offers no retry; every other abort reads as before.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";

const storeFailure = () =>
  new PeerAbortError(undefined, NEXT_SECRET_STORE_FAILED_ABORT_REASON);
const notSaved = () =>
  new PartnerSecretNotSavedError({ cause: storeFailure() });

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
  test("names the partner's store-failure abort on an initiator that stored", () => {
    const abort = storeFailure();
    const named = withPartnerSecretNotSaved(abort, "initiator", true);
    expect(named).toBeInstanceOf(PartnerSecretNotSavedError);
    expect((named as Error).cause).toBe(abort);
  });

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
      expect(withPartnerSecretNotSaved(error, role, stored)).toBe(error);
    },
  );
});

describe("a one-shot exchange", () => {
  test("says the partner could not save the new secret, that this side took it, and to get a fresh invitation, with no retry", () => {
    const failure = failureFor(
      "exchange",
      notSaved(),
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

  test("a live launch and the next visit name the re-invite and offer no retry", () => {
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
        /^A run stopped because your partner could not save the exchange's new shared secret, and this side had already taken it, so you and your partner now hold different secrets\. Scheduled runs keep running but cannot reach your partner, and running the exchange again cannot either; it needs a fresh invitation/,
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
    expect(notice?.body).toContain(
      "Scheduled runs keep running but cannot reach your partner until you " +
        "re-invite them.",
    );
    expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
      /^Last run stopped: your partner could not save the new secret \(.*\); no run can reach them until you re-invite$/,
    );
    expect(runHistoryEntries(stored).map((entry) => entry.failure)).toEqual([
      "your partner could not save the new secret, so this exchange needs a " +
        "fresh invitation",
    ]);
  });
});

describe("the windows after the partner's failed save, until a re-invite", () => {
  const LATER = "2026-07-21T09:00:00.000Z";
  const LATER_MS = Date.parse(LATER);

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

  test.each([
    ["a handshake that failed closed", failedHandshake],
    ["a no-show", noShow],
  ])(
    "%s after it keeps the re-invite, never the unexplained checklist",
    (_case, lastRun) => {
      const later = afterLaterWindow(lastRun);
      expect(later.lastRun).toEqual(lastRun);
      expect(raisedStandingCondition(later)?.kind).toBe("partner-storage");
      expect(readManagedFailure(later, undefined, NOW + 1)).toEqual({
        tier: "partner-storage",
        standing: true,
      });
      expectReinvite(managedRunFailureFromRecord(later, undefined, NOW + 1));
      expect(savedExchangeRow(later, undefined, NOW + 1).status).toMatch(
        /^Your partner could not save the new secret \(.*\); no run can reach them until you re-invite$/,
      );
      const view = managedStandingConditionView(later, undefined);
      expect(view?.tier).toBe("partner-storage");
      expect(view?.title).toBe(PARTNER_SECRET_NOT_SAVED_TITLE);
      expect(view?.clearance).toBe("acknowledge");
      const notice = betweenVisitNotice({
        record: later,
        local: undefined,
        caughtUpMisses: 0,
        disposition: lastRun.outcome === "missed" ? "missed" : "failed",
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
    },
  );

  test("a live run whose handshake fails closed reads as the partner's failed save", () => {
    const failure = classifyManagedRunFailure(
      new ConnectionError("could not verify the partner", "security"),
      { atLaunch: afterStop(), afterRun: afterLaterWindow(failedHandshake) },
      undefined,
      NOW + 1,
      false,
    );
    expectReinvite(failure);
    expect(failure.reportedCause).toBeUndefined();
  });

  test("the re-invite that replaces the secret clears it", () => {
    const later = runnableManagedExchangeOrRefuse(
      afterLaterWindow(failedHandshake),
    );
    const reinvited = applyManagedExchangeReinviteRotation(later, {
      sharedSecret: generateSharedSecret(),
      expires: null,
      signalingServer: { host: "signaling.example.org" },
    });
    expect(reinvited.standingCondition).toEqual(NO_STANDING_CONDITION);
    expect(deriveManagedFailureTier(reinvited, undefined, NOW + 1)).toBe(
      "none",
    );
    expect(managedStandingConditionView(reinvited, undefined)).toBeUndefined();
  });
});
