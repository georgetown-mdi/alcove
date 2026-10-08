import {
  BROWSER_PSI_SET_MAX_ELEMENTS,
  MAX_PSI_DECODE_ELEMENTS,
  PSI_SET_REFUSED_ABORT_REASON,
  PSI_SET_TOO_LARGE_ABORT_REASON,
  PeerAbortError,
  RoundCapacityError,
  RoundSetLimitError,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@alcove/core";
import {
  PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
  PSIParticipant,
  PSI_SET_PART_HEADER_BYTES,
  psiSetByteBound,
} from "@alcove/core/testing";
import { describe, expect, test } from "vitest";
import PSI from "@openmined/psi.js";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
  lastRunSchema,
} from "@psi/managed/managedExchangeRecord";
import {
  PARTNER_REFUSED_SET_TITLE,
  PARTNER_SET_TOO_LARGE_TITLE,
} from "@psi/managed/managedFailureCopy";
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
import type { MessageConnection } from "@alcove/core";

// A browser party's refusal, at a set's first part, of a partner whose set for
// a linkage key holds more values than this browser can match: its own
// title and copy on the one-shot seats, and a non-retryable state of its own
// on a managed exchange's record, next visit, notification, and list row.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";

const refusal = new RoundCapacityError(
  "Too large for this browser: your partner's set for one linkage key can " +
    "hold up to 9000000 values, over the 7643790 a browser exchange can " +
    "match, so the exchange stopped before any linkage key was sent and " +
    "told your partner.",
  "terms-exchange",
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

const stampedInRound: ManagedExchangeLastRun = {
  ...stamped,
  refusedInRound: true,
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
    expect(failure.settingsCannotResolve).toBe(true);
  });

  test("states a partner's abort over this browser's ceiling, with no retry", () => {
    const failure = failureFor(
      "exchange",
      new PeerAbortError(undefined, PSI_SET_TOO_LARGE_ABORT_REASON),
    );
    expect(failure.category).toBe("config");
    expect(failure.title).toBe(PARTNER_SET_TOO_LARGE_TITLE);
    expect(failure.message).toMatch(
      /^The exchange stopped because your partner's set of values for a linkage key is larger than this browser can match\. .*command-line application/,
    );
    expect(failure.reportedCause).toBeUndefined();
    expect(failure.retry).toBe("withheld");
    expect(failure.settingsCannotResolve).toBe(true);
  });

  test("states a partner's refusal of its own set, with no retry", () => {
    const failure = failureFor(
      "exchange",
      new PeerAbortError(undefined, PSI_SET_REFUSED_ABORT_REASON),
    );
    expect(failure.category).toBe("config");
    expect(failure.title).toBe(PARTNER_REFUSED_SET_TITLE);
    expect(failure.message).toMatch(
      /^The exchange stopped because your partner's run refused to send its set of values\. .*ask your partner to fix the cause/,
    );
    expect(failure.reportedCause).toBeUndefined();
    expect(failure.retry).toBe("withheld");
    expect(failure.settingsCannotResolve).toBe(true);
  });

  test("keeps the generic copy for any other partner abort", () => {
    const generic = failureFor("exchange", new PeerAbortError());
    expect(generic.category).toBe("exchange");
    expect(generic.title).toBe("Exchange failed");
    expect(generic.retry).toBe("offered");
    expect(generic.settingsCannotResolve).toBeUndefined();
    expect(
      failureFor(
        "exchange",
        new PeerAbortError(undefined, PARTNER_SET_OVER_CAPACITY_ABORT_REASON),
      ),
    ).toEqual(generic);
  });

  test("a one-shot set of this party's own too large to send is one no settings change resolves", () => {
    const failure = failureFor(
      "exchange",
      new RoundSetLimitError("too many values", "over-set-maximum"),
    );
    expect(failure.category).toBe("config");
    expect(failure.settingsCannotResolve).toBe(true);
  });

  test("a one-shot config fault in this party's settings leaves its settings recovery", () => {
    const failure = failureFor("config", new Error("a settings fault"));
    expect(failure.category).toBe("config");
    expect(failure.settingsCannotResolve).toBeUndefined();
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

  test("a partner setup refused at its first part, within the record counts but over the browser's ceiling, records the same kind rather than transport", async () => {
    // The first of two parts of a setup one byte longer than the browser's
    // ceiling admits and well within what the record counts admit, held to
    // the receive ceiling the browser's connection states.
    const declaredBytes = psiSetByteBound(BROWSER_PSI_SET_MAX_ELEMENTS) + 1;
    const firstPart = new Uint8Array(PSI_SET_PART_HEADER_BYTES + 1);
    const header = new DataView(firstPart.buffer);
    header.setUint32(0, 0);
    header.setUint32(4, 2);
    header.setBigUint64(8, BigInt(declaredBytes));
    const inbound: Array<unknown> = [firstPart];
    const sent: Array<unknown> = [];
    const conn: MessageConnection = {
      send: (data) => {
        sent.push(data);
        return Promise.resolve();
      },
      receive: () =>
        inbound.length > 0
          ? Promise.resolve(inbound.shift())
          : new Promise(() => {}),
      close: () => Promise.resolve(),
    };
    const joiner = new PSIParticipant(
      "client",
      await PSI(),
      { role: "joiner", verbose: -1 },
      {
        setup: MAX_PSI_DECODE_ELEMENTS,
        request: MAX_PSI_DECODE_ELEMENTS,
      },
      undefined,
      undefined,
      { local: BROWSER_PSI_SET_MAX_ELEMENTS, partner: MAX_PSI_DECODE_ELEMENTS },
    );
    const error = await joiner.identifyIntersection(conn, ["a", "b"]).then(
      () => undefined,
      (err: unknown) => err,
    );
    joiner.dispose();
    expect(error).toBeInstanceOf(RoundCapacityError);
    expect((error as RoundCapacityError).stage).toBe("set-first-part");
    expect(sent).toEqual([
      {
        decision: "abort",
        abortReasons: [PARTNER_SET_OVER_CAPACITY_ABORT_REASON],
      },
    ]);
    for (const dataExchangeStarted of [false, true]) {
      const lastRun = rerunFailureLastRun(
        error,
        Date.parse(RUN_AT),
        false,
        dataExchangeStarted,
      );
      expect(lastRun).toEqual(stampedInRound);
      expect(lastRunSchema.safeParse(lastRun).success).toBe(true);
      expect(
        deriveManagedFailureTier(record({ lastRun }), undefined, NOW),
      ).toBe("partner-set-too-large");
    }
    const failure = classifyManagedRunFailure(
      error,
      { atLaunch: record(), afterRun: record({ lastRun: stampedInRound }) },
      undefined,
      NOW,
      true,
    );
    expect(failure.kind).toBe("partner-set-too-large");
    expect(managedRunRetryable(failure)).toBe(false);
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

  test("the run history states nothing was disclosed for a refusal at the terms exchange", () => {
    expect(lastRunMayHaveSentPayload({ lastRun: stamped })).toBe(false);
    expect(runHistoryEntries({ lastRun: stamped })[0].disclosure).toBe(
      "Nothing was disclosed - the run stopped before any data was exchanged.",
    );
  });

  test("the run history leaves a payload sent open for a refusal at a set's first part", () => {
    expect(lastRunMayHaveSentPayload({ lastRun: stampedInRound })).toBe(true);
    expect(runHistoryEntries({ lastRun: stampedInRound })[0].disclosure).toBe(
      "The run did not complete. Whether any data reached your partner is " +
        "not recorded here; check the accounting of disclosures below, where " +
        "a run that sent your columns files its record.",
    );
  });

  test("the record admits the in-round marker only as true", () => {
    expect(lastRunSchema.safeParse(stampedInRound).success).toBe(true);
    expect(
      lastRunSchema.safeParse({ ...stamped, refusedInRound: false }).success,
    ).toBe(false);
  });
});

describe("a managed exchange the partner stopped over this browser's ceiling", () => {
  const partnerAbort = new PeerAbortError(
    undefined,
    PSI_SET_TOO_LARGE_ABORT_REASON,
  );

  test("records the partner's abort as its own non-retryable kind, with the payload left open", () => {
    for (const dataExchangeStarted of [false, true]) {
      const lastRun = rerunFailureLastRun(
        partnerAbort,
        Date.parse(RUN_AT),
        false,
        dataExchangeStarted,
      );
      expect(lastRun).toEqual(stampedInRound);
      expect(lastRunSchema.safeParse(lastRun).success).toBe(true);
      expect(benignRerunOutcome(partnerAbort, dataExchangeStarted)).toBe(
        "partner-set-too-large",
      );
    }
  });

  test("a live launch states the recorded cause and remedy and offers no retry", () => {
    const failure = classifyManagedRunFailure(
      partnerAbort,
      { atLaunch: record(), afterRun: record({ lastRun: stampedInRound }) },
      undefined,
      NOW,
      true,
    );
    if (failure.kind === "handed-off")
      throw new Error("expected the partner-set-too-large alert");
    expect(failure.kind).toBe("partner-set-too-large");
    expect(failure.title).toBe(PARTNER_SET_TOO_LARGE_TITLE);
    expect(failure.message).toMatch(
      /^The last run stopped because your partner's set of values for a linkage key is larger than this browser can match\./,
    );
    expect(managedRunRetryable(failure)).toBe(false);
  });

  test("an abort with any other reason, or none, keeps the connection-problem record", () => {
    for (const partnerReason of [
      undefined,
      PARTNER_SET_OVER_CAPACITY_ABORT_REASON,
    ]) {
      const abort = new PeerAbortError(undefined, partnerReason);
      expect(
        rerunFailureLastRun(abort, Date.parse(RUN_AT), false, true),
      ).toEqual({ at: RUN_AT, outcome: "failed", failureKind: "transport" });
      expect(benignRerunOutcome(abort, true)).toBeUndefined();
    }
  });
});

describe("a managed exchange the partner's run refused to send its set for", () => {
  const partnerAbort = new PeerAbortError(
    undefined,
    PSI_SET_REFUSED_ABORT_REASON,
  );
  const refusedInRound: ManagedExchangeLastRun = {
    at: RUN_AT,
    outcome: "failed",
    failureKind: "partner-refused-set",
    refusedInRound: true,
  };

  test("records the partner's abort as its own non-retryable kind, with the payload left open", () => {
    for (const dataExchangeStarted of [false, true]) {
      const lastRun = rerunFailureLastRun(
        partnerAbort,
        Date.parse(RUN_AT),
        false,
        dataExchangeStarted,
      );
      expect(lastRun).toEqual(refusedInRound);
      expect(lastRunSchema.safeParse(lastRun).success).toBe(true);
      expect(benignRerunOutcome(partnerAbort, dataExchangeStarted)).toBe(
        "partner-refused-set",
      );
    }
    expect(lastRunMayHaveSentPayload({ lastRun: refusedInRound })).toBe(true);
  });

  test("a live launch and the next visit state the cause and offer no retry", () => {
    const live = classifyManagedRunFailure(
      partnerAbort,
      { atLaunch: record(), afterRun: record({ lastRun: refusedInRound }) },
      undefined,
      NOW,
      true,
    );
    const recorded = managedRunFailureFromRecord(
      record({ lastRun: refusedInRound }),
      undefined,
      NOW,
    );
    for (const failure of [live, recorded]) {
      if (failure === undefined || failure.kind === "handed-off")
        throw new Error("expected the partner-refused-set alert");
      expect(failure.kind).toBe("partner-refused-set");
      expect(failure.title).toBe(PARTNER_REFUSED_SET_TITLE);
      expect(failure.message).toMatch(
        /^The last run stopped because your partner's run refused to send its set of values\. .*ask your partner/,
      );
      expect(managedRunRetryable(failure)).toBe(false);
    }
  });

  test("an unattended run's notification and list row name the state", () => {
    const stored = record({ lastRun: refusedInRound });
    expect(deriveManagedFailureTier(stored, undefined, NOW)).toBe(
      "partner-refused-set",
    );
    const notice = betweenVisitNotice({
      record: stored,
      local: undefined,
      caughtUpMisses: 0,
      disposition: "failed",
      now: NOW,
    });
    expect(notice?.kind).toBe("partner-refused-set");
    expect(notice?.title).toBe(PARTNER_REFUSED_SET_TITLE);
    expect(notice?.body).toContain("every later window stops the same way");
    expect(savedExchangeRow(stored, undefined, NOW).status).toMatch(
      /^Last run stopped: your partner's run refused to send its set \(.*\); ask your partner$/,
    );
  });
});
