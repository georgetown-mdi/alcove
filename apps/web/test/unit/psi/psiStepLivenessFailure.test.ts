import {
  ConnectionError,
  LOCAL_FAULT_ABORT_REASON,
  OLDER_PARTNER_AT_MATCHING_MESSAGE,
  PARTNER_STOPPED_RESPONDING_REMEDY,
  PeerAbortError,
  failureCauseSentence,
  markFailureCause,
  markStatesItsOwnNextStep,
} from "@alcove/core";
import { describe, expect, test, vi } from "vitest";
import { PartnerProtocolRefusalError } from "@alcove/core/testing";

import {
  classifyManagedRunFailure,
  managedRunRetryable,
} from "@recurring/managedRunLaunchModel";
import { PARTNER_STOPPED_RESPONDING_TITLE } from "@psi/managed/managedFailureCopy";
import { failureFor } from "@exchange/useInviterExchange";
import { rerunFailureLastRun } from "@psi/managed/managedRun";

import { managedRecordFixture as record } from "../../utils/managedRecordFixture";

import type { FailureCause } from "@alcove/core";

vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../../utils/clientConfigMock")).clientConfigMock(
    importOriginal,
    { isConsoleBuild: () => false },
  ),
);

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = Date.parse("2026-07-14T09:00:00.000Z");

const SILENCE: FailureCause = {
  kind: "partner-stopped-responding",
  silentMs: 120_000,
};

/** The receive failure the partner-silence bound raises, bare and behind the
 * transport wrap the message bridge adds. */
function silenceErrors(): Array<Error> {
  const bare = markFailureCause(
    new ConnectionError(failureCauseSentence(SILENCE), "transport"),
    SILENCE,
  );
  return [
    bare,
    new ConnectionError("receive failed", "transport", { cause: bare }),
  ];
}

const SILENCE_MESSAGE =
  "Your partner stopped responding during matching: nothing arrived from " +
  `them for 2 minutes. ${PARTNER_STOPPED_RESPONDING_REMEDY}`;

/** The refusal of a partner whose first message in the PSI phase is data or a
 * local-fault abort, built as the still-working layer builds it. */
function olderPartnerErrors(): Array<Error> {
  const refusal = (cause?: PeerAbortError): Error =>
    markStatesItsOwnNextStep(
      new PartnerProtocolRefusalError(OLDER_PARTNER_AT_MATCHING_MESSAGE, {
        olderVersion: "partner",
        ...(cause === undefined ? {} : { cause }),
      }),
    );
  return [refusal(), refusal(new PeerAbortError({}, LOCAL_FAULT_ABORT_REASON))];
}

const DIFFERENT_VERSIONS_TITLE =
  "You and your partner run different versions of Alcove";

const OLDER_PARTNER_REMEDY =
  "Your partner runs the older version: ask them to update Alcove.";

/** A managed run's live alert for `error`, against the record this run
 * stamped. */
function managedLive(
  error: Error,
): ReturnType<typeof classifyManagedRunFailure> {
  const lastRun = rerunFailureLastRun(error, RUN_AT, false, true);
  return classifyManagedRunFailure(
    error,
    { atLaunch: record(), afterRun: { ...record(), lastRun } },
    undefined,
    NOW,
    true,
  );
}

describe("a partner that stopped responding during matching", () => {
  test.each(["inviter", "acceptor"] as const)(
    "the %s seat's alert names it with core's remedy, and offers a retry",
    (seat) => {
      for (const error of silenceErrors())
        expect(
          failureFor("exchange", error, { channel: "browser", seat }),
        ).toMatchObject({
          category: "exchange",
          title: PARTNER_STOPPED_RESPONDING_TITLE,
          message: SILENCE_MESSAGE,
          retry: "offered",
        });
    },
  );

  test("a managed run's live alert names it with core's remedy, and offers a retry", () => {
    for (const error of silenceErrors()) {
      const failure = managedLive(error);
      expect(failure).toMatchObject({
        kind: "partner-stopped-responding",
        title: PARTNER_STOPPED_RESPONDING_TITLE,
        message: SILENCE_MESSAGE,
      });
      expect(failure.reportedCause).toBeUndefined();
      expect(managedRunRetryable(failure)).toBe(true);
    }
  });
});

describe("a partner on an older version at the start of matching", () => {
  test.each(["inviter", "acceptor"] as const)(
    "the %s seat's alert is the different-versions copy naming the partner",
    (seat) => {
      for (const error of olderPartnerErrors())
        expect(
          failureFor("exchange", error, { channel: "browser", seat }),
        ).toMatchObject({
          category: "config",
          title: DIFFERENT_VERSIONS_TITLE,
          message: expect.stringContaining(OLDER_PARTNER_REMEDY),
          retry: "withheld",
        });
    },
  );

  test("a managed run's live alert is the different-versions copy naming the partner", () => {
    for (const error of olderPartnerErrors()) {
      const failure = managedLive(error);
      expect(failure).toMatchObject({
        kind: "partner-protocol-refusal",
        title: DIFFERENT_VERSIONS_TITLE,
        message: expect.stringContaining(OLDER_PARTNER_REMEDY),
      });
      expect(managedRunRetryable(failure)).toBe(false);
    }
  });
});
