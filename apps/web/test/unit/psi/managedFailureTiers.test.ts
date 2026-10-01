import {
  ConnectionError,
  LinkageTermsUnsatisfiableError,
  RoundSetLimitError,
  UsageError,
  assertFirstRoundWithinSetMaximum,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";
import { describe, expect, test, vi } from "vitest";

import {
  MANAGED_EXCHANGE_SCHEMA_VERSION,
  NO_STANDING_CONDITION,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import {
  assessManagedInputColumns,
  managedInputFailureKind,
} from "@psi/managed/managedInputGuard";
import {
  classifyManagedRunFailure,
  managedRunFailureFromRecord,
  managedRunRetryable,
} from "@recurring/managedRunLaunchModel";
import {
  deriveManagedFailureTier,
  importedSinceLastSuccess,
  managedStandingConditionTier,
  readManagedFailure,
} from "@psi/managed/managedFailureTiers";
import {
  remapLapsedRunFailure,
  rerunFailureLastRun,
  tooLargeReadingOf,
} from "@psi/managed/managedRun";
import { StandardizedKeyIterable } from "@alcove/core/testing";
import { prepareManagedRerunExchange } from "@psi/managed/managedPreparedExchange";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { CSVRow } from "@alcove/core";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";

// The desync-versus-attack tier derivation, tested in Node: each recorded benign state
// resolves to its own tier from the record's OWN structured bookkeeping, and only a
// failed-closed handshake with no benign explanation reaches the unexplained tier. The
// evidence is the record's, never a live error, so an unattended run shows the same
// tier at the next visit as an attended one.

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const RUN_AT = "2026-07-14T09:00:00.000Z";

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

function failed(
  failureKind: ManagedExchangeLastRun["failureKind"],
): ManagedExchangeLastRun {
  return { at: RUN_AT, outcome: "failed", failureKind };
}

describe("deriveManagedFailureTier: tier per recorded benign state", () => {
  test("no run yet is none", () => {
    expect(deriveManagedFailureTier(record(), undefined, NOW)).toBe("none");
  });

  test("a succeeded last run is none", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: { at: RUN_AT, outcome: "succeeded" } }),
        undefined,
        NOW,
      ),
    ).toBe("none");
  });

  test("a missed window is its own benign tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: { at: RUN_AT, outcome: "missed" } }),
        undefined,
        NOW,
      ),
    ).toBe("missed");
  });

  test("a skipped window is no failure of its own, and never the no-show tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: { at: RUN_AT, outcome: "skipped" } }),
        undefined,
        NOW,
      ),
    ).toBe("none");
  });

  test("a recorded input failure is the benign input tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("input") }),
        undefined,
        NOW,
      ),
    ).toBe("input");
  });

  test("a recorded storage persist failure is the Tier-1 storage state", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("storage") }),
        undefined,
        NOW,
      ),
    ).toBe("storage");
  });

  test("a recorded unreadable custody entry is its own tier, not the storage one", () => {
    // The two are both this device's own storage, and they leave different states
    // behind: the persist failure rotated a secret it could not save, this one
    // refused before the handshake and rotated nothing.
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("custody-unreadable") }),
        undefined,
        NOW,
      ),
    ).toBe("custody-unreadable");
  });

  test("a transport drop is the transport (retry) tier, never attack framing", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("transport") }),
        undefined,
        NOW,
      ),
    ).toBe("transport");
  });

  test("a recorded hand-off refusal is its own benign tier, not the attack one", () => {
    // The kind a run stamps when it meets a copy an export gave away. Falling
    // through to the unexplained tier would put the out-of-band attack checklist
    // in front of an operator whose own hand-off is the whole explanation.
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("handed-off") }),
        { spent: { spentAt: "2026-07-13T09:00:00.000Z" } },
        NOW,
      ),
    ).toBe("handed-off");
  });

  test("a cancelled run is treated as a retry, not a failure to tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("cancelled") }),
        undefined,
        NOW,
      ),
    ).toBe("transport");
  });

  test("a lapsed bound is the expiry tier, whatever the last recorded run was", () => {
    expect(
      deriveManagedFailureTier(
        record({
          expires: "2026-07-01T00:00:00.000Z",
          lastRun: failed("auth"),
        }),
        undefined,
        NOW,
      ),
    ).toBe("expired");
  });
});

describe("deriveManagedFailureTier: a transport drop from the runner", () => {
  test("a genuine transport drop still tiers as transport", () => {
    const lastRun = rerunFailureLastRun(
      new ConnectionError("data channel dropped", "transport"),
      Date.parse(RUN_AT),
      false,
      false,
    );
    expect(lastRun?.failureKind).toBe("transport");
    expect(deriveManagedFailureTier(record({ lastRun }), undefined, NOW)).toBe(
      "transport",
    );
  });
});

describe("deriveManagedFailureTier: the terms-shortfall tier, from the real refusals", () => {
  // Both refusals are driven for real -- the run-start guard's own grading and
  // core's refusal at the run boundary -- and tiered from what each stamped, so
  // the chain from an input that cannot match on every agreed key to the
  // operator-facing tier is pinned rather than a hand-built failureKind.
  const agreedColumns = ["ssn", "first_name", "last_name", "date_of_birth"];
  const shortColumns = ["first_name", "last_name", "date_of_birth"];
  const shortRows: Array<CSVRow> = [
    { first_name: "Ada", last_name: "Lovelace", date_of_birth: "12/10/1815" },
  ];

  /** A stored document whose standing terms are the defaults over the full agreed
   * column set, so a refresh that dropped one of them falls short of a key. */
  function agreedExchangeFile(): ManagedExchangeRecord["exchangeFile"] {
    return composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms(
        "County Health Dept",
        inferMetadata(agreedColumns, []),
      ),
    });
  }

  test("the guard's own column rejection tiers as terms-shortfall", () => {
    const rejection = assessManagedInputColumns(
      agreedExchangeFile(),
      shortColumns,
    );
    if (rejection === undefined) throw new Error("expected a rejection");
    const lastRun: ManagedExchangeLastRun = {
      at: RUN_AT,
      outcome: "failed",
      failureKind: managedInputFailureKind(rejection),
    };
    expect(lastRun.failureKind).toBe("terms-shortfall");
    expect(deriveManagedFailureTier(record({ lastRun }), undefined, NOW)).toBe(
      "terms-shortfall",
    );
  });

  test("core's own run-boundary refusal tiers as terms-shortfall", () => {
    let thrown: unknown;
    try {
      prepareManagedRerunExchange(
        agreedExchangeFile(),
        shortRows,
        shortColumns,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LinkageTermsUnsatisfiableError);
    const lastRun = rerunFailureLastRun(
      thrown,
      Date.parse(RUN_AT),
      false,
      false,
    );
    expect(lastRun?.failureKind).toBe("terms-shortfall");
    expect(deriveManagedFailureTier(record({ lastRun }), undefined, NOW)).toBe(
      "terms-shortfall",
    );
  });
});

describe("deriveManagedFailureTier: the import/restore tier", () => {
  const imported: ManagedLocalState = {
    imported: { importedAt: "2026-07-13T00:00:00.000Z" },
  };

  test("an auth failure with an import marker is the benign imported tier", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("auth") }),
        imported,
        NOW,
      ),
    ).toBe("imported");
  });

  test("a transport drop with a standing import marker is still the transport tier", () => {
    // The import marker explains only a failed-CLOSED (auth) handshake -- a stale
    // restored secret cannot authenticate. A transport drop is a connection problem the
    // marker does not bear on, so it stays the retryable transport tier, not mis-tiered
    // as the benign imported tier.
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("transport") }),
        imported,
        NOW,
      ),
    ).toBe("transport");
  });

  test("importedSinceLastSuccess reads the marker's presence alone", () => {
    // The marker is cleared on the first rotation after an import (a completed
    // handshake proves sync), so its mere presence is the "restored and not yet
    // successfully run since" evidence -- no timestamp comparison.
    expect(importedSinceLastSuccess(imported)).toBe(true);
    expect(importedSinceLastSuccess(undefined)).toBe(false);
    expect(importedSinceLastSuccess({})).toBe(false);
  });
});

describe("deriveManagedFailureTier: the unexplained tier and the secret-farming caveat", () => {
  test("a failed-closed handshake with no benign explanation is unexplained", () => {
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("auth") }),
        undefined,
        NOW,
      ),
    ).toBe("unexplained");
  });

  test("a backup marker alone does NOT explain an auth failure (only the import marker does)", () => {
    // A record with a current backup but no import is NOT a restore -- an active
    // impersonator must not be able to farm a benign reading from an unrelated marker.
    const backedUp: ManagedLocalState = {
      backup: { backedUpAt: "2026-07-13T00:00:00.000Z" },
    };
    expect(
      deriveManagedFailureTier(
        record({ lastRun: failed("auth") }),
        backedUp,
        NOW,
      ),
    ).toBe("unexplained");
  });
});

// The standing condition beside the run stamp: the evidence a later stamp would
// otherwise consume. A no-show replaces `lastRun` with an entry holding no failure
// kind at all, so without it the confirmation the design reserves for a
// failed-closed handshake would be asked for once and never again.

const RAISED_AT = "2026-07-14T08:00:00.000Z";
const LATER_RUN_AT = "2026-07-14T10:00:00.000Z";

describe("readManagedFailure: a standing condition outlives the stamps after it", () => {
  test("an unexplained handshake failure survives a later no-show", () => {
    expect(
      readManagedFailure(
        record({
          lastRun: { at: LATER_RUN_AT, outcome: "missed" },
          standingCondition: { since: RAISED_AT, kind: "auth" },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "unexplained", standing: true });
  });

  test("a persist failure survives a later no-show", () => {
    expect(
      readManagedFailure(
        record({
          lastRun: { at: LATER_RUN_AT, outcome: "missed" },
          standingCondition: { since: RAISED_AT, kind: "storage" },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "storage", standing: true });
  });

  test("the answered condition still reads through the window it skipped", () => {
    // The stamp a skipped window leaves holds no failure, so the condition the
    // operator's answer rides on is what the surfaces show across it.
    expect(
      readManagedFailure(
        record({
          lastRun: { at: LATER_RUN_AT, outcome: "skipped" },
          standingCondition: {
            since: RAISED_AT,
            kind: "auth",
            response: { kind: "compromise", at: LATER_RUN_AT },
          },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "unexplained", standing: true });
  });

  test("it survives however many no-shows follow: the reading is of the condition, not the run", () => {
    // Every later visit reads the same record shape, so a second, third, and
    // hundredth no-show cannot consume what the first one did not.
    const record_ = record({
      lastRun: { at: LATER_RUN_AT, outcome: "missed" },
      standingCondition: { since: RAISED_AT, kind: "auth" },
    });
    for (const now of [NOW, NOW + 86_400_000, NOW + 400 * 86_400_000])
      expect(readManagedFailure(record_, undefined, now).tier).toBe(
        "unexplained",
      );
  });

  test("a successful run does not settle it either", () => {
    // A later success rules out neither a third party's attempt nor an accidental
    // self-fork, so it is not the all-clear it reads as.
    expect(
      readManagedFailure(
        record({
          lastRun: { at: LATER_RUN_AT, outcome: "succeeded" },
          standingCondition: { since: RAISED_AT, kind: "auth" },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "unexplained", standing: true });
  });

  test("a record with no condition reads exactly as it did", () => {
    expect(
      readManagedFailure(
        record({ lastRun: { at: LATER_RUN_AT, outcome: "missed" } }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "missed", standing: false });
  });

  test("a standing handshake failure is the benign import state while a restore stands", () => {
    const restored: ManagedLocalState = {
      imported: { importedAt: "2026-07-13T00:00:00.000Z" },
    };
    expect(
      readManagedFailure(
        record({
          lastRun: { at: LATER_RUN_AT, outcome: "missed" },
          standingCondition: { since: RAISED_AT, kind: "auth" },
        }),
        restored,
        NOW,
      ),
    ).toEqual({ tier: "imported", standing: true });
  });

  test("a standing persist failure explains a freshly recorded unexplained handshake", () => {
    // Tier 1's "the record holds a benign explanation", made durable: the desync a
    // persist failure may have left is what the handshake is failing on.
    expect(
      readManagedFailure(
        record({
          lastRun: failed("auth"),
          standingCondition: { since: RAISED_AT, kind: "storage" },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "storage", standing: true });
  });

  test("it does not displace a recorded benign cause the operator can act on", () => {
    // The input problem is this run's own actionable state; the condition stands and
    // is read again as soon as the record's bookkeeping has no failure to show.
    expect(
      readManagedFailure(
        record({
          lastRun: failed("input"),
          standingCondition: { since: RAISED_AT, kind: "auth" },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "input", standing: false });
  });

  test("a lapsed bound still reads first, never through the attack framing", () => {
    expect(
      readManagedFailure(
        record({
          expires: "2026-07-14T00:00:00.000Z",
          lastRun: { at: LATER_RUN_AT, outcome: "missed" },
          standingCondition: { since: RAISED_AT, kind: "auth" },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "expired", standing: false });
  });
});

describe("managedStandingConditionTier", () => {
  test("a persist failure is the storage tier whatever the local markers say", () => {
    const restored: ManagedLocalState = {
      imported: { importedAt: "2026-07-13T00:00:00.000Z" },
    };
    expect(
      managedStandingConditionTier(
        { since: RAISED_AT, kind: "storage" },
        restored,
      ),
    ).toBe("storage");
  });

  test("a handshake failure is unexplained once the restore has been consumed", () => {
    // The import marker is cleared by the first rotation after an import, so a
    // success since the restore leaves nothing to explain the failure.
    expect(
      managedStandingConditionTier({ since: RAISED_AT, kind: "auth" }, {}),
    ).toBe("unexplained");
  });
});

describe("the too-large tier: a set over a bound the exchange cannot send past", () => {
  // The refusal an unattended run meets when its input is over a bound the
  // exchange cannot send past (the most values the partner can receive).
  // Reconnecting sends the same set, so it tiers apart from the retryable
  // transport drop, and its copy names splitting the input.
  const columns = ["ssn", "ssn4", "first_name", "last_name", "date_of_birth"];
  const rows: Array<CSVRow> = [
    {
      ssn: "123-45-6789",
      ssn4: "6789",
      first_name: "Ada",
      last_name: "Lovelace",
      date_of_birth: "12/10/1815",
    },
    {
      ssn: "987-65-4321",
      ssn4: "4321",
      first_name: "Alan",
      last_name: "Turing",
      date_of_birth: "06/23/1912",
    },
  ];

  /** The first-round check's real refusal, at a bound two values cross. */
  async function firstRoundRefusal(): Promise<unknown> {
    const prepared = prepareManagedRerunExchange(
      record().exchangeFile,
      rows,
      columns,
    );
    try {
      await assertFirstRoundWithinSetMaximum(prepared, { maxValues: 0 });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  /** The same check's real refusal when its count throws before reaching a
   * size. */
  async function firstRoundUncounted(): Promise<unknown> {
    const failure = new RangeError("Map maximum size exceeded");
    const count = vi
      .spyOn(StandardizedKeyIterable.prototype, Symbol.iterator)
      .mockImplementation(() => {
        throw failure;
      });
    try {
      return await firstRoundRefusal();
    } finally {
      count.mockRestore();
    }
  }

  const roundRefusal = new RoundSetLimitError(
    "Too large for your partner: the set this party sends for this linkage " +
      "key holds 8000000 values, over the 7643790 your partner can receive " +
      "in one PSI set, so the exchange stopped before sending it and told " +
      "your partner.",
    "over-partner-ceiling",
  );

  test("the first-round refusal and a round's refusal both record too-large, each with the bound it found crossed", async () => {
    const beforeConnecting = await firstRoundRefusal();
    expect(beforeConnecting).toBeInstanceOf(RoundSetLimitError);
    expect((beforeConnecting as RoundSetLimitError).reason).toBe(
      "over-set-maximum",
    );
    const at = Date.parse(RUN_AT);
    for (const [error, dataExchangeStarted, bound] of [
      [beforeConnecting, false, {}],
      [roundRefusal, true, { tooLargeBound: "partner-ceiling" }],
    ] as const) {
      const lastRun = rerunFailureLastRun(
        error,
        at,
        false,
        dataExchangeStarted,
      );
      expect(lastRun).toEqual({
        at: RUN_AT,
        outcome: "failed",
        failureKind: "too-large",
        ...bound,
      });
      expect(
        deriveManagedFailureTier(record({ lastRun }), undefined, NOW),
      ).toBe("too-large");
    }
  });

  test("the reading is the refusal's reason, whatever cause it holds", () => {
    const cause = new RangeError("an unrelated cause");
    expect(
      tooLargeReadingOf(
        new RoundSetLimitError("over", "over-partner-ceiling", { cause }),
      ),
    ).toEqual({ tooLargeBound: "partner-ceiling" });
    expect(
      tooLargeReadingOf(
        new RoundSetLimitError("over", "over-set-maximum", { cause }),
      ),
    ).toEqual({});
    expect(
      tooLargeReadingOf(new RoundSetLimitError("uncounted", "uncounted")),
    ).toEqual({ setUncounted: true });
  });

  test("a lapsed bound does not turn the refusal into an expiry", () => {
    expect(
      remapLapsedRunFailure(
        roundRefusal,
        { expires: "2026-07-01T00:00:00.000Z" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("a refusal over the per-set maximum names no bound", () => {
    const lastRun = rerunFailureLastRun(
      new RoundSetLimitError("over the per-set maximum", "over-set-maximum"),
      Date.parse(RUN_AT),
      false,
      true,
    );
    expect(lastRun?.failureKind).toBe("too-large");
    expect(lastRun).not.toHaveProperty("tooLargeBound");
  });

  test("the next visit states the bound and the remedy, and offers no retry", () => {
    const failure = managedRunFailureFromRecord(
      record({
        lastRun: { ...failed("too-large"), tooLargeBound: "webrtc-message" },
      }),
      undefined,
      NOW,
    );
    expect(failure?.kind).toBe("too-large");
    if (failure === undefined || failure.kind === "handed-off")
      throw new Error("expected the too-large alert");
    expect(failure.message).toContain("256 MiB one WebRTC message can hold");
    expect(failure.message).toContain("Split your input into smaller files");
    expect(failure.message).not.toMatch(/nothing left this device/i);
    expect(failure.recovery).toBe("split");
    expect(managedRunRetryable(failure)).toBe(false);
  });

  test("the next visit names no bound for a record that does not say which", () => {
    const failure = managedRunFailureFromRecord(
      record({ lastRun: failed("too-large") }),
      undefined,
      NOW,
    );
    if (failure === undefined || failure.kind === "handed-off")
      throw new Error("expected the too-large alert");
    expect(failure.message).toContain(
      "built from your input file was too large, so it was not sent",
    );
    expect(failure.message).not.toMatch(/WebRTC/);
  });

  test("the next visit names the partner's ceiling for a set over it", () => {
    const failure = managedRunFailureFromRecord(
      record({
        lastRun: { ...failed("too-large"), tooLargeBound: "partner-ceiling" },
      }),
      undefined,
      NOW,
    );
    if (failure === undefined || failure.kind === "handed-off")
      throw new Error("expected the too-large alert");
    expect(failure.title).toBe(
      "Your file is too large for your partner to receive",
    );
    expect(failure.message).toContain(
      "was over the most values your partner can receive",
    );
    expect(failure.message).toContain("Split your input into smaller files");
    expect(managedRunRetryable(failure)).toBe(false);
  });

  test("the next visit names splitting your own input", () => {
    const failure = managedRunFailureFromRecord(
      record({
        lastRun: { ...failed("too-large"), tooLargeBound: "webrtc-message" },
      }),
      undefined,
      NOW,
    );
    if (failure === undefined || failure.kind === "handed-off")
      throw new Error("expected the too-large alert");
    expect(failure.title).toBe("Your file is too large for a browser exchange");
    expect(failure.message).toContain("built from your input file");
    expect(failure.message).toContain("256 MiB one WebRTC message can hold");
    expect(failure.message).toContain(
      "Split your input into smaller files and set up one exchange for each.",
    );
    expect(failure.message).not.toMatch(/partner/i);
    expect(managedRunRetryable(failure)).toBe(false);
  });

  test("a live launch shows the refusal's own message, on either side of the boundary", async () => {
    for (const [error, dataExchangeStarted] of [
      [await firstRoundRefusal(), false],
      [roundRefusal, true],
    ] as const) {
      const stamped = record({ lastRun: failed("too-large") });
      const failure = classifyManagedRunFailure(
        error,
        { atLaunch: record(), afterRun: stamped },
        undefined,
        NOW,
        dataExchangeStarted,
      );
      if (failure.kind === "handed-off")
        throw new Error("expected the too-large alert");
      expect(failure.kind).toBe("too-large");
      expect(failure.message).toBe((error as Error).message);
      expect(failure.reportedCause).toBeUndefined();
      expect(managedRunRetryable(failure)).toBe(false);
    }
  });

  test("a first round the check cannot count records an uncounted set with no bound", async () => {
    const uncounted = await firstRoundUncounted();
    expect(uncounted).toBeInstanceOf(RoundSetLimitError);
    expect((uncounted as RoundSetLimitError).reason).toBe("uncounted");
    expect(uncounted).toBeInstanceOf(UsageError);
    const lastRun = rerunFailureLastRun(
      uncounted,
      Date.parse(RUN_AT),
      false,
      false,
    );
    expect(lastRun).toEqual({
      at: RUN_AT,
      outcome: "failed",
      failureKind: "too-large",
      setUncounted: true,
    });
    const failure = classifyManagedRunFailure(
      uncounted,
      { atLaunch: record(), afterRun: record({ lastRun }) },
      undefined,
      NOW,
      false,
    );
    if (failure.kind === "handed-off")
      throw new Error("expected the too-large alert");
    expect(failure.kind).toBe("too-large");
    expect(failure.title).toBe(
      "The values built from your file could not be counted",
    );
    expect(failure.message).toContain((uncounted as Error).message);
    expect(failure.message).toContain("Map maximum size exceeded");
    expect(failure.message).not.toMatch(/try again|temporary/i);
    expect(failure.recovery).toBe("split");
    expect(managedRunRetryable(failure)).toBe(false);
  });

  test("the next visit says an uncounted set could not be counted and names no bound", () => {
    const failure = managedRunFailureFromRecord(
      record({ lastRun: { ...failed("too-large"), setUncounted: true } }),
      undefined,
      NOW,
    );
    if (failure === undefined || failure.kind === "handed-off")
      throw new Error("expected the too-large alert");
    expect(failure.kind).toBe("too-large");
    expect(failure.title).toBe(
      "The values built from your file could not be counted",
    );
    expect(failure.message).toContain(
      "built from your input file could not be counted, so it was not sent",
    );
    expect(failure.message).toContain("Split your input into smaller files");
    expect(failure.message).not.toMatch(/WebRTC|MiB|too large/);
    expect(managedRunRetryable(failure)).toBe(false);
  });
});

describe("readManagedFailure: a rotation in flight across a crash", () => {
  const MARKED_AT = "2026-07-13T09:00:00.000Z";
  const missed: ManagedExchangeLastRun = { at: RUN_AT, outcome: "missed" };

  test("a no-show after an interrupted key exchange reads as a probable partial rotation", () => {
    expect(
      readManagedFailure(
        record({ lastRun: missed, rotationInFlightSince: MARKED_AT }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "partial-rotation", standing: false });
  });

  test("the partner, whose save cleared its own marker, reads its no-show as a no-show", () => {
    expect(
      readManagedFailure(record({ lastRun: missed }), undefined, NOW),
    ).toEqual({ tier: "missed", standing: false });
  });

  test("a marker set after the last stamp belongs to a run with no miss beside it yet", () => {
    expect(
      readManagedFailure(
        record({
          lastRun: missed,
          rotationInFlightSince: new Date(NOW).toISOString(),
        }),
        undefined,
        NOW,
      ).tier,
    ).toBe("missed");
  });

  test("a marker alone, with no run since, is not a reading", () => {
    expect(
      readManagedFailure(
        record({
          lastRun: { at: "2026-07-12T09:00:00.000Z", outcome: "succeeded" },
          rotationInFlightSince: MARKED_AT,
        }),
        undefined,
        NOW,
      ).tier,
    ).toBe("none");
  });

  test("a failed-closed handshake stays unexplained beside a marker", () => {
    expect(
      readManagedFailure(
        record({ lastRun: failed("auth"), rotationInFlightSince: MARKED_AT }),
        undefined,
        NOW,
      ).tier,
    ).toBe("unexplained");
  });

  test("a standing unexplained condition is not softened by a marker and a later no-show", () => {
    expect(
      readManagedFailure(
        record({
          lastRun: missed,
          rotationInFlightSince: MARKED_AT,
          standingCondition: { since: MARKED_AT, kind: "auth" },
        }),
        undefined,
        NOW,
      ),
    ).toEqual({ tier: "unexplained", standing: true });
  });
});
