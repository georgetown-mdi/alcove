import {
  ConnectionError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import { describe, expect, test } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  applyManagedExchangeCompromiseResponse,
  applyManagedExchangeLastRun,
  composeManagedExchangeFile,
  raisedStandingCondition,
} from "@psi/managed/managedExchangeRecord";
import {
  classifyManagedRunFailure,
  managedRunFailureFromRecord,
  managedRunReinvites,
} from "@recurring/managedRunLaunchModel";
import { betweenVisitNotice } from "@psi/managed/betweenVisitNotice";
import { composeConfirmationMessage } from "@psi/managed/managedFailureConfirmation";
import { dateTimeLabel } from "@psi/formatting";
import { managedStandingConditionView } from "@recurring/managedStandingConditionModel";
import { readManagedFailure } from "@psi/managed/managedFailureTiers";
import { savedExchangeRow } from "@recurring/savedExchangesModel";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";

// This device could not save a rotated secret, a later run succeeded, and a
// run after that failed closed at the handshake. The success shows both sides
// on one secret again, so the failed save no longer explains the handshake.

const FAILED_SAVE_AT = "2026-07-14T09:00:00.000Z";
const SUCCEEDED_AT = "2026-07-21T09:00:00.000Z";
const AUTH_AT = "2026-07-28T09:00:00.000Z";
const NOW = Date.parse("2026-07-28T12:00:00.000Z");

function record(): ManagedExchangeRecord {
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
  };
}

function write(
  stored: ManagedExchangeRecord,
  lastRun: ManagedExchangeLastRun,
): ManagedExchangeRecord {
  const atMs = Date.parse(lastRun.at);
  return applyManagedExchangeLastRun(stored, lastRun, atMs, atMs);
}

const failedSave = (): ManagedExchangeRecord =>
  write(record(), {
    at: FAILED_SAVE_AT,
    outcome: "failed",
    failureKind: "storage",
  });
const healed = (): ManagedExchangeRecord =>
  write(failedSave(), { at: SUCCEEDED_AT, outcome: "succeeded" });
const failedHandshake = (): ManagedExchangeRecord =>
  write(healed(), { at: AUTH_AT, outcome: "failed", failureKind: "auth" });

describe("a success after this device's failed save", () => {
  test("clears the condition, and no surface shows the save alert", () => {
    expect(raisedStandingCondition(failedSave())?.kind).toBe("storage");
    const after = healed();
    expect(raisedStandingCondition(after)).toBeUndefined();
    expect(managedStandingConditionView(after, undefined, NOW)).toBeUndefined();
    expect(managedRunFailureFromRecord(after, undefined, NOW)).toBeUndefined();
    expect(savedExchangeRow(after, undefined, NOW).status).toMatch(
      /^Last run succeeded /,
    );
  });
});

describe("a failed handshake after that success", () => {
  test("raises its own auth condition", () => {
    expect(raisedStandingCondition(failedHandshake())).toEqual({
      since: AUTH_AT,
      kind: "auth",
    });
  });

  test("reads as unexplained, with the confirmation and the gate", () => {
    const later = failedHandshake();
    expect(readManagedFailure(later, undefined, NOW)).toEqual({
      tier: "unexplained",
      standing: false,
    });
    const recorded = managedRunFailureFromRecord(later, undefined, NOW);
    expect(recorded?.kind).toBe("unexplained");
    expect(recorded?.recovery).toBe("confirm");
    expect(recorded?.title).not.toBe("The last run could not be saved");

    const live = classifyManagedRunFailure(
      new ConnectionError("could not verify the partner", "security"),
      { atLaunch: healed(), afterRun: later },
      undefined,
      NOW,
      false,
    );
    expect(live.kind).toBe("unexplained");
    expect(managedRunReinvites(live)).toBe(false);

    const view = managedStandingConditionView(later, undefined, NOW);
    expect(view?.tier).toBe("unexplained");
    expect(view?.clearance).toBe("confirmation");

    const message = composeConfirmationMessage(later);
    expect(message).toContain(dateTimeLabel(new Date(AUTH_AT)));
    expect(message).not.toContain(dateTimeLabel(new Date(FAILED_SAVE_AT)));

    expect(savedExchangeRow(later, undefined, NOW).status).toMatch(
      /check with your partner$/,
    );
  });

  test("fires the between-visit notice as the unexplained failure", () => {
    const notice = betweenVisitNotice({
      record: failedHandshake(),
      local: undefined,
      caughtUpMisses: 0,
      disposition: "failed",
      now: NOW,
    });
    expect(notice?.kind).toBe("unexplained");
  });

  test("holds the gate's compromise answer on its own condition", () => {
    const answered = applyManagedExchangeCompromiseResponse(
      failedHandshake(),
      "2026-07-28T10:00:00.000Z",
    );
    expect(raisedStandingCondition(answered)).toMatchObject({
      since: AUTH_AT,
      kind: "auth",
      response: { kind: "compromise" },
    });
  });
});
