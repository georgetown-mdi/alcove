import { describe, expect, test } from "vitest";
import { generateSharedSecret, getDefaultLinkageTerms } from "@alcove/core";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  STANDING_CONDITION_CLEAR_LABEL,
  managedStandingConditionView,
} from "@recurring/managedStandingConditionModel";
import {
  composeManagedFailureConfirmation,
  routeConfirmationReply,
} from "@psi/managed/managedFailureConfirmation";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";

// The standing condition's own surface, tested in Node: it renders off the
// condition rather than off the last run, so a record whose last run was a no-show
// or a success still states what nobody has answered -- and which clearance
// applies, since the tiers the record already explains get no attack checklist.

const RAISED_AT = "2026-07-10T09:00:00.000Z";
const LATER_AT = "2026-07-12T09:00:00.000Z";
const NOW = Date.parse("2026-07-14T09:00:00.000Z");

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

describe("managedStandingConditionView", () => {
  test("a record holding no condition renders nothing", () => {
    expect(
      managedStandingConditionView(
        record({ lastRun: { at: LATER_AT, outcome: "missed" } }),
        undefined,
        NOW,
      ),
    ).toBeUndefined();
  });

  test("an unexplained handshake failure routes clearance through the gate", () => {
    const view = managedStandingConditionView(
      record({
        lastRun: { at: LATER_AT, outcome: "missed" },
        standingCondition: { since: RAISED_AT, kind: "auth" },
      }),
      undefined,
      NOW,
    );
    expect(view?.clearance).toBe("confirmation");
    expect(view?.message).toMatch(/could not verify your partner/);
    // It states that the runs after it settle nothing, so the operator does not
    // read a green run as the all-clear.
    expect(view?.message).toMatch(/do not settle it/);
  });

  test("a persist failure gets the re-invite recovery and no attack checklist", () => {
    const view = managedStandingConditionView(
      record({
        lastRun: { at: LATER_AT, outcome: "succeeded" },
        standingCondition: { since: RAISED_AT, kind: "storage" },
      }),
      undefined,
      NOW,
    );
    expect(view?.clearance).toBe("acknowledge");
    expect(view?.message).toMatch(/Re-invite your partner to reconnect/);
  });

  test("a restore since the last success explains a standing handshake failure", () => {
    const restored: ManagedLocalState = {
      imported: { importedAt: "2026-07-09T00:00:00.000Z" },
    };
    const view = managedStandingConditionView(
      record({
        lastRun: { at: LATER_AT, outcome: "missed" },
        standingCondition: { since: RAISED_AT, kind: "auth" },
      }),
      restored,
      NOW,
    );
    expect(view?.clearance).toBe("acknowledge");
    expect(view?.title).toBe(
      "This exchange was restored from a backup or key file",
    );
  });

  test("the copy names the condition's instant, not the last run's", () => {
    const view = managedStandingConditionView(
      record({
        lastRun: { at: LATER_AT, outcome: "missed" },
        standingCondition: { since: RAISED_AT, kind: "auth" },
      }),
      undefined,
      NOW,
    );
    const raisedYear = new Date(RAISED_AT).getFullYear().toString();
    expect(view?.message).toContain(raisedYear);
    // The no-show instant falls on a different day, and the copy names one run.
    expect(view?.message.match(/A run on /g)).toHaveLength(1);
  });

  describe("the partner's failed save", () => {
    const previousSecret = generateSharedSecret();
    const partnerStorage = (overrides: Partial<ManagedExchangeRecord> = {}) =>
      record({
        side: "acceptor",
        lastRun: { at: LATER_AT, outcome: "missed" },
        standingCondition: { since: RAISED_AT, kind: "partner-storage" },
        previousSharedSecret: previousSecret,
        ...overrides,
      });

    test("names the next run while the record holds a previous secret it would offer", () => {
      const view = managedStandingConditionView(
        partnerStorage(),
        undefined,
        NOW,
      );
      expect(view?.message).toMatch(
        /This device also kept the earlier secret your partner still holds, so the next run can still reach them\. If your partner's device can save the new secret this time, you are back in step\. If runs keep missing your partner or stopping, ask your partner to re-invite you\. Once a later run succeeds, you are both on the new secret and you can clear this\.$/,
      );
      expect(view?.message).not.toMatch(/do not settle it/);
      expect(view?.reinvite).toBe("if-runs-keep-failing");
      expect(view?.clearance).toBe("acknowledge");
    });

    test.each([
      ["holds no previous secret", { previousSharedSecret: undefined }],
      [
        "holds one that expired",
        { previousExpires: "2026-07-13T09:00:00.000Z" },
      ],
      ["is the inviter's", { side: "inviter" as const }],
    ])("names the re-invite where the record %s", (_case, overrides) => {
      const view = managedStandingConditionView(
        partnerStorage(overrides),
        undefined,
        NOW,
      );
      expect(view?.message).toMatch(
        /Scheduled runs keep running but cannot reach your partner, and running the exchange again cannot either\. Re-invite your partner to reconnect\. Runs since then do not settle it, including any that succeeded\.$/,
      );
      expect(view?.reinvite).toBeUndefined();
    });

    test("says a run since then succeeded, offers no re-invite, and still waits for the clear", () => {
      const view = managedStandingConditionView(
        partnerStorage({
          previousSharedSecret: undefined,
          lastRun: { at: LATER_AT, outcome: "missed" },
          recentRuns: [
            { at: LATER_AT, outcome: "missed" },
            { at: "2026-07-11T09:00:00.000Z", outcome: "succeeded" },
          ],
        }),
        undefined,
        NOW,
      );
      expect(view?.message).toMatch(
        /A run since then succeeded, so you and your partner are on the same secret again, and you can clear this\.$/,
      );
      expect(view?.reinvite).toBe("none");
      expect(view?.clearance).toBe("acknowledge");
    });
  });

  test("the acknowledge control's label is short and states what the click does", () => {
    expect(STANDING_CONDITION_CLEAR_LABEL).toBe("Clear this");
  });
});

describe("the gate the confirmation clearance presents", () => {
  test("a confirmed partner-side failure clears, and anything else does not", () => {
    // The clearance reuses the documented two-outcome gate rather than a second
    // one of its own, so the two surfaces route a reply identically.
    expect(routeConfirmationReply("confirmed-partner-failure")).toBe(
      "reinvite",
    );
    expect(routeConfirmationReply("does-not-add-up")).toBe(
      "compromise-response",
    );
  });

  test("the forwardable message asks about the run that raised the condition", () => {
    const withCondition = record({
      lastRun: { at: LATER_AT, outcome: "missed" },
      standingCondition: { since: RAISED_AT, kind: "auth" },
    });
    const raised = record({
      lastRun: { at: RAISED_AT, outcome: "failed", failureKind: "auth" },
    });
    expect(composeManagedFailureConfirmation(withCondition).message).toBe(
      composeManagedFailureConfirmation(raised).message,
    );
  });

  test("its confirming label states the attestation, not that a reply arrived", () => {
    // The click this label sits on clears the condition and puts a fresh secret on
    // the out-of-band channel, so the label has to name what the operator is
    // attesting to: a real failure on the partner's own side.
    const confirmation = composeManagedFailureConfirmation(record());
    expect(confirmation.confirmedOption).toBe(
      "Partner confirmed their own failure",
    );
    expect(confirmation.doesNotAddUpOption).toBe("Something does not add up");
  });
});
