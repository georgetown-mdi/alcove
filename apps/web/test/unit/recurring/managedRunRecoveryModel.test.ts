import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  MANAGED_RECOVERY_INITIAL,
  managedCompromiseResponseActive,
  managedConfirmationGranted,
  managedFailureHoldsReinvite,
  managedRecoveryReducer,
  managedReinviteFailedAt,
  managedReinviteInFlight,
  managedRunHoldsReinvite,
  managedStandingConditionShown,
} from "@recurring/managedRunRecoveryModel";
import {
  MANAGED_RUN_SURFACE_INITIAL,
  managedRunLiveFailure,
  managedRunSurfaceReducer,
} from "@recurring/managedRunSurfaceModel";
import { TERMS_CHANGE_TAKEN_ON_FAILURE } from "@recurring/managedRunLaunchModel";

import type {
  ManagedRecoveryAction,
  ManagedRecoveryState,
} from "@recurring/managedRunRecoveryModel";
import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedReinvite } from "@psi/managed/managedReinvite";
import type { ManagedRunFailureAlert } from "@recurring/managedRunLaunchModel";
import type { ManagedStandingConditionView } from "@recurring/managedStandingConditionModel";

const REINVITE: ManagedReinvite = {
  encoded: "encoded-invitation",
  deepLink: "https://example.org/accept#encoded-invitation",
  sharedSecret: "fresh-secret",
  tokenExpires: "2026-10-08T12:00:00.000Z",
  rotation: { sharedSecret: "fresh-secret", expires: null },
};

const REINVITE_FAILURE: ManagedRunFailureAlert = {
  ...TERMS_CHANGE_TAKEN_ON_FAILURE,
  kind: "storage",
  recovery: "reinvite",
};
const CONFIRM_FAILURE: ManagedRunFailureAlert = {
  ...TERMS_CHANGE_TAKEN_ON_FAILURE,
  kind: "unexplained",
  recovery: "confirm",
};
const RETRY_FAILURE: ManagedRunFailureAlert = {
  ...TERMS_CHANGE_TAKEN_ON_FAILURE,
  recovery: "retry",
};

const STORAGE_VIEW: ManagedStandingConditionView = {
  tier: "storage",
  title: "A run could not save this exchange's new secret",
  message: "Re-invite your partner to reconnect.",
  clearance: "acknowledge",
};

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

function fold(
  actions: ReadonlyArray<ManagedRecoveryAction>,
  from: ManagedRecoveryState = MANAGED_RECOVERY_INITIAL,
): ManagedRecoveryState {
  return actions.reduce(managedRecoveryReducer, from);
}

describe("the confirmation gate", () => {
  test("a grant applies to the failure it was given for and no later one", () => {
    const granted = fold([{ type: "confirmation-granted", runNumber: 2 }]);
    expect(
      managedConfirmationGranted(granted, {
        alert: CONFIRM_FAILURE,
        runNumber: 2,
      }),
    ).toBe(true);
    expect(
      managedConfirmationGranted(granted, {
        alert: CONFIRM_FAILURE,
        runNumber: 3,
      }),
    ).toBe(false);
    expect(managedConfirmationGranted(granted, undefined)).toBe(false);
  });

  test("a run start withdraws the grant", () => {
    const restarted = fold([
      { type: "confirmation-granted", runNumber: 1 },
      { type: "run-started" },
    ]);
    expect(restarted.confirmationGrantedFor).toBeUndefined();
  });
});

describe("the compromise response", () => {
  test("is inactive with no answer on the record or the page", () => {
    expect(
      managedCompromiseResponseActive(MANAGED_RECOVERY_INITIAL, record()),
    ).toBe(false);
    expect(
      managedCompromiseResponseActive(MANAGED_RECOVERY_INITIAL, undefined),
    ).toBe(false);
  });

  test("is active from the record's own answer", () => {
    const answered = record({
      standingCondition: {
        since: "2026-10-01T09:00:00.000Z",
        kind: "auth",
        response: { kind: "compromise", at: "2026-10-01T10:00:00.000Z" },
      },
    });
    expect(
      managedCompromiseResponseActive(MANAGED_RECOVERY_INITIAL, answered),
    ).toBe(true);
  });

  test("is active across the answer's write, and stays active where the write fails", () => {
    const writing = fold([
      {
        type: "compromise-answer-started",
        gate: { kind: "failure", runNumber: 1 },
      },
    ]);
    expect(managedCompromiseResponseActive(writing, record())).toBe(true);
    const failed = fold([{ type: "compromise-answer-failed" }], writing);
    expect(failed.compromise.write.kind).toBe("failed");
    expect(managedCompromiseResponseActive(failed, record())).toBe(true);
  });

  test("an answer written leaves the record to hold it", () => {
    const written = fold([
      { type: "compromise-answer-started", gate: { kind: "standing" } },
      { type: "compromise-answer-written" },
    ]);
    expect(managedCompromiseResponseActive(written, record())).toBe(false);
  });

  test("an unsaved answer lasts until a run starts", () => {
    const restarted = fold([
      { type: "compromise-answer-started", gate: { kind: "standing" } },
      { type: "compromise-answer-failed" },
      { type: "run-started" },
    ]);
    expect(managedCompromiseResponseActive(restarted, record())).toBe(false);
  });

  test("a mint the store withheld activates it, and a run start keeps it", () => {
    const withheld = fold([
      { type: "reinvite-started", site: "recovery" },
      { type: "reinvite-withheld" },
    ]);
    expect(managedReinviteInFlight(withheld)).toBe(false);
    expect(managedCompromiseResponseActive(withheld, record())).toBe(true);
    expect(
      managedCompromiseResponseActive(
        fold([{ type: "run-started" }], withheld),
        record(),
      ),
    ).toBe(true);
  });

  test("records the failure answered at a live gate, and keeps it for a standing-gate answer", () => {
    const atFailure = fold([
      {
        type: "compromise-answer-started",
        gate: { kind: "failure", runNumber: 4 },
      },
      { type: "compromise-answer-written" },
    ]);
    expect(atFailure.compromise.answeredFor).toBe(4);
    const thenStanding = fold(
      [
        { type: "compromise-answer-started", gate: { kind: "standing" } },
        { type: "compromise-answer-written" },
      ],
      atFailure,
    );
    expect(thenStanding.compromise.answeredFor).toBe(4);
  });
});

describe("clearing the standing condition", () => {
  test("is in flight until its write lands, then settles the section", () => {
    const clearing = fold([
      { type: "standing-clear-started", pastResponse: false },
    ]);
    expect(clearing.standing.clear.kind).toBe("clearing");
    const cleared = fold([{ type: "standing-cleared" }], clearing);
    expect(cleared.standing).toEqual({
      settled: true,
      clear: { kind: "idle" },
    });
  });

  test("a failed clear settles nothing, and a retry drops the failure", () => {
    const failed = fold([
      { type: "standing-clear-started", pastResponse: false },
      { type: "standing-clear-failed" },
    ]);
    expect(failed.standing).toEqual({
      settled: false,
      clear: { kind: "failed" },
    });
    expect(
      fold([{ type: "standing-clear-started", pastResponse: false }], failed)
        .standing.clear.kind,
    ).toBe("clearing");
  });

  test("drops the page's unsaved and store-withheld answers with the condition", () => {
    const held = fold([
      { type: "reinvite-started", site: "detail" },
      { type: "reinvite-withheld" },
      { type: "compromise-answer-started", gate: { kind: "standing" } },
      { type: "compromise-answer-failed" },
    ]);
    expect(managedCompromiseResponseActive(held, record())).toBe(true);
    const cleared = fold(
      [
        { type: "standing-clear-started", pastResponse: true },
        { type: "standing-cleared" },
      ],
      held,
    );
    expect(managedCompromiseResponseActive(cleared, record())).toBe(false);
  });

  test("past a response, grants the confirmation for the failure that response answered", () => {
    const cleared = fold([
      { type: "confirmation-granted", runNumber: 1 },
      {
        type: "compromise-answer-started",
        gate: { kind: "failure", runNumber: 2 },
      },
      { type: "compromise-answer-written" },
      { type: "standing-clear-started", pastResponse: true },
      { type: "standing-cleared" },
    ]);
    expect(cleared.confirmationGrantedFor).toBe(2);
  });

  test("past a response given at no live gate, withdraws any grant", () => {
    const cleared = fold([
      { type: "confirmation-granted", runNumber: 1 },
      { type: "compromise-answer-started", gate: { kind: "standing" } },
      { type: "compromise-answer-written" },
      { type: "standing-clear-started", pastResponse: true },
      { type: "standing-cleared" },
    ]);
    expect(cleared.confirmationGrantedFor).toBeUndefined();
  });

  test("not past a response, leaves the grant where it was", () => {
    const cleared = fold([
      { type: "confirmation-granted", runNumber: 1 },
      { type: "standing-clear-started", pastResponse: false },
      { type: "standing-cleared" },
    ]);
    expect(cleared.confirmationGrantedFor).toBe(1);
  });

  test("grants for the failure answered when the clear started", () => {
    const cleared = fold([
      {
        type: "compromise-answer-started",
        gate: { kind: "failure", runNumber: 1 },
      },
      { type: "compromise-answer-written" },
      { type: "standing-clear-started", pastResponse: true },
      {
        type: "compromise-answer-started",
        gate: { kind: "failure", runNumber: 2 },
      },
      { type: "standing-cleared" },
    ]);
    expect(cleared.confirmationGrantedFor).toBe(1);
  });
});

describe("the re-invite mint", () => {
  test("is in flight from its start until an outcome arrives", () => {
    const started = fold([{ type: "reinvite-started", site: "recovery" }]);
    expect(managedReinviteInFlight(started)).toBe(true);
    for (const outcome of [
      { type: "reinvite-composed", reinvite: REINVITE },
      { type: "reinvite-held-by-run" },
      { type: "reinvite-refused-by-run" },
      { type: "reinvite-withheld" },
      { type: "reinvite-failed" },
    ] satisfies ReadonlyArray<ManagedRecoveryAction>)
      expect(managedReinviteInFlight(fold([outcome], started))).toBe(false);
  });

  test("a composed invitation is kept until a run starts", () => {
    const composed = fold([
      { type: "reinvite-started", site: "detail" },
      { type: "reinvite-composed", reinvite: REINVITE },
    ]);
    expect(composed.reinvite.composed).toBe(REINVITE);
    expect(composed.reinvite.site).toBe("detail");
    expect(
      fold([{ type: "run-started" }], composed).reinvite.composed,
    ).toBeUndefined();
  });

  test("a failed mint alerts only at the site that asked for it", () => {
    const failed = fold([
      { type: "reinvite-started", site: "detail" },
      { type: "reinvite-failed" },
    ]);
    expect(managedReinviteFailedAt(failed, "detail")).toBe(true);
    expect(managedReinviteFailedAt(failed, "recovery")).toBe(false);
  });

  test("a failed mint's alert goes at the next mint or run start", () => {
    const failed = fold([
      { type: "reinvite-started", site: "recovery" },
      { type: "reinvite-failed" },
    ]);
    expect(
      managedReinviteFailedAt(
        fold([{ type: "reinvite-started", site: "recovery" }], failed),
        "recovery",
      ),
    ).toBe(false);
    expect(
      managedReinviteFailedAt(
        fold([{ type: "run-started" }], failed),
        "recovery",
      ),
    ).toBe(false);
  });

  test("a run holds the mint by the polled reading or by the mint's own refusal", () => {
    expect(managedRunHoldsReinvite(MANAGED_RECOVERY_INITIAL, true)).toBe(true);
    expect(managedRunHoldsReinvite(MANAGED_RECOVERY_INITIAL, false)).toBe(
      false,
    );
    const refused = fold([
      { type: "reinvite-started", site: "recovery" },
      { type: "reinvite-refused-by-run" },
    ]);
    expect(managedRunHoldsReinvite(refused, false)).toBe(true);
    expect(
      managedRunHoldsReinvite(fold([{ type: "run-started" }], refused), false),
    ).toBe(true);
    expect(
      managedRunHoldsReinvite(
        fold([{ type: "reinvite-started", site: "recovery" }], refused),
        false,
      ),
    ).toBe(false);
  });

  test("a recheck that found a run leaves no refusal and no failure", () => {
    const held = fold([
      { type: "reinvite-started", site: "recovery" },
      { type: "reinvite-held-by-run" },
    ]);
    expect(managedRunHoldsReinvite(held, false)).toBe(false);
    expect(managedReinviteFailedAt(held, "recovery")).toBe(false);
  });

  test("a run start leaves a mint in flight running", () => {
    const started = fold([
      { type: "reinvite-started", site: "recovery" },
      { type: "run-started" },
    ]);
    expect(managedReinviteInFlight(started)).toBe(true);
  });
});

describe("the standing condition's section", () => {
  test("is hidden with no condition and nothing cleared", () => {
    expect(
      managedStandingConditionShown(
        MANAGED_RECOVERY_INITIAL,
        undefined,
        undefined,
      ),
    ).toBe(false);
  });

  test("shows a condition beside no failure or a failure on another tier", () => {
    expect(
      managedStandingConditionShown(
        MANAGED_RECOVERY_INITIAL,
        STORAGE_VIEW,
        undefined,
      ),
    ).toBe(true);
    expect(
      managedStandingConditionShown(
        MANAGED_RECOVERY_INITIAL,
        STORAGE_VIEW,
        CONFIRM_FAILURE,
      ),
    ).toBe(true);
  });

  test("steps aside for a live failure on the condition's own tier", () => {
    expect(
      managedStandingConditionShown(
        MANAGED_RECOVERY_INITIAL,
        STORAGE_VIEW,
        REINVITE_FAILURE,
      ),
    ).toBe(false);
  });

  test("keeps its place once cleared, even with the condition gone", () => {
    const cleared = fold([
      { type: "standing-clear-started", pastResponse: false },
      { type: "standing-cleared" },
    ]);
    expect(managedStandingConditionShown(cleared, undefined, undefined)).toBe(
      true,
    );
    expect(
      managedStandingConditionShown(cleared, STORAGE_VIEW, REINVITE_FAILURE),
    ).toBe(true);
  });

  test("is replaced by a composed re-invite", () => {
    const composed = fold([
      { type: "standing-clear-started", pastResponse: false },
      { type: "standing-cleared" },
      { type: "reinvite-started", site: "recovery" },
      { type: "reinvite-composed", reinvite: REINVITE },
    ]);
    expect(
      managedStandingConditionShown(composed, STORAGE_VIEW, undefined),
    ).toBe(false);
  });
});

describe("a failure that holds the re-invite", () => {
  test("offers the mint directly or through the confirmation gate", () => {
    expect(managedFailureHoldsReinvite(REINVITE_FAILURE)).toBe(true);
    expect(managedFailureHoldsReinvite(CONFIRM_FAILURE)).toBe(true);
  });

  test("is no other failure, and no failure at all", () => {
    expect(managedFailureHoldsReinvite(RETRY_FAILURE)).toBe(false);
    expect(managedFailureHoldsReinvite(undefined)).toBe(false);
  });
});

describe("a confirmation through the composed surface reducer", () => {
  test("does not carry from run 1's failure to run 2's", () => {
    const failAt = (runNumber: number) =>
      ({
        type: "run-failed",
        failure: { alert: CONFIRM_FAILURE, runNumber },
      }) as const;
    let state = managedRunSurfaceReducer(MANAGED_RUN_SURFACE_INITIAL, {
      type: "run-started",
    });
    state = managedRunSurfaceReducer(state, failAt(1));
    state = managedRunSurfaceReducer(state, {
      type: "confirmation-granted",
      runNumber: 1,
    });
    expect(
      managedConfirmationGranted(
        state.recovery,
        managedRunLiveFailure(state.run),
      ),
    ).toBe(true);

    state = managedRunSurfaceReducer(state, { type: "run-started" });
    state = managedRunSurfaceReducer(state, failAt(2));
    expect(
      managedConfirmationGranted(
        state.recovery,
        managedRunLiveFailure(state.run),
      ),
    ).toBe(false);
  });
});
