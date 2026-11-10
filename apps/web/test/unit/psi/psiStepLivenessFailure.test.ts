import {
  ConnectionError,
  LOCAL_FAULT_ABORT_REASON,
  OLDER_PARTNER_AT_MATCHING_MESSAGE,
  PARTNER_STOPPED_AT_MATCHING_MESSAGE,
  PARTNER_STOPPED_RESPONDING_REMEDY,
  PeerAbortError,
  failureCauseSentence,
  markFailureCause,
  markStatesItsOwnNextStep,
  shardStalledError,
} from "@alcove/core";
import { describe, expect, test, vi } from "vitest";
import { PartnerProtocolRefusalError } from "@alcove/core/testing";

import {
  classifyManagedRunFailure,
  managedRunFailureFromRecord,
  managedRunRetryable,
} from "@recurring/managedRunLaunchModel";
import { BROWSER_PSI_SHARD_PROGRESS_TIMEOUT_MS } from "@psi/workers/psiShardPolicy";
import { PARTNER_STOPPED_RESPONDING_TITLE } from "@psi/managed/managedFailureCopy";
import { betweenVisitNotice } from "@psi/managed/betweenVisitNotice";
import { failureFor } from "@exchange/useInviterExchange";
import { rerunFailureLastRun } from "@psi/managed/managedRun";
import { runHistoryEntries } from "@recurring/managedDetailModel";
import { savedExchangeRow } from "@recurring/savedExchangesModel";

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

/** The refusal of a partner whose first message in the PSI phase is data,
 * built as the still-working layer builds it. */
function olderPartnerError(): Error {
  return markStatesItsOwnNextStep(
    new PartnerProtocolRefusalError(OLDER_PARTNER_AT_MATCHING_MESSAGE, {
      olderVersion: "partner",
    }),
  );
}

/** The refusal of a partner whose first message in the PSI phase is its
 * local-fault abort, built as the still-working layer builds it, bare and
 * behind the transport wrap the message bridge adds. */
function stopAtMatchingStartErrors(): Array<Error> {
  const bare = markStatesItsOwnNextStep(
    new PartnerProtocolRefusalError(PARTNER_STOPPED_AT_MATCHING_MESSAGE, {
      cause: new PeerAbortError({}, LOCAL_FAULT_ABORT_REASON),
    }),
  );
  return [
    bare,
    new ConnectionError("receive failed", "transport", { cause: bare }),
  ];
}

const STOP_AT_MATCHING_START_TITLE = "Matching could not start";

const STOP_AT_MATCHING_START_MESSAGE =
  "Your partner's run stopped. Make sure you both run the current version " +
  "of Alcove, then run the exchange again.";

/** A split operation's stall as the worker pool raises it, bare and behind
 * the transport wrap the message bridge adds. */
function stalledErrors(): Array<Error> {
  const bare = shardStalledError(BROWSER_PSI_SHARD_PROGRESS_TIMEOUT_MS);
  return [
    bare,
    new ConnectionError("receive failed", "transport", { cause: bare }),
  ];
}

const STALLED_TITLE = "Encrypting the data made no progress";

const STALLED_MESSAGE =
  "Encrypting the data made no progress for 33 minutes. Run the exchange " +
  "again.";

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

  test("a managed run records the cause, and the next visit names it", () => {
    for (const error of silenceErrors()) {
      const lastRun = rerunFailureLastRun(error, RUN_AT, false, true);
      expect(lastRun).toMatchObject({
        outcome: "failed",
        failureKind: "partner-stopped-responding",
      });
      const stored = { ...record(), lastRun };
      const failure = managedRunFailureFromRecord(stored, undefined, NOW);
      expect(failure).toMatchObject({
        kind: "partner-stopped-responding",
        title: PARTNER_STOPPED_RESPONDING_TITLE,
        message: SILENCE_MESSAGE,
      });
      expect(managedRunRetryable(failure!)).toBe(true);
      expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
        /^Last run stopped: your partner stopped responding \(.+\); ask your partner to check their run$/,
      );
      expect(runHistoryEntries(stored)[0]).toMatchObject({
        outcome: "Failed",
        failure: "your partner stopped responding",
      });
    }
  });

  test("a record holding a transport failure displays as the transport state", () => {
    const stored = {
      ...record(),
      lastRun: rerunFailureLastRun(
        new ConnectionError("peer connection closed", "transport"),
        RUN_AT,
        false,
        true,
      ),
    };
    expect(stored.lastRun?.failureKind).toBe("transport");
    expect(managedRunFailureFromRecord(stored, undefined, NOW)?.kind).toBe(
      "transport",
    );
    expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
      /^Last run did not complete \(/,
    );
  });
});

describe("a partner on an older version at the start of matching", () => {
  test.each(["inviter", "acceptor"] as const)(
    "the %s seat's alert is the different-versions copy naming the partner",
    (seat) => {
      expect(
        failureFor("exchange", olderPartnerError(), {
          channel: "browser",
          seat,
        }),
      ).toMatchObject({
        category: "config",
        title: DIFFERENT_VERSIONS_TITLE,
        message: expect.stringContaining(OLDER_PARTNER_REMEDY),
        retry: "withheld",
      });
    },
  );

  test("a managed run's live alert is the different-versions copy naming the partner", () => {
    const failure = managedLive(olderPartnerError());
    expect(failure).toMatchObject({
      kind: "partner-protocol-refusal",
      title: DIFFERENT_VERSIONS_TITLE,
      message: expect.stringContaining(OLDER_PARTNER_REMEDY),
    });
    expect(managedRunRetryable(failure)).toBe(false);
  });
});

describe("a partner whose run stopped as matching started", () => {
  test.each(["inviter", "acceptor"] as const)(
    "the %s seat's alert names no party as older, and withholds a retry",
    (seat) => {
      for (const error of stopAtMatchingStartErrors()) {
        const failure = failureFor("exchange", error, {
          channel: "browser",
          seat,
        });
        expect(failure).toMatchObject({
          category: "config",
          title: STOP_AT_MATCHING_START_TITLE,
          message: STOP_AT_MATCHING_START_MESSAGE,
          retry: "withheld",
        });
        expect(failure.reportedCause).toBeUndefined();
      }
    },
  );

  test("a managed run's live alert names no party as older", () => {
    for (const error of stopAtMatchingStartErrors()) {
      const failure = managedLive(error);
      expect(failure).toMatchObject({
        kind: "partner-stop-at-matching-start",
        title: STOP_AT_MATCHING_START_TITLE,
        message: STOP_AT_MATCHING_START_MESSAGE,
        recovery: "ask-partner",
      });
      expect(failure.reportedCause).toBeUndefined();
    }
  });

  test("a managed run records the stop, and every later surface names it without asking for an update", () => {
    for (const error of stopAtMatchingStartErrors()) {
      const lastRun = rerunFailureLastRun(error, RUN_AT, false, true);
      expect(lastRun).toMatchObject({
        outcome: "failed",
        failureKind: "partner-stop-at-matching-start",
      });
      const stored = { ...record(), lastRun };
      const failure = managedRunFailureFromRecord(stored, undefined, NOW);
      expect(failure).toMatchObject({
        kind: "partner-stop-at-matching-start",
        title: STOP_AT_MATCHING_START_TITLE,
        message: STOP_AT_MATCHING_START_MESSAGE,
        recovery: "ask-partner",
      });
      expect(managedRunRetryable(failure!)).toBe(false);
      expect(
        betweenVisitNotice({
          record: stored,
          local: undefined,
          caughtUpMisses: 0,
          disposition: "failed",
          now: NOW,
        }),
      ).toMatchObject({
        kind: "partner-stop-at-matching-start",
        title: STOP_AT_MATCHING_START_TITLE,
        body:
          "Riverbend quarterly stopped because your partner's run stopped. " +
          "Make sure you both run the current version of Alcove, then run " +
          "the exchange again.",
      });
      expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
        /^Last run stopped: your partner's run stopped \(.+\); make sure you both run the current version of Alcove$/,
      );
      expect(runHistoryEntries(stored)[0]).toMatchObject({
        outcome: "Failed",
        failure: "your partner's run stopped",
      });
    }
  });

  test("a record an earlier build stamped as a protocol refusal keeps that state", () => {
    const stored = {
      ...record(),
      lastRun: {
        at: "2026-07-14T09:00:00.000Z",
        outcome: "failed" as const,
        failureKind: "partner-protocol-refusal" as const,
      },
    };
    expect(managedRunFailureFromRecord(stored, undefined, NOW)?.kind).toBe(
      "partner-protocol-refusal",
    );
  });
});

describe("a split operation whose PSI worker reported no progress", () => {
  test.each(["inviter", "acceptor"] as const)(
    "the %s seat's alert names the stall with core's sentence, and offers a retry",
    (seat) => {
      for (const error of stalledErrors()) {
        const failure = failureFor("exchange", error, {
          channel: "browser",
          seat,
        });
        expect(failure).toMatchObject({
          category: "exchange",
          title: STALLED_TITLE,
          message: STALLED_MESSAGE,
          retry: "offered",
        });
        expect(failure.reportedCause).toBeUndefined();
      }
    },
  );

  test("a managed run's live alert names the stall, offers a retry, and asks for no re-invite", () => {
    for (const error of stalledErrors()) {
      const failure = managedLive(error);
      expect(failure).toMatchObject({
        kind: "shard-stalled",
        title: STALLED_TITLE,
        message: STALLED_MESSAGE,
      });
      expect(failure.reportedCause).toBeUndefined();
      expect(managedRunRetryable(failure)).toBe(true);
    }
  });

  test("a managed run records the stall, and the next visit names it", () => {
    for (const error of stalledErrors()) {
      const lastRun = rerunFailureLastRun(error, RUN_AT, false, true);
      expect(lastRun).toMatchObject({
        outcome: "failed",
        failureKind: "shard-stalled",
      });
      const stored = { ...record(), lastRun };
      const failure = managedRunFailureFromRecord(stored, undefined, NOW);
      expect(failure).toMatchObject({
        kind: "shard-stalled",
        title: STALLED_TITLE,
        message: STALLED_MESSAGE,
      });
      expect(managedRunRetryable(failure!)).toBe(true);
      expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
        /^Last run stopped: encrypting the data made no progress \(.+\); run the exchange again$/,
      );
      expect(runHistoryEntries(stored)[0]).toMatchObject({
        outcome: "Failed",
        failure: "encrypting the data made no progress",
      });
    }
  });
});
